import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { capturedStderr } from "#core/lib/actions/docker-error.ts";
import { SandboxError } from "./errors.ts";
import { retryBriefly } from "./retry-briefly.ts";
import { SANDBOX_SCRATCH_BASE, ensureOwnScratchBase } from "./sandbox/scratch-dir.ts";

type ExecLike = typeof execFileSync;

const REQUIREMENT =
  `filesystem_mode: ephemeral requires overlayfs support on ${SANDBOX_SCRATCH_BASE} -- an overlay ` +
  "mount's upperdir/workdir are placed there, and the kernel doesn't allow those to themselves " +
  "sit on an overlayfs filesystem. This commonly fails when the runner process is itself running " +
  "inside a container whose own root filesystem is overlayfs (e.g. many container-based " +
  "self-hosted runner setups), since that puts SANDBOX_SCRATCH_BASE on overlayfs too. Use " +
  "filesystem_mode: persistent instead, or run this action from a runner whose filesystem isn't " +
  "overlayfs-backed.";

const CLEANUP_REQUIREMENT =
  "The probe mount itself succeeded, so this runner does support overlayfs -- what failed is " +
  "removing the probe directory afterwards. That needs `sudo rm -rf`, because the kernel writes " +
  "root-owned overlayfs bookkeeping into workdir while the mount is live (see removeProbeDir), " +
  "and filesystem_mode: ephemeral's real cleanup discards its overlay work dirs exactly the same " +
  "way -- so a run would fail on this runner anyway, later and with less to go on. This is " +
  "usually a sudoers config scoped to specific commands rather than a blanket NOPASSWD:ALL, " +
  "which checkPasswordlessSudo's own `sudo -n true` probe cannot detect. Grant the runner user " +
  "passwordless sudo for `rm`, or use filesystem_mode: persistent instead.";

/**
 * Kept pure (takes the error, not execFileSync's raw output) so it's
 * unit-testable the same way as sudo-preflight.ts's describeSudoFailure.
 */
export function describeOverlayFailure(e: unknown): string {
  const captured = capturedStderr(e);
  return `overlayfs probe mount failed. ${REQUIREMENT}${captured ? ` (${captured})` : ""}`;
}

/** Pure, for the same reason describeOverlayFailure is. */
export function describeProbeCleanupFailure(dir: string, e: unknown): string {
  const captured = capturedStderr(e);
  return `Failed to remove the overlayfs probe directory ${dir}. ${CLEANUP_REQUIREMENT}${captured ? ` (${captured})` : ""}`;
}

/**
 * Removes the probe dir via sudo, not a plain rmSync: the probe mount
 * itself runs as root (sudo unshare ... mount -t overlay ...), and the
 * kernel's own overlayfs implementation writes bookkeeping content directly
 * into workdir while mounted (notably a "work/work" subdirectory used for
 * atomic rename during copy-up) -- content that stays on disk, root-owned
 * and not traversable by the unprivileged runner user, after the mount
 * itself is torn down when the `sudo unshare` child exits. A plain rmSync
 * here reliably fails with EACCES on any host where the probe mount
 * actually succeeded (confirmed in CI).
 *
 * The retry is insurance, not a mechanism anything here is known to hit --
 * unlike scratch-dir.ts's removeScratchDir, which lazily unmounts the very
 * directory it then deletes and so races a teardown the kernel defers.
 * `--propagation private` keeps this probe's mount out of the caller's
 * namespace entirely, and the namespace it did live in is gone by the time
 * the `sudo unshare` child is reaped, so there is no mount point left here
 * for the removal to contend with. It waits out any failure rather than
 * EBUSY alone, because a `sudo rm` that fails reports an exit status and no
 * errno, so nothing here can tell one cause from another anyway. What does
 * survive the retries is reported as OVERLAY_PROBE_CLEANUP_FAILED: in
 * practice that means this runner cannot `sudo rm` at all, which is what
 * filesystem_mode: ephemeral's own cleanup needs too.
 */
