import { describe, it, expect, vi } from "vitest";

// Both host probes are mocked: statSync so a test never depends on who owns a
// file on the machine running it (a scratch file is wheel-owned on macOS and
// runner-owned on Linux), and readFileSync so the default /etc/group path can
// be exercised without the real one deciding the outcome.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync), readFileSync: vi.fn(actual.readFileSync) };
});
import { writeFileSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveSandboxGid } from "./identity.ts";
import { withScratchDir } from "./scratch-dir.ts";

// Every test passes runtimeSocketPaths explicitly (even as []) so a real
// docker.sock/etc on the machine running the test never leaks in -- only
// the fake group file and, where relevant, a fake socket path under the
// scratch dir decide the outcome.

describe("resolveSandboxGid", () => {
  it("leaves a non-privileged primary GID unchanged", () => {
    withScratchDir((dir) => {
      const groupFile = join(dir, "group");
      writeFileSync(groupFile, "runner:x:1000:\n");
      const result = resolveSandboxGid(1000, {}, { groupFile, runtimeSocketPaths: [] });
      expect(result).toStrictEqual({ gid: 1000 });
    });
  });

  it("substitutes a primary GID whose name is privileged (e.g. docker)", () => {
    withScratchDir((dir) => {
      const groupFile = join(dir, "group");
      writeFileSync(groupFile, "docker:x:999:\nnogroup:x:65534:\n");
      const result = resolveSandboxGid(999, {}, { groupFile, runtimeSocketPaths: [] });
      expect(result).toStrictEqual({ gid: 65534, substitutedFrom: 999 });
    });
  });

  it("treats GID 0 as privileged even without consulting the group file", () => {
    const result = resolveSandboxGid(0, {}, { groupFile: "/nonexistent", runtimeSocketPaths: [] });
    expect(result.substitutedFrom).toBe(0);
    expect(result.gid).not.toBe(0);
  });

  it("flags a GID as privileged when it owns a runtime socket, even under a non-standard group name", () => {
    withScratchDir((dir) => {
      const groupFile = join(dir, "group");
      // A non-standard name, so the substitution can only be explained by
      // socket ownership and not by the name list.
      writeFileSync(groupFile, "not-a-known-name:x:1234:\nnogroup:x:65534:\n");
      vi.mocked(statSync).mockReturnValue({ gid: 1234 } as ReturnType<typeof statSync>);
      const result = resolveSandboxGid(1234, {}, { groupFile, runtimeSocketPaths: ["/fake.sock"] });
      expect(result).toStrictEqual({ gid: 65534, substitutedFrom: 1234 });
    });
  });

  it("skips a runtime socket path that doesn't exist rather than failing", () => {
    withScratchDir((dir) => {
      const groupFile = join(dir, "group");
      writeFileSync(groupFile, "runner:x:1000:\n");
      const result = resolveSandboxGid(1000, {}, { groupFile, runtimeSocketPaths: ["/gone.sock"] });
      expect(result).toStrictEqual({ gid: 1000 });
    });
  });

  it("ignores group file lines with no name or no numeric GID", () => {
    withScratchDir((dir) => {
      const groupFile = join(dir, "group");
      writeFileSync(
        groupFile,
        ["# a comment", "", ":x:1000:", "docker:x:not-a-number:", "docker:x:1000:"].join("\n") +
          "\n",
      );
      // The only line that parses puts docker on 1000, so a GID that the
      // malformed lines would also have claimed still resolves from that one.
      const result = resolveSandboxGid(1000, {}, { groupFile, runtimeSocketPaths: [] });
      expect(result).toStrictEqual({ gid: 65534, substitutedFrom: 1000 });
    });
  });

  it("moves on to nobody when the group file has no nogroup", () => {
    withScratchDir((dir) => {
      const groupFile = join(dir, "group");
      writeFileSync(groupFile, "docker:x:999:\nnobody:x:65500:\n");
      const result = resolveSandboxGid(999, {}, { groupFile, runtimeSocketPaths: [] });
      expect(result).toStrictEqual({ gid: 65500, substitutedFrom: 999 });
    });
  });

  it("throws UNSAFE_PRIMARY_GID when every candidate, including nogroup/nobody/65534, is privileged", () => {
    withScratchDir((dir) => {
      const groupFile = join(dir, "group");
      writeFileSync(
        groupFile,
        ["docker:x:500:", "nogroup:x:500:", "nobody:x:500:", "wheel:x:65534:"].join("\n") + "\n",
      );
      expect(() => resolveSandboxGid(500, {}, { groupFile, runtimeSocketPaths: [] })).toThrowError(
        /UNSAFE_PRIMARY_GID|privileged/,
      );
    });
  });

  it("reads /etc/group and the standard socket paths when given neither", () => {
    vi.mocked(readFileSync).mockClear().mockReturnValue("docker:x:999:\nnogroup:x:65534:\n");
    vi.mocked(statSync)
      .mockClear()
      .mockImplementation(() => {
        throw new Error("ENOENT");
      });

    const result = resolveSandboxGid(999, {});

    expect(result).toStrictEqual({ gid: 65534, substitutedFrom: 999 });
    expect(vi.mocked(readFileSync).mock.calls[0][0]).toBe("/etc/group");
    expect(vi.mocked(statSync).mock.calls.map(([p]) => p)).toContain("/var/run/docker.sock");
  });

  it("falls back to the runtime-socket check alone when the group file can't be read", () => {
    const result = resolveSandboxGid(
      1000,
      {},
      {
        groupFile: "/definitely/does/not/exist",
        runtimeSocketPaths: [],
      },
    );
    expect(result).toStrictEqual({ gid: 1000 });
  });
});
