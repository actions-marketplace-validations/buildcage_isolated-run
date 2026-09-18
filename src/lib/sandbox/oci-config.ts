import type { OciSpec, BuiltOciSpec, HostMount } from "./types.ts";
import { resolveProtectedPaths } from "./oci-protected-paths.ts";
import {
  ephemeralLayers,
  freshMountDestinationsFrom,
  persistentLayers,
  scratchBaseLayers,
  withHostShmSize,
  writableDirsOf,
  RESOLV_CONF_DESTINATION,
  type OverlayDirs,
} from "./oci-mounts.ts";
import { realHostProbes, type HostProbes, type NofileLimit } from "./host-probes.ts";
import { caTrustAdditions, type CaTrustFiles } from "./ca-trust.ts";
/** Linux-level identity the sandboxed process runs as. */
export interface SandboxIdentity {
  uid: number;
  gid: number;
}

/** The directories kept writable on top of the read-only root; see the
 *  writableDirs computation below for how these combine. */
export interface WritablePolicy {
  workdir?: string;
  home?: string;
  runnerTemp?: string;
  writablePaths?: string[];
}

/** How this OCI config wires into run-isolated.sh's own setup (the netns it
 *  already created, the rootfs bind-mount it will do, etc). */
export interface SandboxRuntimeWiring {
  netnsPath: string;
  rootfsBindDir: string;
  resolvConfPath: string;
  seccompProfile: unknown;
  /** The `exec/` subdirectory of this run's scratch dir: the only part of it
   *  the sandbox can see. Holds these two paths and nothing else. */
  execDir: string;
  envLoaderPath: string;
  scriptPath: string;
  hostMounts?: HostMount[];
}

/** `filesystem_mode: ephemeral` only. Already fully resolved/folded by
 *  ephemeral-fs.ts and main.ts before this is called -- buildOciConfig does
 *  no path resolution of its own here, only mount assembly and ordering. */
export interface EphemeralPolicy {
  overlayRoots: OverlayDirs[];
  allowWrite: string[];
}

export interface BuildOciConfigOptions {
  identity: SandboxIdentity;
  /** Always used for `process.cwd` (workdir) regardless of mode. In ephemeral
   *  mode the write_through paths are consumed as `ephemeral.allowWrite`
   *  instead, so `writablePaths` is read only when `ephemeral` is absent --
   *  the `!ephemeral` half of `disableReadonly` below is what enforces that,
   *  and dropping it would let `write_through: /` disable the read-only root
   *  in ephemeral mode too. */
  writable: WritablePolicy;
  /** Present iff `filesystem_mode: ephemeral`. Carries the same write_through
   *  paths as `writable.writablePaths` -- one input, two mount strategies. */
  ephemeral?: EphemeralPolicy;
  runtime: SandboxRuntimeWiring;
  env: NodeJS.ProcessEnv;
  /** inspect engine only: the proxy's CA, mounted in rather than written to
   *  the real host filesystem -- see ca-trust.ts. Omitted entirely for the
   *  universal engine, which never terminates TLS and so has no CA to
   *  distribute. */
  caTrust?: CaTrustFiles;
}

/**
 * Build the final OCI Runtime Spec (config.json) for the isolated command,
 * starting from runc's own `baseSpec` (see generateBaseOciSpec) and
 * overriding only what this sandbox needs to control:
 *
 * - root: a bind-mounted copy of the host's own `/` (rootfsBindDir, set up
 *   by run-isolated.sh before invoking runc — pivot_root can't target `/`
 *   itself), made read-only via `root.readonly` plus an explicit
 *   `linux.readonlyPaths` entry per real host mount point `--rbind`
 *   duplicated in (see oci-protected-paths.ts — root.readonly alone only
 *   covers the top-level mount), except workdir/home/tmp/runnerTemp/
 *   writablePaths. rootfsBindDir itself lives under SANDBOX_SCRATCH_BASE,
 *   which is never one of those writable exceptions, so the recursive
 *   writable rbinds don't re-expose the host-`/` rootfs as a second, writable
 *   copy inside the sandbox (see assertScratchBaseNotWritable, which fails
 *   closed if a `writable:` input would break that invariant).
 * - linux.namespaces: same six namespace types runc's own default spec
 *   already requests (no user namespace — see docs/security.md's
 *   rationale for preserving the real UID/GID), just adding `path` to the
 *   network entry so it joins the netns run-isolated.sh already wired a
 *   veth into, instead of creating a fresh, unconnected one.
 * - process.capabilities: fully cleared (all five sets empty) plus
 *   noNewPrivileges — runc applies this natively, no setpriv needed.
 * - process.env: emptied. The step's real environment (and, inspect engine
 *   only, the CA-trust variables ca-trust.ts adds) is handed to the sandbox
 *   over stdin instead. See env-loader.ts.
 * - linux.seccomp: the Docker-default-profile-derived filter (see
 *   gen-seccomp-profile), resolved against this same empty capability
 *   set.
 * - process.rlimits, hostname, /dev/shm size: matched to the runner rather
 *   than left at runc's container defaults. This sandbox restricts network
 *   and filesystem writes, not resources.
 * - mounts: assembled here in the order the comment on that assembly gives;
 *   each mode's own layers come from oci-mounts.ts.
 *
 * `writablePaths` containing "/" is a sentinel meaning "disable the
 * read-only restriction entirely" (see README.md's `writable`
 * input).
 */
