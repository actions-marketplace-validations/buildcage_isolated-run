import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@actions/core";

import { resolveBuildcageImageRef } from "#core/lib/provenance/image-ref.ts";
import { verifyImageDigestOrThrow, type ResolvedImage } from "#core/lib/provenance/verify-image.ts";
import type { VerifyImageIdentity } from "#core/lib/provenance/verify-policy.ts";
import { createAnnotation } from "#core/lib/actions/annotation.ts";
import { logRules, withLogGroup } from "#core/lib/actions/log.ts";
import { errorMessage } from "#core/lib/errors.ts";
import { exitOnFatalError } from "#core/lib/actions/fatal.ts";
import { SandboxError } from "./lib/errors.ts";
import type { ProxyEngine } from "./lib/engine.ts";
import {
  readEngineInputs,
  readFailOnBlocked,
  readFilesystemInputs,
  readRuleInputs,
  readRunCommand,
  readStepLabel,
  splitWriteThroughInput,
  validateFilesystemInputs,
  type FilesystemMode,
} from "./lib/inputs.ts";
import { checkUrlAndTlsRuleSupport } from "./lib/engine-rule-support.ts";
import { buildComposeEnv } from "./lib/compose-env.ts";
import { checkPasswordlessSudo } from "./lib/sudo-preflight.ts";
import { checkOverlayfsSupport } from "./lib/overlayfs-preflight.ts";
import {
  determineOverlayRoots,
  formatFilesystemPlanLog,
  type OverlayRoot,
} from "./lib/sandbox/ephemeral-fs.ts";
import {
  resolveWriteThroughPaths,
  ensureWriteThroughTargetsExist,
  removeCreatedDirsIfEmpty,
  WriteThroughTargetMissingError,
  WriteThroughTargetUncreatableError,
  WRITE_THROUGH_ALL,
  type CreatedDir,
} from "./lib/sandbox/write-through.ts";
import { assertScratchBaseNotWritable } from "./lib/sandbox/paths.ts";
import { generateContainerName, getContainerNetns } from "./lib/container.ts";
import { deriveProjectName } from "#core/lib/docker/compose-project-name.ts";
import { runSandboxedCommand } from "./lib/sandbox/sandboxed-command.ts";
import { startSandboxProxy, stopSandboxProxy } from "./lib/proxy-lifecycle.ts";
import { uploadTrafficArtifact, wantsTrafficArtifact } from "./lib/traffic-artifact.ts";
import { fetchReport, readActionVersion, writeReportSummary } from "./lib/report.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultComposeFile = join(__dirname, "../docker/compose.action.yaml");

// Gates a local-image override used only by this repo's own CI/dev testing
// (the test_sandbox_* jobs in .github/workflows/test-e2e.yml, test_sandbox in
// test-integration.yml, and verify-image in docker-publish.yml, where the image
// is not signed yet), never by a consumer of a published action.
const LOCAL_IMAGE_OVERRIDE_ENABLED = process.env.BUILDCAGE_BUILD_TEST_HOOKS === "1";

/**
 * Verifies image provenance and resolves the digest-pinned image ref for
 * isolated-run's (buildkitd-less) proxy image.
 *
 * Untested by design: verifyImageDigestOrThrow and resolveBuildcageImageRef
 * are tested directly.
 */
/* v8 ignore start */
async function resolveVerifiedImage({
  actionRef,
  actionRepo,
  proxyEngine,
}: VerifyImageIdentity & { proxyEngine: ProxyEngine }): Promise<ResolvedImage> {
  const digest = await verifyImageDigestOrThrow({ actionRef, actionRepo, proxyEngine });
  console.log(
    `Image provenance verified for ref: ${JSON.stringify(actionRef)} (digest ${digest}).`,
  );
  return {
    imageRef: resolveBuildcageImageRef({ imageDigest: digest, actionRepository: actionRepo }),
    pullPolicy: "always",
  };
}

/**
 * Never sent to the container's ACL — used only for report-time annotation
 * of expected vs. unexpected blocked connections.
 */ /* v8 ignore stop */

