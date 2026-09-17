import { describe, it, expect, beforeEach, vi } from "vitest";

// `sudo -n true` is the probe itself, so it is stubbed rather than run.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
import { execFileSync } from "node:child_process";

import { checkPasswordlessSudo, describeSudoFailure } from "./sudo-preflight.ts";
import { SandboxError } from "./errors.ts";

describe("describeSudoFailure", () => {
  const noSlimRunner = { env: {}, exists: () => false };

  it("mirrors the docs' passwordless-sudo phrasing", () => {
    const msg = describeSudoFailure({ status: 1 }, noSlimRunner);
    expect(msg).toMatch(/requires a Linux runner with passwordless sudo/);
  });

  it("includes captured stderr detail when present", () => {
    expect(
      describeSudoFailure({ status: 1, stderr: "sudo: a password is required" }, noSlimRunner),
    ).toMatch(/a password is required/);
  });

  it("handles a thrown value that is not an object at all", () => {
    // There is no stderr to quote on a bare string, so it is dropped rather
    // than pasted into the message.
    const msg = describeSudoFailure("sudo: command not found", noSlimRunner);
    expect(msg).toMatch(/requires a Linux runner with passwordless sudo/);
    expect(msg).not.toContain("sudo: command not found");
  });

  it("adds a detection note when the runner looks like a container-based image", () => {
    const withNote = describeSudoFailure(
      { status: 1 },
      { env: { ImageOS: "Linux" }, exists: () => true },
    );
    const withoutNote = describeSudoFailure({ status: 1 }, noSlimRunner);
    expect(withNote).toMatch(/Detected a container-based GitHub-hosted runner image/);
    expect(withoutNote).not.toMatch(/Detected a container-based GitHub-hosted runner image/);
  });
});

describe("checkPasswordlessSudo", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it("probes with a command that changes nothing", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => "");
    checkPasswordlessSudo();

    const [command, args] = vi.mocked(execFileSync).mock.calls[0];
    expect(command).toBe("sudo");
    expect(args).toStrictEqual(["-n", "true"]);
  });

  it("passes silently when sudo answers without a password", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => "");
    expect(() => checkPasswordlessSudo()).not.toThrow();
  });

  // Fails here rather than later, so a runner without passwordless sudo is
  // never misreported as the user's own `run:` command failing.
  it("turns a refusal into PASSWORDLESS_SUDO_REQUIRED, carrying the captured stderr", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("Command failed"), {
        status: 1,
        stderr: "sudo: a password is required",
      });
    });

    try {
      checkPasswordlessSudo();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxError);
      expect((err as SandboxError).code).toBe("PASSWORDLESS_SUDO_REQUIRED");
      expect((err as Error).message).toMatch(/requires a Linux runner with passwordless sudo/);
      expect((err as Error).message).toContain("a password is required");
    }
  });
});