function removeProbeDir(dir: string, exec: ExecLike): void {
  retryBriefly(() =>
    exec("sudo", ["-n", "rm", "-rf", dir], { stdio: ["ignore", "ignore", "pipe"] }),
  );
}

export interface CheckOverlayfsSupportOptions {
  base?: string;
  exec?: ExecLike;
}

/**
 * Fails fast, before spinning up the proxy container, so a runner that can't
 * support filesystem_mode: ephemeral at all fails with a clear message rather
 * than a cryptic runc mount error deep inside runSandboxedCommand.
 *
 * The probe's throwaway lower/upper/work/merged dirs are created under
 * SANDBOX_SCRATCH_BASE itself -- the same filesystem createOverlayScratchDirs
 * will actually place the real upper/work dirs on -- not a generic mkdtemp
 * location (e.g. /tmp), which could be a different filesystem and so miss
 * the specific "upperdir/workdir can't themselves be on overlayfs" failure
 * this exists to catch (confirmed against a real kernel: an overlay mount
 * whose lowerdir is itself on overlayfs works fine, but the same is not
 * true for upperdir/workdir).
 *
 * `--propagation private` (same reasoning as run-isolated.sh's own use of
 * it) keeps the probe mount from ever becoming visible outside the
 * throwaway namespace it's created in, even transiently -- SANDBOX_SCRATCH_BASE
 * is generally a "shared" mount point, and without this the probe's overlay
 * mount could propagate back onto the real host namespace instead of
 * disappearing when the child process exits.
 *
 * Delegates base creation to ensureOwnScratchBase rather than mkdir'ing it
 * directly: a local mkdir here can only ever produce a mode/ownership that
 * function's own later validation (the one withScratchDir goes through) has
 * to reject, and `recursive: true` follows a pre-existing symlink at that
 * path instead of refusing it. Idempotent, so persistent-mode's own call to
 * it later is unaffected.
 */
export function checkOverlayfsSupport({
  base = SANDBOX_SCRATCH_BASE,
  exec = execFileSync,
}: CheckOverlayfsSupportOptions = {}): void {
  ensureOwnScratchBase(base);
  const probeDir = mkdtempSync(join(base, "overlay-probe-"));
  // Boxed rather than held as a bare `unknown`: `throw undefined` is legal,
  // so the box is what distinguishes "the probe failed" from its value.
  let probeFailure: { error: unknown } | null = null;
  try {
    probeOverlayMount(probeDir, exec);
  } catch (error) {
    probeFailure = { error };
  }

  // Deliberately not a `finally`: an exception thrown from one replaces
  // whatever the block was already throwing, so a cleanup that failed too
  // would erase the probe's own verdict -- REQUIREMENT, the reason this
  // check exists at all -- and leave the caller with a bare `rm` error.
  // The cleanup only gets to speak when the probe had nothing to say.
  try {
    removeProbeDir(probeDir, exec);
  } catch (e) {
    if (!probeFailure) {
      throw new SandboxError(
        describeProbeCleanupFailure(probeDir, e),
        "OVERLAY_PROBE_CLEANUP_FAILED",
      );
    }
  }

  if (probeFailure) {
    throw new SandboxError(describeOverlayFailure(probeFailure.error), "OVERLAYFS_UNSUPPORTED");
  }
}

function probeOverlayMount(probeDir: string, exec: ExecLike): void {
  const lower = join(probeDir, "lower");
  const upper = join(probeDir, "upper");
  const work = join(probeDir, "work");
  const merged = join(probeDir, "merged");
  for (const dir of [lower, upper, work, merged]) mkdirSync(dir);
  exec(
    "sudo",
    [
      "-n",
      "unshare",
      "--mount",
      "--propagation",
      "private",
      "--",
      "sh",
      "-c",
      `mount -t overlay overlay -o lowerdir=${lower},upperdir=${upper},workdir=${work} ${merged}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
  );
}
