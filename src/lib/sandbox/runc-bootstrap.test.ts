import { describe, it, expect } from "vitest";

import {
  extractRuncBootstrap,
  generateBaseOciSpec,
  type RuncBootstrapDeps,
} from "./runc-bootstrap.ts";

// Both binaries live in the proxy image and run natively on the host, so what
// this module can be held to is the `docker cp` argv it issues, the modes it
// sets, and that it does not leave gen-seccomp-profile behind.
const CONTAINER = "buildcage-proxy-abcd1234";
const DEST = "/var/tmp/buildcage-0/sandbox-abcd1234";
const SECCOMP = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] };
const BASE_SPEC = { ociVersion: "1.2.0", process: { args: ["sh"] } };

interface Recorded {
  exec: [string, string[]][];
  execIn: [string, string[], string][];
  readFile: string[];
  chmod: [string, number][];
  remove: string[];
}

/** Answers as the two binaries and `runc spec` would, recording every call. */
function recorder(): { calls: Recorded; deps: RuncBootstrapDeps } {
  const calls: Recorded = { exec: [], execIn: [], readFile: [], chmod: [], remove: [] };
  return {
    calls,
    deps: {
      exec: (command, args) => {
        calls.exec.push([command, args]);
        // Only gen-seccomp-profile is run for its output; the `docker cp`s
        // are not, and nothing reads what they return.
        return command.endsWith("/gen-seccomp-profile") ? JSON.stringify(SECCOMP) : "";
      },
      execIn: (command, args, cwd) => {
        calls.execIn.push([command, args, cwd]);
      },
      readFile: (path) => {
        calls.readFile.push(path);
        return JSON.stringify(BASE_SPEC);
      },
      chmod: (path, mode) => {
        calls.chmod.push([path, mode]);
      },
      remove: (path) => {
        calls.remove.push(path);
      },
    },
  };
}

describe("extractRuncBootstrap", () => {
  it("copies both binaries out of the proxy container into this step's scratch dir", () => {
    const { calls, deps } = recorder();
    extractRuncBootstrap({ containerName: CONTAINER, destDir: DEST }, deps);

    expect(calls.exec[0][0]).toBe("docker");
    expect(calls.exec[0][1]).toStrictEqual([
      "cp",
      `${CONTAINER}:/opt/buildcage/bin/runc`,
      `${DEST}/runc`,
    ]);
    expect(calls.exec[1][1]).toStrictEqual([
      "cp",
      `${CONTAINER}:/opt/buildcage/bin/gen-seccomp-profile`,
      `${DEST}/gen-seccomp-profile`,
    ]);
  });

  it("makes both copies executable before running them", () => {
    const { calls, deps } = recorder();
    extractRuncBootstrap({ containerName: CONTAINER, destDir: DEST }, deps);

    expect(calls.chmod).toStrictEqual([
      [`${DEST}/runc`, 0o755],
      [`${DEST}/gen-seccomp-profile`, 0o755],
    ]);
  });

  it("returns the generator's profile and runc's own default spec", () => {
    const { deps } = recorder();
    const result = extractRuncBootstrap({ containerName: CONTAINER, destDir: DEST }, deps);

    expect(result.runcPath).toBe(`${DEST}/runc`);
    expect(result.seccompProfile).toStrictEqual(SECCOMP);
    expect(result.baseSpec).toStrictEqual(BASE_SPEC);
  });

  it("removes gen-seccomp-profile once its output has been read", () => {
    const { calls, deps } = recorder();
    extractRuncBootstrap({ containerName: CONTAINER, destDir: DEST }, deps);

    expect(calls.remove).toStrictEqual([`${DEST}/gen-seccomp-profile`]);
  });
});

describe("generateBaseOciSpec", () => {
  it("runs `runc spec` in the bundle dir and reads the config.json it writes there", () => {
    const { calls, deps } = recorder();

    expect(generateBaseOciSpec(`${DEST}/runc`, DEST, deps)).toStrictEqual(BASE_SPEC);

    expect(calls.execIn).toStrictEqual([[`${DEST}/runc`, ["spec"], DEST]]);
    expect(calls.readFile).toStrictEqual([`${DEST}/config.json`]);
  });
});
