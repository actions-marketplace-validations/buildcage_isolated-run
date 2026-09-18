import { describe, it, expect } from "vitest";

import { freshMountDestinationsFrom, withHostShmSize } from "./oci-mounts.ts";

describe("freshMountDestinationsFrom", () => {
  it("collects every mounts[].destination from the base spec", () => {
    const baseSpec = {
      mounts: [{ destination: "/proc" }, { destination: "/sys" }, { destination: "/dev/pts" }],
    };
    expect(freshMountDestinationsFrom(baseSpec)).toStrictEqual(
      new Set(["/proc", "/sys", "/dev/pts"]),
    );
  });
});

describe("withHostShmSize", () => {
  const shm = {
    destination: "/dev/shm",
    type: "tmpfs",
    source: "shm",
    options: ["nosuid", "noexec", "nodev", "mode=1777", "size=65536k"],
  };
  const other = { destination: "/dev", type: "tmpfs", source: "tmpfs", options: ["size=65536k"] };

  it("replaces runc's 64MB cap with the host's own /dev/shm size", () => {
    const [rewritten] = withHostShmSize([shm], 4 * 1024 * 1024 * 1024);
    expect(rewritten.options).toStrictEqual([
      "nosuid",
      "noexec",
      "nodev",
      "mode=1777",
      "size=4294967296",
    ]);
  });

  it("drops the cap entirely when the host's size is unknown, leaving the kernel default", () => {
    const [rewritten] = withHostShmSize([shm], undefined);
    expect(rewritten.options).toStrictEqual(["nosuid", "noexec", "nodev", "mode=1777"]);
  });

  it("adds the size to a /dev/shm entry that carries no options at all", () => {
    const [rewritten] = withHostShmSize(
      [{ destination: "/dev/shm", type: "tmpfs", source: "shm" }],
      1024,
    );
    expect(rewritten.options).toStrictEqual(["size=1024"]);
  });

  it("leaves every other mount alone, size= included", () => {
    // /dev is a separate tmpfs holding device nodes only; 64MB is ample there.
    expect(withHostShmSize([other], 1024)).toStrictEqual([other]);
  });
});