export interface FilesystemPlan {
  /** filesystem_mode: ephemeral only -- already folded (determineOverlayRoots). [] in persistent mode. */
  overlayRoots: OverlayRoot[];
  /** Already resolved (resolveWriteThroughPaths) and pre-created
   *  (ensureWriteThroughTargetsExist), in either filesystem mode. */
  writeThroughPaths: string[];
  /** The directory segments pre-creating those paths actually created, for
   *  removeCreatedDirsIfEmpty to give back once the step is done. */
  createdDirs: CreatedDir[];
}

/** Test-only seam onto ensureWriteThroughTargetsExist/determineOverlayRoots's
 *  own filesystem/sudo dependencies -- see write-through.ts / ephemeral-fs.ts. */
export interface ResolveFilesystemPlanDeps {
  exists?: (path: string) => boolean;
  stat?: (path: string) => { uid: number; gid: number; mode: number };
  execFile?: (command: string, args: string[]) => void;
  deviceOf?: (path: string) => number;
}

/**
 * Resolves + pre-creates the write_through targets (write-through.ts) and, in
 * ephemeral mode, folds the overlay-root candidates down to what's actually
 * needed (ephemeral-fs.ts). Throws SandboxError, never those modules' own
 * error classes directly, so a caller doesn't need to know about those.
 */
export function resolveFilesystemPlan(
  filesystemMode: FilesystemMode,
  writeThroughInput: string,
  env: NodeJS.ProcessEnv,
  deps: ResolveFilesystemPlanDeps = {},
): FilesystemPlan {
  let writeThroughPaths: string[];
  try {
    writeThroughPaths = resolveWriteThroughPaths(writeThroughInput, env);
  } catch (e) {
    throw new SandboxError(
      `Invalid write_through: ${errorMessage(e)}`,
      "INVALID_WRITE_THROUGH_PATH",
    );
  }

  // The authoritative call, ahead of the early return below: reaching that
  // with the sentinel under ephemeral would leave the run with no overlay.
  validateFilesystemInputs(filesystemMode, writeThroughPaths);

  // `/` drops the read-only restriction wholesale (persistent only, see
  // validateFilesystemInputs), so no path is bind-mounted individually --
  // nothing to create, and buildOciConfig skips the scratch-base guard for
  // the same reason.
  if (writeThroughPaths.includes(WRITE_THROUGH_ALL)) {
    return { overlayRoots: [], writeThroughPaths, createdDirs: [] };
  }

  // Before anything is created: buildOciConfig rejects a path overlapping the
  // sandbox's own scratch base outright, so checking it here keeps a doomed
  // input from leaving freshly-created directories behind. Its own check
  // stays as the authoritative one -- this is the early copy.
  try {
    assertScratchBaseNotWritable(writeThroughPaths);
  } catch (e) {
    throw new SandboxError(errorMessage(e), "FILESYSTEM_INPUT_CONFLICT");
  }

  let createdDirs: CreatedDir[];
  try {
    createdDirs = ensureWriteThroughTargetsExist(writeThroughPaths, env, deps);
  } catch (e) {
    if (e instanceof WriteThroughTargetMissingError) {
      throw new SandboxError(e.message, "WRITE_THROUGH_TARGET_MISSING");
    }
    if (e instanceof WriteThroughTargetUncreatableError) {
      throw new SandboxError(e.message, "WRITE_THROUGH_TARGET_UNCREATABLE");
    }
    throw new SandboxError(
      `Invalid write_through: ${errorMessage(e)}`,
      "INVALID_WRITE_THROUGH_PATH",
    );
  }

  if (filesystemMode !== "ephemeral") return { overlayRoots: [], writeThroughPaths, createdDirs };

  // Separate try/catch from the above: this only touches the fixed
  // $HOME/$RUNNER_TEMP//tmp/$GITHUB_WORKSPACE candidates, not write_through's
  // own input, so a failure here (e.g. a permissions error reading one of
  // those paths) must not be mislabeled as a write_through syntax problem.
  try {
    const overlayCandidates = [env.HOME, env.RUNNER_TEMP, "/tmp", env.GITHUB_WORKSPACE].filter(
      (p): p is string => Boolean(p),
    );
    const overlayRoots = determineOverlayRoots(overlayCandidates, writeThroughPaths, deps);
    return { overlayRoots, writeThroughPaths, createdDirs };
  } catch (e) {
    throw new SandboxError(
      `Failed to determine filesystem_mode: ephemeral's overlay roots: ${errorMessage(e)}`,
      "FILESYSTEM_PLAN_FAILED",
    );
  }
}

