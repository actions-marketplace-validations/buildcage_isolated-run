import { describe, it, expect } from "vitest";

import {
  extractCaCert,
  writeCaTrustFiles,
  caTrustAdditions,
  OWN_CA_DESTINATION,
  type CaTrustDeps,
} from "./ca-trust.ts";

const FAKE_CA = "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----";

/** The candidate a Debian/Ubuntu runner actually has. */
const DEBIAN_STORE = "/etc/ssl/certs/ca-certificates.crt";
/** What a self-hosted RHEL runner is reached by instead. */
const RHEL_STORE = "/etc/pki/tls/certs/ca-bundle.crt";
const FAKE_SYSTEM_BUNDLE = "-----BEGIN CERTIFICATE-----\nsystem\n-----END CERTIFICATE-----";

/**
 * A host whose files are exactly `files`. Nothing here touches a real
 * filesystem: left real, this suite would read whatever CA bundle the machine
 * running it happens to have: a different answer on a macOS dev machine than
 * in CI.
 */
function fakeHost(files: Record<string, string>) {
  const written: Record<string, { contents: string; mode: number }> = {};
  const exec: [string, string[]][] = [];
  const chmod: [string, number][] = [];
  const deps: CaTrustDeps = {
    exec: (command, args) => {
      exec.push([command, args]);
    },
    chmod: (path, mode) => {
      chmod.push([path, mode]);
    },
    exists: (path) => path in files,
    readFile: (path) => {
      const contents = files[path] ?? written[path]?.contents;
      if (contents === undefined) throw new Error(`ENOENT: ${path}`);
      return contents;
    },
    writeFile: (path, contents, mode) => {
      written[path] = { contents, mode };
    },
  };
  return { deps, written, exec, chmod };
}

describe("writeCaTrustFiles", () => {
  const CA_INPUT = "/scratch/input-ca.pem";

  it("writes the CA into its own file, trailing whitespace trimmed to one newline", () => {
    const { deps, written } = fakeHost({ [CA_INPUT]: `${FAKE_CA}\n\n\n` });
    const { ownCaPath } = writeCaTrustFiles(CA_INPUT, "/scratch", deps);

    expect(ownCaPath).toBe("/scratch/buildcage-ca.pem");
    expect(written[ownCaPath].contents).toBe(`${FAKE_CA}\n`);
    expect(written[ownCaPath].mode).toBe(0o644);
  });

  it("appends the CA to the host's system store when the runner has one", () => {
    const { deps, written } = fakeHost({
      [CA_INPUT]: `${FAKE_CA}\n`,
      [DEBIAN_STORE]: `${FAKE_SYSTEM_BUNDLE}\n`,
    });
    const { systemCa } = writeCaTrustFiles(CA_INPUT, "/scratch", deps);

    expect(systemCa).toEqual({ path: "/scratch/system-ca-bundle.pem", destination: DEBIAN_STORE });
    expect(written[systemCa!.path].contents).toBe(`${FAKE_SYSTEM_BUNDLE}\n${FAKE_CA}\n`);
  });

  // The augmented copy has to go back over the path it was read from. Mounted
  // anywhere else, a tool going by its own compiled-in path reads the runner's
  // untouched store and never sees the proxy's CA.
  it("reports the candidate it read, not the first one in the list", () => {
    const { deps } = fakeHost({
      [CA_INPUT]: `${FAKE_CA}\n`,
      [RHEL_STORE]: `${FAKE_SYSTEM_BUNDLE}\n`,
    });
    const { systemCa } = writeCaTrustFiles(CA_INPUT, "/scratch", deps);

    expect(systemCa?.destination).toBe(RHEL_STORE);
  });

  // A tool pointed at a replacing variable would otherwise end up trusting the
  // proxy CA and nothing else, so no system file means no system bundle.
  it("leaves systemCaPath undefined when no candidate store exists", () => {
    const { deps, written } = fakeHost({ [CA_INPUT]: `${FAKE_CA}\n` });
    const { systemCa } = writeCaTrustFiles(CA_INPUT, "/scratch", deps);

    expect(systemCa).toBeUndefined();
    expect(written["/scratch/system-ca-bundle.pem"]).toBeUndefined();
  });

  it("takes the first candidate that exists, in the documented order", () => {
    const { deps, written } = fakeHost({
      [CA_INPUT]: `${FAKE_CA}\n`,
      "/etc/ssl/ca-bundle.pem": `${FAKE_SYSTEM_BUNDLE}\n`,
      "/etc/ssl/cert.pem": "-----BEGIN CERTIFICATE-----\nlater\n-----END CERTIFICATE-----\n",
    });
    const { systemCa } = writeCaTrustFiles(CA_INPUT, "/scratch", deps);

    expect(written[systemCa!.path].contents).toContain(FAKE_SYSTEM_BUNDLE);
    expect(written[systemCa!.path].contents).not.toContain("later");
  });
});

