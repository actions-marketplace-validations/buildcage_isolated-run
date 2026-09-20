import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { buildDockerCpArgs } from "#core/lib/docker/args.ts";
import type { MountEntry } from "./types.ts";

/**
 * CA trust for the inspect engine, adapted for this sandbox's rootfs being
 * the live host `/` (via `mount --rbind /`), not a throwaway image layer.
 *
 * Writing the CA into the rootfs and deleting it again once the step's
 * process exits is the obvious approach, and the right one when that rootfs
 * is a disposable image layer, one torn down (or diffed and discarded) after
 * the step. It does not work here: this sandbox's rootfs is a bind-mount of
 * the live host `/`, so both the write and the delete land on the host
 * filesystem itself.
 *
 * Instead, the two files below are written into this run's own scratch
 * directory and mounted over the sandbox's own view of the relevant
 * paths (see caTrustAdditions / buildOciConfig), a mount-namespace-scoped
 * overlay, not a host write. The mount needs nothing undone
 * afterward: run-isolated.sh's `umount -R` (and the scratch dir's own
 * cleanup) removes it, along with the rest of the rootfs bind-mount, when
 * the step ends, and the real host file SYSTEM_CA_DESTINATION resolves to is
 * never touched (it already exists, so runc mounts straight over it).
 *
 * OWN_CA_DESTINATION is the one exception: nothing exists at that path
 * ahead of time, so runc creates an empty placeholder file to mount onto,
 * which on this rootfs is a real write to the host filesystem. It is
 * removed by run-isolated.sh's cleanup(), whose comment gives the ordering
 * and the guard it removes it under.
 */
export interface CaTrustFiles {
  /** A CA-only file, mounted at OWN_CA_DESTINATION, for variables that add
   *  to a tool's built-in trust set (NODE_EXTRA_CA_CERTS, DENO_CERT). */
  ownCaPath: string;
  /** The runner's own system CA store with this CA appended, mounted at
   *  SYSTEM_CA_DESTINATION, for variables that replace a tool's trust
   *  bundle outright (REQUESTS_CA_BUNDLE, PIP_CERT, SSL_CERT_FILE), and for
   *  every other tool (curl, ...) that already reads the system store by
   *  default. Undefined if the runner has no system store at any of the
   *  well-known candidate paths. SYSTEM_CA_CANDIDATES[0] is the only one
   *  a GitHub-hosted (passwordless-sudo) Linux runner actually has; the
   *  rest are kept only as a defensive fallback.
   */
  systemCaPath: string | undefined;
}

const SYSTEM_CA_CANDIDATES = [
  "/etc/ssl/certs/ca-certificates.crt", // Debian/Ubuntu
  "/etc/pki/tls/certs/ca-bundle.crt", // RHEL/Fedora
  "/etc/ssl/ca-bundle.pem", // openSUSE
  "/etc/pki/tls/cacert.pem", // OpenELEC
  "/etc/ssl/cert.pem", // Alpine
];

/** Where the two files above are mounted inside the sandbox. Changing this
 *  value must stay in sync with run-isolated.sh's own BUILDCAGE_CA_PLACEHOLDER
 *  (its cleanup() targets this exact path; see the module doc comment). */
export const OWN_CA_DESTINATION = "/etc/buildcage-ca.pem";
export const SYSTEM_CA_DESTINATION = SYSTEM_CA_CANDIDATES[0];

export interface CaTrustDeps {
  exec?: (command: string, args: string[]) => void;
  readFile?: (path: string) => string;
  writeFile?: (path: string, contents: string, mode: number) => void;
  exists?: (path: string) => boolean;
  chmod?: (path: string, mode: number) => void;
}

// Untested by design: the defaults behind this module's seams, which only hand
// node:fs and node:child_process what the tested caller decided.
/* v8 ignore start */
function defaultExec(command: string, args: string[]): void {
  execFileSync(command, args);
}

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

function defaultWriteFile(path: string, contents: string, mode: number): void {
  writeFileSync(path, contents, { mode });
}
/* v8 ignore stop */

