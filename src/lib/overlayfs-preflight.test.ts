import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync, rmSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkOverlayfsSupport,
  describeOverlayFailure,
  type CheckOverlayfsSupportOptions,
} from "./overlayfs-preflight.ts";
import { SandboxError } from "./errors.ts";

describe("describeOverlayFailure", () => {
  it("mentions SANDBOX_SCRATCH_BASE and the persistent-mode fallback", () => {
    const message = describeOverlayFailure(new Error("boom"));
    expect(message).toMatch(/\/var\/tmp\/buildcage/);
    expect(message).toMatch(/filesystem_mode: persistent/);
  });

  it("appends captured stderr when the error carries one", () => {
    const message = describeOverlayFailure({ stderr: "mount: invalid argument\n" });
    expect(message).toContain("mount: invalid argument");
  });

  it("omits the parenthetical when there is no stderr to show", () => {
    const message = describeOverlayFailure(new Error("boom"));
    expect(message).not.toMatch(/\(\s*\)$/);
  });

  it("handles a non-object thrown value without crashing", () => {
    expect(() => describeOverlayFailure("some string")).not.toThrow();
  });
});

/** execFileSync has a wider overload set than these stubs need to model. */
const asExec = (fn: unknown) => fn as NonNullable<CheckOverlayfsSupportOptions["exec"]>;

describe("checkOverlayfsSupport", () => {
  let base: string;

  const freshBasePath = () =>
    join(tmpdir(), `buildcage-overlay-preflight-test-${Math.random().toString(36).slice(2)}`);

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(`${base}-target`, { recursive: true, force: true });
  });

  it("rejects a base pre-created at 0755 without ever running the probe mount", () => {
    base = freshBasePath();
    mkdirSync(base, { mode: 0o755 });
    const exec = vi.fn();
    expect(() => checkOverlayfsSupport({ base, exec })).toThrow(/Another user may have created it/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects a base that is a symlink, the same as ensureOwnScratchBase does", () => {
    base = freshBasePath();
    mkdirSync(`${base}-target`, { mode: 0o700 });
    symlinkSync(`${base}-target`, base);
    const exec = vi.fn();
    expect(() => checkOverlayfsSupport({ base, exec })).toThrow(/Another user may have created it/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("creates a missing base as 0700 before probing (the mount itself stubbed out)", () => {
    base = freshBasePath();
    const exec = vi.fn();
    checkOverlayfsSupport({ base, exec });
    const st = statSync(base);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
    expect(exec).toHaveBeenCalledTimes(2); // the probe mount, then removeProbeDir's cleanup
  });

  it("reports a failed probe mount as OVERLAYFS_UNSUPPORTED", () => {
    base = freshBasePath();
    const exec = vi.fn((_cmd: string, args: readonly string[]) => {
      if (args.includes("unshare")) {
        throw Object.assign(new Error("Command failed"), {
          stderr: "mount: wrong fs type, bad option, bad superblock",
        });
      }
      return "";
    });

    try {
      checkOverlayfsSupport({ base, exec: asExec(exec) });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxError);
      expect((err as SandboxError).code).toBe("OVERLAYFS_UNSUPPORTED");
      expect((err as Error).message).toContain("bad superblock");
    }
  });

  // The probe dir is created by the root-owned mount, so its cleanup is
  // privileged too and waits out the same bounded window removeScratchDir does
  // -- on any failure, since `sudo rm` reports no errno to narrow it by.
  it("retries the probe-dir cleanup and succeeds on a later attempt", () => {
    base = freshBasePath();
    let cleanupAttempts = 0;
    const exec = vi.fn((_cmd: string, args: readonly string[]) => {
      if (args.includes("rm")) {
        cleanupAttempts++;
        if (cleanupAttempts < 3) throw new Error("device or resource busy");
      }
      return "";
    });

    expect(() => checkOverlayfsSupport({ base, exec: asExec(exec) })).not.toThrow();
    expect(cleanupAttempts).toBe(3);
  });

  it("gives up on the probe-dir cleanup after the last attempt", () => {
    base = freshBasePath();
    const exec = vi.fn((_cmd: string, args: readonly string[]) => {
      if (args.includes("rm")) throw new Error("device or resource busy");
      return "";
    });

    expect(() => checkOverlayfsSupport({ base, exec: asExec(exec) })).toThrow(
      /device or resource busy/,
    );
  });
});
