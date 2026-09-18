import { describe, it, expect } from "vitest";

import { computeReadonlyHostMounts } from "./oci-protected-paths.ts";
import { parseMountinfo } from "./mountinfo.ts";

// Realistic /proc/self/mountinfo lines (see parseMountinfo's doc comment
// for the field layout). Each has one optional field ("shared:N") before
// the "-" separator, matching what a systemd-managed host typically shows.
const SAMPLE_MOUNTINFO = [
  "1 0 0:1 / / rw,relatime shared:1 - ext4 /dev/root rw",
  "2 1 0:2 / /proc rw,relatime shared:2 - proc proc rw",
  "3 1 0:3 / /run rw,nosuid,relatime shared:3 - tmpfs tmpfs rw,size=100k",
  "4 3 0:4 / /run/user/1000 rw,nosuid,relatime shared:4 - tmpfs tmpfs rw",
  "5 1 0:5 / /mnt rw,relatime shared:5 - ext4 /dev/sdb1 rw",
].join("\n");

describe("computeReadonlyHostMounts", () => {
  const hostMounts = parseMountinfo(SAMPLE_MOUNTINFO);
  const freshMountDestinations = new Set(["/proc"]);

  it("excludes '/' itself (already covered by root.readonly)", () => {
    const result = computeReadonlyHostMounts(hostMounts, new Set(), freshMountDestinations);
    expect(!result.includes("/")).toBeTruthy();
  });

  it("excludes paths runc's own base spec already mounts fresh", () => {
    const result = computeReadonlyHostMounts(hostMounts, new Set(), freshMountDestinations);
    expect(!result.includes("/proc")).toBeTruthy();
  });

  it("excludes explicitly protected (writable) paths", () => {
    const result = computeReadonlyHostMounts(hostMounts, new Set(["/run"]), freshMountDestinations);
    expect(!result.includes("/run")).toBeTruthy();
    expect(
      result.includes("/run/user/1000"),
      "a nested mount under a protected path is still its own separate mount point",
    ).toBeTruthy();
  });

  it("includes real, non-pseudo, non-protected host mounts (e.g. a separate disk at /mnt)", () => {
    const result = computeReadonlyHostMounts(hostMounts, new Set(), freshMountDestinations);
    expect(result.includes("/mnt")).toBeTruthy();
    expect(result.includes("/run")).toBeTruthy();
    expect(result.includes("/run/user/1000")).toBeTruthy();
  });

  it("includes a pseudo-filesystem-like mount whose path isn't one of runc's own fresh destinations", () => {
    // e.g. securityfs at /sys/kernel/security: it looks like the same
    // "kernel pseudo-fs" class as /proc, but runc's default spec never
    // declares a mount for it, so the host-swept copy must be forced
    // read-only just like any other real mount point.
    const withSecurityfs = [
      ...hostMounts,
      { mountPoint: "/sys/kernel/security", fsType: "securityfs" },
    ];
    const result = computeReadonlyHostMounts(withSecurityfs, new Set(), freshMountDestinations);
    expect(result.includes("/sys/kernel/security")).toBeTruthy();
  });
});
