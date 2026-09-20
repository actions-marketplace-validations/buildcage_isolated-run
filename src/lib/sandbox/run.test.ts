import { describe, it, expect } from "vitest";

import { runIsolated, type ExecFileOptions, type RunIsolatedOptions } from "./run.ts";

// run-isolated.sh is the process under `sudo` here, so what this module can be
// held to is the argument list it builds and how it reads the child's exit.
type Call = [string, string[], ExecFileOptions];

/** Records what was asked to run, and answers as execFileSync would. */
function recorder(answer: () => void = () => {}) {
  const calls: Call[] = [];
  return {
    calls,
    execFile: (command: string, args: string[], options: ExecFileOptions) => {
      calls.push([command, args, options]);
      answer();
    },
  };
}

function options(overrides: Partial<RunIsolatedOptions> = {}): RunIsolatedOptions {
  return {
    runcPath: "/var/tmp/scratch/runc",
    proxyNetns: "buildcage-proxy-netns",
    bundleDir: "/var/tmp/scratch/bundle",
    containerId: "buildcage-step-abcd1234",
    netnsName: "buildcage-abcd1234",
    rootfsBindDir: "/var/tmp/scratch/rootfs",
    gateway: "10.0.0.1",
    dns: "10.0.0.2",
    targetIp: "10.0.0.3",
    envBlob: Buffer.from("PATH=/usr/bin\0"),
    ...overrides,
  };
}

/**
 * The flag/value pairs of a sudo invocation, as a lookup. Skips the leading
 * `-n -- <script>`, whose `--` is sudo's own separator.
 */
function flagsOf(calls: Call[]): Record<string, string> {
  const args = calls[0][1].slice(3);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length - 1; i += 2) {
    flags[args[i]] = args[i + 1];
  }
  return flags;
}

/** Builds the ExecException shape execFileSync throws on a non-zero exit. */
function execFailure(status: number | null, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error("Command failed"), { status, ...extra });
}

describe("runIsolated", () => {
  it("runs run-isolated.sh under non-interactive sudo", () => {
    const { calls, execFile } = recorder();
    runIsolated(options(), { execFile });

    const [command, args] = calls[0];
    expect(command).toBe("sudo");
    expect(args.slice(0, 2)).toStrictEqual(["-n", "--"]);
    expect(args[2]).toMatch(/\/scripts\/run-isolated\.sh$/);
  });

  it("passes every namespace and address the script needs", () => {
    const { calls, execFile } = recorder();
    runIsolated(options(), { execFile });

    expect(flagsOf(calls)).toStrictEqual({
      "--proxy-netns": "buildcage-proxy-netns",
      "--runc": "/var/tmp/scratch/runc",
      "--bundle": "/var/tmp/scratch/bundle",
      "--container-id": "buildcage-step-abcd1234",
      "--netns-name": "buildcage-abcd1234",
      "--rootfs-bind-dir": "/var/tmp/scratch/rootfs",
      "--gateway": "10.0.0.1",
      "--dns": "10.0.0.2",
      "--target-ip": "10.0.0.3",
    });
  });

  it("hands the environment over on stdin rather than in argv", () => {
    const { calls, execFile } = recorder();
    const envBlob = Buffer.from("SECRET=value\0");
    runIsolated(options({ envBlob }), { execFile });

    const [, args, opts] = calls[0];
    expect(opts.input).toBe(envBlob);
    expect(opts.stdio).toStrictEqual(["pipe", "inherit", "inherit"]);
    expect(args.join(" ")).not.toContain("SECRET");
  });

  it("returns 0 when the isolated command succeeds", () => {
    const { execFile } = recorder();
    expect(runIsolated(options(), { execFile })).toBe(0);
  });

  it("returns the isolated command's own exit code rather than throwing", () => {
    const { execFile } = recorder(() => {
      throw execFailure(42);
    });
    expect(runIsolated(options(), { execFile })).toBe(42);
  });

  it("still reports the exit code when an EPIPE rides along with it", () => {
    const { execFile } = recorder(() => {
      throw execFailure(3, { code: "EPIPE", errno: -32 });
    });
    expect(runIsolated(options(), { execFile })).toBe(3);
  });

  it("falls back to 1 when the child was killed by a signal and has no status", () => {
    const { execFile } = recorder(() => {
      throw execFailure(null, { signal: "SIGKILL" });
    });
    expect(runIsolated(options(), { execFile })).toBe(1);
  });

  it("falls back to 1 when the failure carries no status at all", () => {
    const { execFile } = recorder(() => {
      throw new Error("spawn sudo ENOENT");
    });
    expect(runIsolated(options(), { execFile })).toBe(1);
  });
});
