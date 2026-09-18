import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as core from "@actions/core";

import { errorMessage } from "#core/lib/errors.ts";
import { SandboxError } from "../errors.ts";
import type { ProxyEngine } from "../engine.ts";
import type { FilesystemMode } from "../inputs.ts";
import { createOverlayScratchDirs, type OverlayRoot } from "./ephemeral-fs.ts";
import { extractRuncBootstrap } from "./runc-bootstrap.ts";
import { extractCaCert, writeCaTrustFiles } from "./ca-trust.ts";
import { resolveSandboxGid } from "./identity.ts";
import { listHostMounts } from "./mountinfo.ts";
import { writeRunScript, writeResolvConf, buildOciConfig, writeOciConfig } from "./oci-config.ts";
import { buildEnvBlob, resolveSandboxEnv, writeEnvLoader } from "./env-loader.ts";
import { runIsolated } from "./run.ts";
import { withScratchDir } from "./scratch-dir.ts";

/**
 * The steps this function sequences. Declared rather than imported straight
 * into the body so a test can watch the order and the arguments without
 * standing in for ten modules at once; each one is tested in its own file.
 */
export interface RunSandboxedCommandDeps {
  withScratchDir: typeof withScratchDir;
  extractRuncBootstrap: typeof extractRuncBootstrap;
  extractCaCert: typeof extractCaCert;
  writeCaTrustFiles: typeof writeCaTrustFiles;
  createOverlayScratchDirs: typeof createOverlayScratchDirs;
  writeResolvConf: typeof writeResolvConf;
  writeRunScript: typeof writeRunScript;
  writeEnvLoader: typeof writeEnvLoader;
  listHostMounts: typeof listHostMounts;
  resolveSandboxGid: typeof resolveSandboxGid;
  buildOciConfig: typeof buildOciConfig;
  writeOciConfig: typeof writeOciConfig;
  resolveSandboxEnv: typeof resolveSandboxEnv;
  buildEnvBlob: typeof buildEnvBlob;
  runIsolated: typeof runIsolated;
  mkdir: (path: string, options: { mode: number }) => void;
  info: (message: string) => void;
}

const realDeps: RunSandboxedCommandDeps = {
  withScratchDir,
  extractRuncBootstrap,
  extractCaCert,
  writeCaTrustFiles,
  createOverlayScratchDirs,
  writeResolvConf,
  writeRunScript,
  writeEnvLoader,
  listHostMounts,
  resolveSandboxGid,
  buildOciConfig,
  writeOciConfig,
  resolveSandboxEnv,
  buildEnvBlob,
  runIsolated,
  mkdir: mkdirSync,
  info: core.info,
};

export interface RunSandboxedCommandOptions {
  containerName: string;
  proxyNetns: string;
  runInput: string;
  /** Already resolved (resolveWriteThroughPaths) and pre-created
   *  (ensureWriteThroughTargetsExist) by main() before this runs. Opens holes
   *  in the read-only set in persistent mode, and in the overlay in ephemeral
   *  mode -- see buildOciConfig. */
  writeThroughPaths: string[];
  env: NodeJS.ProcessEnv;
  proxyEngine: ProxyEngine;
  filesystemMode: FilesystemMode;
  /** filesystem_mode: ephemeral only -- already folded (determineOverlayRoots), not raw candidates. */
  overlayRoots: OverlayRoot[];
}

/**
 * Extracts runc/gen-seccomp-profile from the proxy container, builds the
 * OCI bundle, and runs the user's command inside it via run-isolated.sh.
 * Returns the isolated command's exit code.
 */
