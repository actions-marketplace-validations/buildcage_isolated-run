import { describe, it, expect, beforeEach, vi } from "vitest";

// run-isolated.sh is the process under `sudo` here, so what this module can be
// held to is the argument list it builds and how it reads the child's exit.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
import { execFileSync } from "node:child_process";

import { runIsolated, type RunIsolatedOptions } from "./run.ts";

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
 * The flag/value pairs of the most recent sudo invocation, as a lookup.
 * Skips the leading `-n -- <script>`, whose `--` is sudo's own separator.
 */
function flagsOfLastCall(): Record<string, string> {
  const args = (vi.mocked(execFileSync).mock.calls[0][1] as string[]).slice(3);
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
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it("runs run-isolated.sh under non-interactive sudo", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => Buffer.alloc(0));
    runIsolated(options());

    const [command, args] = vi.mocked(execFileSync).mock.calls[0];
    expect(command).toBe("sudo");
    expect((args as string[]).slice(0, 2)).toStrictEqual(["-n", "--"]);
    expect((args as string[])[2]).toMatch(/\/scripts\/run-isolated\.sh$/);
  });

  it("passes every namespace and address the script needs", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => Buffer.alloc(0));
    runIsolated(options());

    expect(flagsOfLastCall()).toStrictEqual({
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

  // The environment travels on stdin so it never reaches the runner's disk.
  it("hands the environment over on stdin rather than in argv", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => Buffer.alloc(0));
    const envBlob = Buffer.from("SECRET=value\0");
    runIsolated(options({ envBlob }));

    const opts = vi.mocked(execFileSync).mock.calls[0][2] as {
      input: Buffer;
      stdio: string[];
    };
    expect(opts.input).toBe(envBlob);
    expect(opts.stdio).toStrictEqual(["pipe", "inherit", "inherit"]);
    expect((vi.mocked(execFileSync).mock.calls[0][1] as string[]).join(" ")).not.toContain(
      "SECRET",
    );
  });

  it("returns 0 when the isolated command succeeds", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => Buffer.alloc(0));
    expect(runIsolated(options())).toBe(0);
  });

  it("returns the isolated command's own exit code rather than throwing", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw execFailure(42);
    });
    expect(runIsolated(options())).toBe(42);
  });

  // A child that exits before draining envBlob shows up here with a spurious
  // EPIPE alongside its real status, so the status is what must be read.
  it("still reports the exit code when an EPIPE rides along with it", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw execFailure(3, { code: "EPIPE", errno: -32 });
    });
    expect(runIsolated(options())).toBe(3);
  });

  it("falls back to 1 when the child was killed by a signal and has no status", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw execFailure(null, { signal: "SIGKILL" });
    });
    expect(runIsolated(options())).toBe(1);
  });

  it("falls back to 1 when the failure carries no status at all", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("spawn sudo ENOENT");
    });
    expect(runIsolated(options())).toBe(1);
  });
});
