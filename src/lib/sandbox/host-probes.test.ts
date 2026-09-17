import { describe, it, expect } from "vitest";

import {
  parseNofileLimit,
  resolveSetprivPath,
  shmSizeFromStatfs,
  SETPRIV_CANDIDATE_PATHS,
  TMPFS_MAGIC,
} from "./host-probes.ts";

describe("resolveSetprivPath", () => {
  // runc resolves args[0] against the sandbox's own PATH, which the step can
  // override, so the absolute path is what makes this reach the real binary.
  it("returns the candidate that exists", () => {
    expect(resolveSetprivPath((p) => p === "/usr/bin/setpriv")).toBe("/usr/bin/setpriv");
  });

  it("takes the first candidate in the documented order", () => {
    expect(resolveSetprivPath((p) => p === "/bin/setpriv" || p === "/sbin/setpriv")).toBe(
      "/bin/setpriv",
    );
  });

  // run-isolated.sh has already confirmed setpriv is on root's PATH by this
  // point, so a PATH lookup is a safe last resort.
  it("falls back to a bare PATH lookup when no candidate exists", () => {
    expect(resolveSetprivPath(() => false)).toBe("setpriv");
  });

  it("looks only at the documented candidates", () => {
    const asked: string[] = [];
    resolveSetprivPath((p) => {
      asked.push(p);
      return false;
    });
    expect(asked).toStrictEqual(SETPRIV_CANDIDATE_PATHS);
  });
});

describe("shmSizeFromStatfs", () => {
  it("multiplies the block size by the block count", () => {
    expect(shmSizeFromStatfs({ type: TMPFS_MAGIC, bsize: 4096, blocks: 1024 })).toBe(4096 * 1024);
  });

  // Where /dev/shm is a plain directory rather than a mount of its own, statfs
  // answers for the containing filesystem, and sizing a tmpfs to a whole disk
  // would let a step exhaust the host's memory.
  it("returns undefined for a filesystem that is not tmpfs", () => {
    expect(shmSizeFromStatfs({ type: 0xef53, bsize: 4096, blocks: 1e9 })).toBeUndefined();
  });

  it("returns undefined when the reported size is not a usable number", () => {
    expect(shmSizeFromStatfs({ type: TMPFS_MAGIC, bsize: 4096, blocks: 0 })).toBeUndefined();
    expect(
      shmSizeFromStatfs({ type: TMPFS_MAGIC, bsize: Number.NaN, blocks: 1024 }),
    ).toBeUndefined();
  });
});

describe("parseNofileLimit", () => {
  const header = "Limit                     Soft Limit           Hard Limit           Units";

  it("reads both columns", () => {
    const limits = [
      header,
      "Max open files            1024                 65536                files",
    ].join("\n");
    expect(parseNofileLimit(limits)).toStrictEqual({ soft: 1024, hard: 65536 });
  });

  // RLIM_INFINITY cannot round-trip through JSON's number type, so
  // /proc/sys/fs/nr_open stands in as the ceiling the kernel enforces anyway.
  it("substitutes nr_open for an unlimited column", () => {
    const limits = [
      header,
      "Max open files            1024                 unlimited            files",
    ].join("\n");
    expect(parseNofileLimit(limits, 1073741816)).toStrictEqual({ soft: 1024, hard: 1073741816 });
  });

  it("returns undefined for an unlimited column with no nr_open to stand in", () => {
    const limits = [
      header,
      "Max open files            unlimited            unlimited            files",
    ].join("\n");
    expect(parseNofileLimit(limits)).toBeUndefined();
  });

  it("returns undefined when the file carries no such line", () => {
    expect(
      parseNofileLimit([header, "Max processes  1024  2048  processes"].join("\n")),
    ).toBeUndefined();
  });

  it("returns undefined for an empty dump", () => {
    expect(parseNofileLimit("")).toBeUndefined();
  });
});
