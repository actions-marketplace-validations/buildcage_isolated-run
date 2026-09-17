import { describe, it, expect, beforeEach, vi } from "vitest";

// Both binaries live in the proxy image and run natively on the host, so what
// this module can be held to is the `docker cp` argv it issues, the modes it
// sets, and that it does not leave gen-seccomp-profile behind.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
import { execFileSync } from "node:child_process";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    chmodSync: vi.fn(actual.chmodSync),
    rmSync: vi.fn(actual.rmSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});
import { chmodSync, rmSync, readFileSync } from "node:fs";

import { extractRuncBootstrap, generateBaseOciSpec } from "./runc-bootstrap.ts";

const CONTAINER = "buildcage-proxy-abcd1234";
const DEST = "/var/tmp/buildcage-0/sandbox-abcd1234";
const SECCOMP = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] };
const BASE_SPEC = { ociVersion: "1.2.0", process: { args: ["sh"] } };

/** Stubs the three external calls in order: two `docker cp`s, then the two binaries. */
function stubExternals() {
  vi.mocked(execFileSync)
    .mockImplementationOnce(() => Buffer.alloc(0)) // docker cp runc
    .mockImplementationOnce(() => Buffer.alloc(0)) // docker cp gen-seccomp-profile
    .mockImplementationOnce(() => JSON.stringify(SECCOMP)) // gen-seccomp-profile
    .mockImplementationOnce(() => Buffer.alloc(0)); // runc spec
  vi.mocked(chmodSync).mockImplementation(() => {});
  vi.mocked(rmSync).mockImplementation(() => {});
  vi.mocked(readFileSync).mockImplementationOnce(() => JSON.stringify(BASE_SPEC));
}

describe("extractRuncBootstrap", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(chmodSync).mockReset();
    vi.mocked(rmSync).mockReset();
  });

  it("copies both binaries out of the proxy container into this step's scratch dir", () => {
    stubExternals();
    extractRuncBootstrap({ containerName: CONTAINER, destDir: DEST });

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0][0]).toBe("docker");
    expect(calls[0][1]).toStrictEqual([
      "cp",
      `${CONTAINER}:/opt/buildcage/bin/runc`,
      `${DEST}/runc`,
    ]);
    expect(calls[1][1]).toStrictEqual([
      "cp",
      `${CONTAINER}:/opt/buildcage/bin/gen-seccomp-profile`,
      `${DEST}/gen-seccomp-profile`,
    ]);
  });

  it("makes both copies executable before running them", () => {
    stubExternals();
    extractRuncBootstrap({ containerName: CONTAINER, destDir: DEST });

    expect(vi.mocked(chmodSync).mock.calls).toStrictEqual([
      [`${DEST}/runc`, 0o755],
      [`${DEST}/gen-seccomp-profile`, 0o755],
    ]);
  });

  // The seccomp profile depends on the real host kernel and arch, so the
  // generator runs on the host rather than through `docker exec`.
  it("returns the generator's profile and runc's own default spec", () => {
    stubExternals();
    const result = extractRuncBootstrap({ containerName: CONTAINER, destDir: DEST });

    expect(result.runcPath).toBe(`${DEST}/runc`);
    expect(result.seccompProfile).toStrictEqual(SECCOMP);
    expect(result.baseSpec).toStrictEqual(BASE_SPEC);
  });

  // It is only needed to resolve the profile, and the scratch dir it sits in
  // is bind-mounted into the sandbox.
  it("removes gen-seccomp-profile once its output has been read", () => {
    stubExternals();
    extractRuncBootstrap({ containerName: CONTAINER, destDir: DEST });

    expect(vi.mocked(rmSync).mock.calls).toStrictEqual([[`${DEST}/gen-seccomp-profile`]]);
  });
});

describe("generateBaseOciSpec", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it("runs `runc spec` in the bundle dir and reads the config.json it writes there", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => Buffer.alloc(0));
    vi.mocked(readFileSync).mockImplementationOnce(() => JSON.stringify(BASE_SPEC));

    expect(generateBaseOciSpec(`${DEST}/runc`, DEST)).toStrictEqual(BASE_SPEC);

    const [command, args, options] = vi.mocked(execFileSync).mock.calls[0];
    expect(command).toBe(`${DEST}/runc`);
    expect(args).toStrictEqual(["spec"]);
    expect((options as { cwd: string }).cwd).toBe(DEST);
    expect(vi.mocked(readFileSync).mock.calls[0][0]).toBe(`${DEST}/config.json`);
  });
});