describe("caTrustAdditions", () => {
  it("mounts the CA-only file and points the additive variables at it, when unset", () => {
    const { mounts, env } = caTrustAdditions(
      { ownCaPath: "/scratch/buildcage-ca.pem", systemCa: undefined },
      {},
    );
    expect(mounts).toEqual([
      {
        destination: OWN_CA_DESTINATION,
        type: "none",
        source: "/scratch/buildcage-ca.pem",
        options: ["rbind", "ro"],
      },
    ]);
    expect(env.NODE_EXTRA_CA_CERTS).toBe(OWN_CA_DESTINATION);
    expect(env.DENO_CERT).toBe(OWN_CA_DESTINATION);
  });

  it("does not override a variable the step already set", () => {
    const { env } = caTrustAdditions(
      { ownCaPath: "/scratch/buildcage-ca.pem", systemCa: undefined },
      { NODE_EXTRA_CA_CERTS: "/my/own/bundle.pem" },
    );
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(env.DENO_CERT).toBe(OWN_CA_DESTINATION);
  });

  it("adds the system-store mount and points the replacing variables at it, only when a system store was found", () => {
    const { mounts, env } = caTrustAdditions(
      {
        ownCaPath: "/scratch/buildcage-ca.pem",
        systemCa: { path: "/scratch/system-ca-bundle.pem", destination: RHEL_STORE },
      },
      {},
    );
    expect(mounts).toContainEqual({
      destination: RHEL_STORE,
      type: "none",
      source: "/scratch/system-ca-bundle.pem",
      options: ["rbind", "ro"],
    });
    expect(env.REQUESTS_CA_BUNDLE).toBe(RHEL_STORE);
    expect(env.PIP_CERT).toBe(RHEL_STORE);
    expect(env.SSL_CERT_FILE).toBe(RHEL_STORE);
  });

  it("leaves CURL_CA_BUNDLE alone either way, since curl already reads the system store", () => {
    const { env } = caTrustAdditions(
      {
        ownCaPath: "/scratch/buildcage-ca.pem",
        systemCa: { path: "/scratch/system-ca-bundle.pem", destination: RHEL_STORE },
      },
      {},
    );
    expect(env.CURL_CA_BUNDLE).toBeUndefined();
  });

  it("does not override a replacing variable the step already set", () => {
    const { env } = caTrustAdditions(
      {
        ownCaPath: "/scratch/buildcage-ca.pem",
        systemCa: { path: "/scratch/system-ca-bundle.pem", destination: RHEL_STORE },
      },
      { REQUESTS_CA_BUNDLE: "/my/own/bundle.pem" },
    );
    expect(env.REQUESTS_CA_BUNDLE).toBeUndefined();
    expect(env.PIP_CERT).toBe(RHEL_STORE);
  });

  it("omits the system-store mount entirely when no system store was found", () => {
    const { mounts, env } = caTrustAdditions(
      { ownCaPath: "/scratch/buildcage-ca.pem", systemCa: undefined },
      {},
    );
    expect(mounts.some((m) => m.destination === RHEL_STORE)).toBe(false);
    expect(env.REQUESTS_CA_BUNDLE).toBeUndefined();
    expect(env.PIP_CERT).toBeUndefined();
    expect(env.SSL_CERT_FILE).toBeUndefined();
  });
});

describe("extractCaCert", () => {
  const containerName = "buildcage-proxy-abcd1234";
  const destDir = "/var/tmp/buildcage-0/sandbox-abcd1234";

  it("copies the proxy's own CA out of the running container", () => {
    const { deps, exec } = fakeHost({});
    const path = extractCaCert(containerName, destDir, deps);

    expect(path).toBe(`${destDir}/proxy-ca.pem`);
    expect(exec).toStrictEqual([
      ["docker", ["cp", `${containerName}:/opt/buildcage/ca.pem`, `${destDir}/proxy-ca.pem`]],
    ]);
  });

  // The sandboxed process runs as the unprivileged runner user and has to be
  // able to read it.
  it("leaves the copy world-readable", () => {
    const { deps, chmod } = fakeHost({});
    extractCaCert(containerName, destDir, deps);

    expect(chmod).toStrictEqual([[`${destDir}/proxy-ca.pem`, 0o644]]);
  });
});