export function runSandboxedCommand(
  {
    containerName,
    proxyNetns,
    runInput,
    writeThroughPaths,
    env,
    proxyEngine,
    filesystemMode,
    overlayRoots,
  }: RunSandboxedCommandOptions,
  overrides: Partial<RunSandboxedCommandDeps> = {},
): number {
  const {
    withScratchDir,
    extractRuncBootstrap,
    extractCaCert,
    writeCaTrustFiles,
    createOverlayScratchDirs,
    writeResolvConf,
    writeRunScript,
    writeEnvLoader,
    listHostMounts,
    resolveSandboxGid,
    buildOciConfig,
    writeOciConfig,
    resolveSandboxEnv,
    buildEnvBlob,
    runIsolated,
    mkdir,
    info,
  } = { ...realDeps, ...overrides };
  // Fixed addressing for the direct veth link to the proxy's buildcage0 interface.
  const gateway = "172.20.0.1";
  const dns = "172.20.0.1";
  const targetIp = "172.20.0.101";

  return withScratchDir(
    (dir) => {
      let runcPath, seccompProfile, baseSpec;
      try {
        // Extracted into this run's own scratch dir — see extractRuncBootstrap.
        // Run natively on the runner host (not `docker exec`, which would
        // resolve against the container's kernel/arch instead of the real
        // one) — see gen-seccomp-profile/main.go.
        ({ runcPath, seccompProfile, baseSpec } = extractRuncBootstrap({
          containerName,
          destDir: dir,
        }));
      } catch (e) {
        throw new SandboxError(
          `Failed to extract runc/gen-seccomp-profile from the proxy image: ${errorMessage(e)}`,
          "RUNC_EXTRACT_FAILED",
        );
      }

      // inspect only: the proxy terminates TLS, so the sandboxed process has to
      // be made to trust its CA -- see ca-trust.ts for why this is a mount, not
      // a write into the sandbox's (real, host) rootfs.
      let caTrust;
      if (proxyEngine === "inspect") {
        try {
          const caCertPath = extractCaCert(containerName, dir);
          caTrust = writeCaTrustFiles(caCertPath, dir);
        } catch (e) {
          throw new SandboxError(
            `Failed to extract the proxy's CA from the proxy image: ${errorMessage(e)}`,
            "CA_EXTRACT_FAILED",
          );
        }
      }

      const workdir = env.GITHUB_WORKSPACE || "";
      const home = env.HOME || "";
      // Distinct from the Docker container name/Compose project name
      // (different ID namespace — `ip netns`/runc container IDs), but
      // derived from it to keep `ip netns`/`docker ps` output correlated
      // per step, same reasoning as deriveProjectName.
      const netnsName = containerName.replace(/^buildcage-proxy-/, "buildcage-sandbox-");
      const rootfsBindDir = join(dir, "rootfs");

      let config;
      try {
        // Side-effecting (mkdirSync); must happen before run-isolated.sh's
        // `mount --rbind /` and before runIsolated() below, same timing
        // constraint as ensureAllowWriteTargetsExist (already run in main()
        // by this point) -- see ephemeral-fs.ts.
        const overlayScratchPaths =
          filesystemMode === "ephemeral" ? createOverlayScratchDirs(dir, overlayRoots) : [];
        const resolvConfPath = writeResolvConf(dns, dir);
        // The only part of the scratch dir buildOciConfig leaves visible to
        // the sandbox, so nothing it doesn't have to exec goes in here.
        const execDir = join(dir, "exec");
        mkdir(execDir, { mode: 0o700 });
        const scriptPath = writeRunScript(runInput, execDir);
        const envLoaderPath = writeEnvLoader(execDir);
        // Real host mount table, read now (before run-isolated.sh's `mount
        // --rbind /` duplicates it into rootfsBindDir) so buildOciConfig can
        // force every real submount read-only individually -- root.readonly
        // alone only covers the top-level rootfs mount (see
        // computeReadonlyHostMounts).
        const hostMounts = listHostMounts();
        // Only supplementary groups are dropped for the sandbox (see
        // buildOciConfig); this substitutes the primary GID too, if it's a
        // privileged group. See identity.ts.
        const { gid, substitutedFrom } = resolveSandboxGid(process.getgid!(), env);
        if (substitutedFrom !== undefined) {
          info(
            `buildcage: sandbox GID substituted (${substitutedFrom} -> ${gid}) -- the runner's ` +
              "primary group grants container/VM runtime access",
          );
        }
        config = buildOciConfig(baseSpec, {
          identity: { uid: process.getuid!(), gid },
          writable: {
            workdir,
            home,
            // Standard writable runner scratch; not always under $HOME on
            // self-hosted runners, so covered explicitly (see buildOciConfig).
            runnerTemp: env.RUNNER_TEMP || "",
            writablePaths: writeThroughPaths,
          },
          ephemeral:
            filesystemMode === "ephemeral"
              ? { overlayRoots: overlayScratchPaths, allowWrite: writeThroughPaths }
              : undefined,
          runtime: {
            netnsPath: `/var/run/netns/${netnsName}`,
            rootfsBindDir,
            resolvConfPath,
            seccompProfile,
            execDir,
            envLoaderPath,
            scriptPath,
            hostMounts,
          },
          env,
          caTrust,
        });
      } catch (e) {
        throw new SandboxError(
          `Failed to build the sandbox's OCI bundle: ${errorMessage(e)}`,
          "OCI_CONFIG_BUILD_FAILED",
        );
      }
      writeOciConfig(config, dir);

      return runIsolated({
        envBlob: buildEnvBlob(resolveSandboxEnv(env, caTrust)),
        runcPath,
        proxyNetns,
        bundleDir: dir,
        containerId: containerName,
        netnsName,
        rootfsBindDir,
        gateway,
        dns,
        targetIp,
      });
    },
    containerName,
    filesystemMode === "ephemeral" ? overlayRoots.map((r) => r.path) : undefined,
  );
}
