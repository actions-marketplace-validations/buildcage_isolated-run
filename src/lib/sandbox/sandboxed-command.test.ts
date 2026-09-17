import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  runSandboxedCommand,
  type RunSandboxedCommandDeps,
  type RunSandboxedCommandOptions,
} from "./sandboxed-command.ts";
import { SandboxError } from "../errors.ts";

// Every collaborator is tested in its own file; what is left to check here is
// the order they run in, what runSandboxedCommand hands each one, and which
// SandboxError each failure turns into.
const mocks = {
  withScratchDir: vi.fn(),
  extractRuncBootstrap: vi.fn(),
  extractCaCert: vi.fn(),
  writeCaTrustFiles: vi.fn(),
  createOverlayScratchDirs: vi.fn(),
  writeRunScript: vi.fn(),
  writeResolvConf: vi.fn(),
  buildOciConfig: vi.fn(),
  writeOciConfig: vi.fn(),
  buildEnvBlob: vi.fn(),
  resolveSandboxEnv: vi.fn(),
  writeEnvLoader: vi.fn(),
  resolveSandboxGid: vi.fn(),
  listHostMounts: vi.fn(),
  runIsolated: vi.fn(),
  mkdir: vi.fn(),
  info: vi.fn(),
};

// A bag of doubles, not a partially-typed stand-in: every step is replaced, so
// the cast says what the shape already is.
const deps = mocks as unknown as RunSandboxedCommandDeps;

const CONTAINER = "buildcage-proxy-deadbeef";
const SCRATCH = "/var/tmp/buildcage-1001/buildcage-proxy-deadbeef";

const BOOTSTRAP = {
  runcPath: `${SCRATCH}/runc`,
  seccompProfile: { defaultAction: "SCMP_ACT_ERRNO" },
  baseSpec: { mounts: [], linux: { namespaces: [] }, process: {} },
};

function options(overrides: Partial<RunSandboxedCommandOptions> = {}): RunSandboxedCommandOptions {
  return {
    containerName: CONTAINER,
    proxyNetns: "/var/run/docker/netns/abc123",
    runInput: "echo hello",
    writeThroughPaths: [],
    env: { GITHUB_WORKSPACE: "/home/runner/work/repo/repo", HOME: "/home/runner" },
    proxyEngine: "universal",
    filesystemMode: "persistent",
    overlayRoots: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  // withScratchDir's own behavior is tested in scratch-dir.test.ts; here it
  // only has to hand the body a directory.
  mocks.withScratchDir.mockImplementation((fn: (dir: string) => unknown) => fn(SCRATCH));
  mocks.extractRuncBootstrap.mockReturnValue(BOOTSTRAP);
  mocks.extractCaCert.mockReturnValue(`${SCRATCH}/ca.crt`);
  mocks.writeCaTrustFiles.mockReturnValue({ bundlePath: `${SCRATCH}/ca-bundle.crt` });
  mocks.createOverlayScratchDirs.mockReturnValue([]);
  mocks.writeResolvConf.mockReturnValue(`${SCRATCH}/resolv.conf`);
  mocks.writeRunScript.mockReturnValue(`${SCRATCH}/exec/run.sh`);
  mocks.writeEnvLoader.mockReturnValue(`${SCRATCH}/exec/env-loader.sh`);
  mocks.listHostMounts.mockReturnValue([]);
  mocks.resolveSandboxGid.mockReturnValue({ gid: 1001, substitutedFrom: undefined });
  mocks.buildOciConfig.mockReturnValue({ process: {} });
  mocks.resolveSandboxEnv.mockReturnValue({ PATH: "/usr/bin" });
  mocks.buildEnvBlob.mockReturnValue(Buffer.from(""));
  mocks.runIsolated.mockReturnValue(0);
});

