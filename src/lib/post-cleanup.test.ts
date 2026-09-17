import { describe, it, expect, vi } from "vitest";

import { planPostCleanup, type PostCleanupDeps } from "./post-cleanup.ts";
import { scratchDirFor } from "./sandbox/scratch-dir.ts";

const CONTAINER = "buildcage-proxy-deadbeef";
const STATE = { containerName: CONTAINER, ephemeralRoots: "" };

/** A real Actions step's environment, which ownerToken hashes into a token. */
const ENV = {
  GITHUB_RUN_ID: "1",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_JOB: "build",
  GITHUB_ACTION: "buildcage",
};
const OWNER = "1/1/build/buildcage";

function deps(overrides: PostCleanupDeps = {}): {
  deps: PostCleanupDeps;
  removed: { dir: string; ephemeralRoots?: string[] }[];
} {
  const removed: { dir: string; ephemeralRoots?: string[] }[] = [];
  return {
    removed,
    deps: {
      readOwner: () => OWNER,
      fileExists: () => true,
      removeScratchDir: (dir, ephemeralRoots) => removed.push({ dir, ephemeralRoots }),
      ...overrides,
    },
  };
}

describe("planPostCleanup", () => {
  it("reclaims the scratch dir and hands back the container to stop", () => {
    const { deps: d, removed } = deps();

    const targets = planPostCleanup(STATE, ENV, d);

    expect(targets).toStrictEqual({
      containerName: CONTAINER,
      projectName: expect.any(String) as string,
    });
    expect(removed).toStrictEqual([{ dir: scratchDirFor(CONTAINER), ephemeralRoots: undefined }]);
  });

  it("passes the ephemeral roots on, so the discarded writes can be logged", () => {
    const { deps: d, removed } = deps();

    planPostCleanup({ ...STATE, ephemeralRoots: '["/usr","/etc"]' }, ENV, d);

    expect(removed[0].ephemeralRoots).toStrictEqual(["/usr", "/etc"]);
  });

  it("does nothing at all when main.ts was never reached", () => {
    const { deps: d, removed } = deps();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(planPostCleanup({ containerName: "", ephemeralRoots: "" }, ENV, d)).toBeNull();
    expect(removed).toStrictEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it("reports a state value this action could not have written, and stops", () => {
    const { deps: d, removed } = deps();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const targets = planPostCleanup({ containerName: "/etc", ephemeralRoots: "" }, ENV, d);

    expect(targets).toBeNull();
    expect(removed).toStrictEqual([]);
    expect(log.mock.calls[0][0]).toContain("::error::run post-cleanup:");
  });

  it("tears down nothing when the container belongs to a different step", () => {
    const { deps: d, removed } = deps({ readOwner: () => "9/1/other/buildcage" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(planPostCleanup(STATE, ENV, d)).toBeNull();
    expect(removed).toStrictEqual([]);
    expect(log.mock.calls[0][0]).toContain("was started by a different step");
  });

  it("treats a name with no container left behind as this step's leftovers", () => {
    const { deps: d, removed } = deps({ readOwner: () => null });

    expect(planPostCleanup(STATE, ENV, d)).not.toBeNull();
    expect(removed).toHaveLength(1);
  });

  it("leaves nothing to remove when the scratch dir is already gone", () => {
    const { deps: d, removed } = deps({ fileExists: () => false });

    expect(planPostCleanup(STATE, ENV, d)).not.toBeNull();
    expect(removed).toStrictEqual([]);
  });

  it("still stops the container when the scratch dir cannot be removed", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { deps: d } = deps({
      removeScratchDir: () => {
        throw new Error("device or resource busy");
      },
    });

    expect(planPostCleanup(STATE, ENV, d)).not.toBeNull();
    expect(log).toHaveBeenCalledWith(
      "::warning::run post-cleanup: failed to remove sandbox scratch dir: device or resource busy",
    );
  });

  it("lets a docker failure through, since ownership cannot be established", () => {
    const { deps: d } = deps({
      readOwner: () => {
        throw new Error("docker daemon is not running");
      },
    });

    expect(() => planPostCleanup(STATE, ENV, d)).toThrow("docker daemon is not running");
  });
});