export function buildOciConfig(
  baseSpec: OciSpec,
  { identity, writable, ephemeral, runtime, env, caTrust }: BuildOciConfigOptions,
  probes: HostProbes = realHostProbes,
): BuiltOciSpec {
  const { uid, gid } = identity;
  const { workdir, writablePaths = [] } = writable;
  const {
    netnsPath,
    rootfsBindDir,
    resolvConfPath,
    seccompProfile,
    execDir,
    envLoaderPath,
    scriptPath,
    hostMounts = [],
  } = runtime;
  const disableReadonly = !ephemeral && writablePaths.includes("/");

  const caAdditions = caTrust ? caTrustAdditions(caTrust, env) : undefined;
  // Pushed after the writable layers below: a write_through entry naming a
  // directory that contains these (write_through: /etc) would otherwise shadow
  // them and take the sandbox's DNS and CA trust with it.
  const internalMounts = [
    {
      destination: RESOLV_CONF_DESTINATION,
      type: "none",
      source: resolvConfPath,
      options: ["rbind", "ro"],
    },
    ...(caAdditions?.mounts ?? []),
  ];
  const nofile: NofileLimit | undefined = probes.nofileRlimit();
  const freshMountDestinations = freshMountDestinationsFrom(baseSpec);
  // Order is the policy: runc's own mounts, then whichever mode's writable
  // layers, then this action's own (which have to win over a write_through
  // entry containing them), then the scratch base last of all.
  const layers = ephemeral
    ? ephemeralLayers(ephemeral, freshMountDestinations)
    : persistentLayers(writableDirsOf(writable), freshMountDestinations, { disableReadonly });
  const mounts = [
    ...withHostShmSize(baseSpec.mounts, probes.shmSizeBytes()),
    ...layers.mounts,
    ...internalMounts,
    ...scratchBaseLayers(execDir),
  ];

  const { maskedPaths, readonlyPaths } = resolveProtectedPaths({
    baseMaskedPaths: baseSpec.linux.maskedPaths ?? [],
    baseReadonlyPaths: baseSpec.linux.readonlyPaths ?? [],
    uid,
    env,
    hostMounts,
    writablePaths: layers.writablePaths,
    freshMountDestinations,
    disableReadonly,
  });

  const namespaces = baseSpec.linux.namespaces.map((ns) =>
    ns.type === "network" ? { ...ns, path: netnsPath } : ns,
  );

  return {
    ...baseSpec,
    root: { path: rootfsBindDir, readonly: !disableReadonly },
    mounts,
    // runc's default spec names every container "runc", while /etc/hostname
    // comes in with the host rootfs and already reads the runner's name.
    hostname: probes.hostname(),
    process: {
      ...baseSpec.process,
      terminal: false,
      user: { uid, gid },
      // setpriv --pdeathsig ties this process's life to its direct
      // parent's -- the `runc run` process, not run-isolated.sh itself
      // (runc's own process sits in between). This is the second hop of a
      // two-hop chain: run-isolated.sh also wraps its own `runc run`
      // invocation in `setpriv --pdeathsig=KILL` (targeting itself), so if
      // run-isolated.sh is SIGKILL'd, `runc run` dies too, which then
      // kills this process in turn -- without the outer hop, `runc run`
      // would merely become an orphan (still alive) and this process,
      // whose parent never actually died, would never receive anything.
      // No other setpriv flags are needed here -- uid/gid, capabilities,
      // and no_new_privs are already applied by runc itself (above/below)
      // before this execs.
      args: [probes.setprivPath(), "--pdeathsig=KILL", "--", envLoaderPath, scriptPath],
      // Empty by design: envLoaderPath applies the step's environment from
      // stdin before execing scriptPath, keeping `env:` secrets off the
      // runner's disk. See env-loader.ts.
      env: [],
      cwd: workdir || "/",
      capabilities: { bounding: [], effective: [], permitted: [], inheritable: [], ambient: [] },
      noNewPrivileges: true,
      // An unwrapped step gets the runner's own RLIMIT_NOFILE, 65536 on
      // GitHub-hosted runners. Both runc's default spec and the `sudo` on the
      // way to it pin the soft limit at 1024, which surfaces as EMFILE in
      // webpack/jest, so carry the real one across explicitly. NOFILE is the
      // only limit either of them touches.
      rlimits: nofile
        ? [{ type: "RLIMIT_NOFILE", soft: nofile.soft, hard: nofile.hard }]
        : undefined,
    },
    linux: {
      ...baseSpec.linux,
      namespaces,
      seccomp: seccompProfile,
      maskedPaths,
      readonlyPaths,
    },
  };
}