describe("runSandboxedCommand", () => {
  it("returns the isolated command's own exit code", () => {
    mocks.runIsolated.mockReturnValue(42);

    expect(runSandboxedCommand(options(), deps)).toBe(42);
  });

  it("writes the bundle before running it, into the scratch dir it was given", () => {
    runSandboxedCommand(options(), deps);

    expect(mocks.writeOciConfig).toHaveBeenCalledWith({ process: {} }, SCRATCH);
    expect(mocks.writeOciConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runIsolated.mock.invocationCallOrder[0],
    );
  });

  // The netns is a different ID namespace from Docker's, but derived from the
  // container name so `ip netns` and `docker ps` stay correlated per step.
  it("names the sandbox netns after the proxy container", () => {
    runSandboxedCommand(options(), deps);

    expect(mocks.runIsolated.mock.calls[0][0]).toMatchObject({
      netnsName: "buildcage-sandbox-deadbeef",
      containerId: CONTAINER,
      rootfsBindDir: `${SCRATCH}/rootfs`,
      runcPath: BOOTSTRAP.runcPath,
    });
    expect(mocks.buildOciConfig.mock.calls[0][1].runtime.netnsPath).toBe(
      "/var/run/netns/buildcage-sandbox-deadbeef",
    );
  });

  // inspect terminates TLS, so the sandboxed process has to be made to trust
  // the proxy's CA; no other engine has one to trust.
  it("trusts the proxy's CA under the inspect engine", () => {
    runSandboxedCommand(options({ proxyEngine: "inspect" }), deps);

    expect(mocks.extractCaCert).toHaveBeenCalledWith(CONTAINER, SCRATCH);
    expect(mocks.buildOciConfig.mock.calls[0][1].caTrust).toStrictEqual({
      bundlePath: `${SCRATCH}/ca-bundle.crt`,
    });
  });

  it("extracts no CA under an engine that does not terminate TLS", () => {
    runSandboxedCommand(options(), deps);

    expect(mocks.extractCaCert).not.toHaveBeenCalled();
    expect(mocks.buildOciConfig.mock.calls[0][1].caTrust).toBeUndefined();
  });

  it("builds the overlay only in ephemeral mode, from the already-folded roots", () => {
    const overlayRoots = [{ path: "/usr", fsType: "ext4" }];
    mocks.createOverlayScratchDirs.mockReturnValue([{ path: "/usr", upper: `${SCRATCH}/upper0` }]);

    runSandboxedCommand(
      options({ filesystemMode: "ephemeral", overlayRoots, writeThroughPaths: ["/opt/cache"] }),
      deps,
    );

    expect(mocks.createOverlayScratchDirs).toHaveBeenCalledWith(SCRATCH, overlayRoots);
    expect(mocks.buildOciConfig.mock.calls[0][1].ephemeral).toStrictEqual({
      overlayRoots: [{ path: "/usr", upper: `${SCRATCH}/upper0` }],
      allowWrite: ["/opt/cache"],
    });
    // The scratch dir has to be told which roots it discarded writes for.
    expect(mocks.withScratchDir.mock.calls[0][2]).toStrictEqual(["/usr"]);
  });

  it("leaves persistent mode with no overlay at all", () => {
    runSandboxedCommand(options(), deps);

    expect(mocks.createOverlayScratchDirs).not.toHaveBeenCalled();
    expect(mocks.buildOciConfig.mock.calls[0][1].ephemeral).toBeUndefined();
    expect(mocks.withScratchDir.mock.calls[0][2]).toBeUndefined();
  });

  // Every one of these is set by a real runner, but this action is also driven
  // directly by this repo's own integration scripts.
  it("leaves the writable paths empty when the runner set none of them", () => {
    runSandboxedCommand(options({ env: {} }), deps);

    expect(mocks.buildOciConfig.mock.calls[0][1].writable).toStrictEqual({
      workdir: "",
      home: "",
      runnerTemp: "",
      writablePaths: [],
    });
  });

  it("says so when the runner's primary group forced a GID substitution", () => {
    mocks.resolveSandboxGid.mockReturnValue({ gid: 65534, substitutedFrom: 118 });

    runSandboxedCommand(options(), deps);

    expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining("(118 -> 65534)"));
    expect(mocks.buildOciConfig.mock.calls[0][1].identity.gid).toBe(65534);
  });

  it.each([
    ["extractRuncBootstrap", () => mocks.extractRuncBootstrap, "RUNC_EXTRACT_FAILED", {}],
    ["extractCaCert", () => mocks.extractCaCert, "CA_EXTRACT_FAILED", { proxyEngine: "inspect" }],
    ["buildOciConfig", () => mocks.buildOciConfig, "OCI_CONFIG_BUILD_FAILED", {}],
  ])("turns a %s failure into its own SandboxError", (_name, target, code, overrides) => {
    target().mockImplementation(() => {
      throw new Error("boom");
    });

    const error = (() => {
      try {
        runSandboxedCommand(options(overrides as Partial<RunSandboxedCommandOptions>), deps);
      } catch (e) {
        return e as SandboxError;
      }
    })();

    expect(error).toBeInstanceOf(SandboxError);
    expect(error!.code).toBe(code);
    expect(error!.message).toContain("boom");
  });
});