/**
 * Pull the proxy's own CA (generated once per container by
 * init-inspect-cfg) out of the inspect proxy image, the same way
 * extractRuncBootstrap pulls runc and gen-seccomp-profile: `docker cp`, run
 * once per `run:` step, into this run's own scratch dir.
 */
export function extractCaCert(
  containerName: string,
  destDir: string,
  { exec = defaultExec, chmod = chmodSync }: CaTrustDeps = {},
): string {
  const caCertPath = join(destDir, "proxy-ca.pem");
  exec(
    "docker",
    buildDockerCpArgs({
      containerName,
      containerPath: "/opt/buildcage/ca.pem",
      hostPath: caCertPath,
    }),
  );
  chmod(caCertPath, 0o644);
  return caCertPath;
}

/**
 * Write the CA trust files a step's env vars will point at, into `dir`
 * (this run's own scratch directory). `caCertPath` is the proxy's own CA,
 * already `docker cp`'d onto the host; see extractCaCert.
 */
export function writeCaTrustFiles(
  caCertPath: string,
  dir: string,
  {
    readFile = defaultReadFile,
    writeFile = defaultWriteFile,
    exists = existsSync,
  }: CaTrustDeps = {},
): CaTrustFiles {
  const ca = readFile(caCertPath).trimEnd();

  const ownCaPath = join(dir, "buildcage-ca.pem");
  writeFile(ownCaPath, `${ca}\n`, 0o644);

  const systemStoreSource = SYSTEM_CA_CANDIDATES.find((p) => exists(p));
  let systemCaPath: string | undefined;
  if (systemStoreSource) {
    const existing = readFile(systemStoreSource).trimEnd();
    systemCaPath = join(dir, "system-ca-bundle.pem");
    writeFile(systemCaPath, `${existing}\n${ca}\n`, 0o644);
  }

  return { ownCaPath, systemCaPath };
}

// Mirrors buildcage/docker's inspect-engine CA-injection policy table (see
// docs/security.md): NODE_EXTRA_CA_CERTS/DENO_CERT add to a built-in trust
// set, so they're pointed at a CA-only file; REQUESTS_CA_BUNDLE/PIP_CERT/
// SSL_CERT_FILE replace a tool's bundle outright, so they're pointed at the
// (augmented) system store instead, never a CA-only file: doing so would
// leave the tool trusting nothing else. CURL_CA_BUNDLE is left unset: curl
// already reads the system store by default.
//
// Only applied when a variable is unset. A step that already points one of
// these somewhere keeps doing so unmodified: safely appending to an
// arbitrary already-set path would need host-escape-safe symlink
// resolution.
const POINT_AT_OWN_CA = ["NODE_EXTRA_CA_CERTS", "DENO_CERT"];
const POINT_AT_SYSTEM_STORE = ["REQUESTS_CA_BUNDLE", "PIP_CERT", "SSL_CERT_FILE"];

export interface CaTrustAdditions {
  mounts: MountEntry[];
  env: Record<string, string>;
}

/**
 * The extra mounts and env vars buildOciConfig should add on top of the
 * step's own, so the sandboxed process trusts the proxy's CA; see the
 * module doc comment for why these are mounts, not host writes.
 */
export function caTrustAdditions(files: CaTrustFiles, env: NodeJS.ProcessEnv): CaTrustAdditions {
  const mounts: MountEntry[] = [
    {
      destination: OWN_CA_DESTINATION,
      type: "none",
      source: files.ownCaPath,
      options: ["rbind", "ro"],
    },
  ];
  const extraEnv: Record<string, string> = {};
  for (const name of POINT_AT_OWN_CA) {
    if (!env[name]) extraEnv[name] = OWN_CA_DESTINATION;
  }

  if (files.systemCaPath) {
    mounts.push({
      destination: SYSTEM_CA_DESTINATION,
      type: "none",
      source: files.systemCaPath,
      options: ["rbind", "ro"],
    });
    for (const name of POINT_AT_SYSTEM_STORE) {
      if (!env[name]) extraEnv[name] = SYSTEM_CA_DESTINATION;
    }
  }

  return { mounts, env: extraEnv };
}
