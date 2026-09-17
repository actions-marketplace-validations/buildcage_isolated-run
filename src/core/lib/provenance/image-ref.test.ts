import { describe, it, expect } from "vitest";
import { resolveBuildcageImageRef } from "./image-ref.ts";

describe("resolveBuildcageImageRef", () => {
  it("pins the image by digest rather than by tag", () => {
    expect(
      resolveBuildcageImageRef({
        imageDigest: "sha256:0123456789abcdef",
        actionRepository: "buildcage/isolated-run",
      }),
    ).toBe("ghcr.io/buildcage/isolated-run@sha256:0123456789abcdef");
  });

  it("lowercases the repository, since GitHub preserves owner/repo case but GHCR does not accept it", () => {
    expect(
      resolveBuildcageImageRef({
        imageDigest: "sha256:0123456789abcdef",
        actionRepository: "BuildCage/Isolated-Run",
      }),
    ).toBe("ghcr.io/buildcage/isolated-run@sha256:0123456789abcdef");
  });
});