// Untested by design, down to the end of the file: every step main() calls is
// tested directly, and what it adds is the docker/runc invocations themselves.
/* v8 ignore start */
async function main(): Promise<void> {
  const env = process.env;
  // Empty (not `??`-catchable) for local-path `uses: ./` invocations.
  const actionRef = env.GITHUB_ACTION_REF || "v1";
  const actionRepo = env.GITHUB_ACTION_REPOSITORY || "buildcage/isolated-run";

  const runInput = readRunCommand();

  const { proxyEngine } = readEngineInputs();
  console.log(`Proxy engine: ${proxyEngine}`);

  const { filesystemMode, writeThroughInput } = readFilesystemInputs();

  // Cheap, pure input check first, so a plain mistake (e.g. write_through: /
  // under filesystem_mode: ephemeral) is rejected immediately rather than only
  // after the privileged preflight checks below have already run
  // (checkOverlayfsSupport in particular performs a real sudo/unshare/mount
  // probe). resolveFilesystemPlan re-checks the resolved paths.
  validateFilesystemInputs(filesystemMode, splitWriteThroughInput(writeThroughInput));

  // Fail fast — before image verification or starting the proxy container —
  // if the runner can't support the isolation setup at all. Deliberately
  // ahead of resolveFilesystemPlan below: ensureWriteThroughTargetsExist (part
  // of that call) itself shells out to sudo, and doing that before this check
  // risks a confusing WRITE_THROUGH_TARGET_UNCREATABLE in place of this more
  // specific, better-diagnosed error.
  checkPasswordlessSudo();
  if (filesystemMode === "ephemeral") checkOverlayfsSupport();

  // Same gate as writeReportSummary() below — suppresses annotations when
  // this script isn't running as the real action.
  const annotation = createAnnotation(Boolean(env.GITHUB_STEP_SUMMARY));

  // Resolved/pre-created here (not inside runSandboxedCommand) so a bad
  // write_through entry, or a target that can't be created, fails before the
  // proxy container ever starts -- same reasoning as checkPasswordlessSudo
  // above.
  const { overlayRoots, writeThroughPaths, createdDirs } = resolveFilesystemPlan(
    filesystemMode,
    writeThroughInput,
    env,
  );
  if (filesystemMode === "ephemeral") {
    for (const line of formatFilesystemPlanLog(
      filesystemMode,
      overlayRoots.map((r) => r.path),
      writeThroughPaths,
    )) {
      core.info(line);
    }
  }

  try {
    const localOverride = LOCAL_IMAGE_OVERRIDE_ENABLED
      ? (await import("./core/lib/provenance/local-image-override.ts")).readLocalImageOverride(env)
      : null;
    if (localOverride) {
      console.log(
        `BUILDCAGE_LOCAL_IMAGE_REF is set (${JSON.stringify(localOverride.imageRef)}) — ` +
          `skipping image provenance verification entirely. This bypass exists only for ` +
          `buildcage's own CI self-tests and local development.`,
      );
    }
    const { imageRef, pullPolicy } =
      localOverride ?? (await resolveVerifiedImage({ actionRef, actionRepo, proxyEngine }));
    console.log(`buildcage: proxy image: ${imageRef}`);
    const composeFile = localOverride?.composeFile ?? defaultComposeFile;

    const { proxyMode, httpsRules, httpRules, ipRules, urlRules, tlsRules, knownBlockedRules } =
      readRuleInputs();
    checkUrlAndTlsRuleSupport({ proxyEngine, proxyMode, urlRules, tlsRules }, (message) =>
      annotation.warning(message),
    );

    withLogGroup("buildcage: Configured ACL Rules", () => {
      logRules("HTTPS", httpsRules);
      logRules("HTTP", httpRules);
      logRules("IP", ipRules);
      logRules("URL", urlRules);
      logRules("TLS", tlsRules);
      logRules("Known-blocked (informational only, not sent to proxy ACL)", knownBlockedRules);
    });

    // Each `run` step gets its own throwaway proxy container — start, run
    // the isolated command, report, and stop, all within this one step —
    // rather than sharing one across steps in the same job.
    const containerName = generateContainerName();
    const projectName = deriveProjectName(containerName);
    // Recorded so post.ts can still clean up if this run is killed outright
    // before reaching its own finally block below.
    if (env.GITHUB_STATE) {
      core.saveState("container_name", containerName);
      if (filesystemMode === "ephemeral") {
        core.saveState("ephemeral_overlay_roots", JSON.stringify(overlayRoots.map((r) => r.path)));
      }
    }

    const composeEnv = buildComposeEnv(
      {
        containerName,
        proxyMode,
        proxyEngine,
        imageRef,
        httpsRules: httpsRules,
        httpRules: httpRules,
        ipRules: ipRules,
        urlRules,
        tlsRules,
      },
      env,
    );

    await startSandboxProxy({ composeFile, projectName, containerName, pullPolicy, composeEnv });

    let exitCode = 1;
    try {
      const proxyNetns = getContainerNetns(containerName);
      if (proxyNetns === null) {
        throw new SandboxError(
          `Sandbox proxy container ${containerName} is not running.`,
          "PROXY_NOT_RUNNING",
        );
      }

      exitCode = runSandboxedCommand({
        containerName,
        proxyNetns,
        runInput,
        writeThroughPaths,
        env,
        proxyEngine,
        filesystemMode,
        overlayRoots,
      });
    } finally {
      try {
        const report = await fetchReport(
          containerName,
          {
            mode: proxyMode,
            allowedHttpsRules: httpsRules,
            allowedHttpRules: httpRules,
            allowedIpRules: ipRules,
            allowedTlsRules: tlsRules,
            knownBlockedRules,
          },
          proxyEngine,
        );
        const failOnBlocked = readFailOnBlocked();
        const wantsArtifact = wantsTrafficArtifact();
        await writeReportSummary(
          report,
          annotation,
          {
            actionRepo,
            actionRef,
            runCommand: runInput,
            actionVersion: readActionVersion(containerName, proxyEngine),
            stepLabel: readStepLabel(),
            failOnBlocked,
          },
          wantsArtifact && report.engine === "inspect",
        );
        if (wantsArtifact) {
          await uploadTrafficArtifact(report, containerName, annotation);
        }
      } catch (e) {
        annotation.warning(`Failed to fetch sandbox report: ${errorMessage(e)}`);
      }
      await stopSandboxProxy({ composeFile, projectName, composeEnv, annotation });
    }

    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } finally {
    // Give back the directories pre-creating write_through targets made, if
    // the command left them empty. Covers every way out of the step, not just
    // the ones that reach the proxy teardown -- image verification or a rule
    // typo can throw after they were created. Deliberately not mirrored in
    // post.ts: the only way to hand this list to the post step is GITHUB_STATE,
    // which the sandboxed command can rewrite (see post-state.ts), and that
    // would turn the cleanup into a way to rmdir any empty directory belonging
    // to whoever each entry claimed as its owner. A hard kill therefore leaves
    // an empty directory behind, which the next run reuses.
    try {
      removeCreatedDirsIfEmpty(createdDirs);
    } catch (e) {
      annotation.warning(`Failed to remove created write_through directories: ${errorMessage(e)}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(exitOnFatalError("sandbox"));
}
/* v8 ignore stop */
