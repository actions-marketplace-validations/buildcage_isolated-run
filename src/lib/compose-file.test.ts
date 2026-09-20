import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  DEFAULT_COMPOSE_FILE,
  readLocalImageOverride,
  resolveComposeFile,
} from "./compose-file.ts";

describe("resolveComposeFile", () => {
  it("uses the shipped compose file when there is no override", () => {
    expect(resolveComposeFile(null)).toBe(DEFAULT_COMPOSE_FILE);
  });

  // An override without BUILDCAGE_TEST_COMPOSE_FILE set: the image is
  // replaced, the compose file that starts it is not.
  it("uses the shipped compose file when the override names none", () => {
    expect(
      resolveComposeFile({ imageRef: "local:dev", pullPolicy: "never", composeFile: undefined }),
    ).toBe(DEFAULT_COMPOSE_FILE);
  });

  it("uses the override's compose file when it names one", () => {
    expect(
      resolveComposeFile({
        imageRef: "local:dev",
        pullPolicy: "never",
        composeFile: "/repo/test/compose.test-inspect.yaml",
      }),
    ).toBe("/repo/test/compose.test-inspect.yaml");
  });
});

describe("readLocalImageOverride", () => {
  let previousHooks: string | undefined;

  beforeEach(() => {
    previousHooks = process.env.BUILDCAGE_BUILD_TEST_HOOKS;
  });

  afterEach(() => {
    if (previousHooks === undefined) delete process.env.BUILDCAGE_BUILD_TEST_HOOKS;
    else process.env.BUILDCAGE_BUILD_TEST_HOOKS = previousHooks;
  });

  // The published action is built without the flag, which is what lets
  // rolldown drop the override module from dist entirely.
  it("reads nothing without the build-time flag, whatever the runtime env says", async () => {
    delete process.env.BUILDCAGE_BUILD_TEST_HOOKS;

    expect(await readLocalImageOverride({ BUILDCAGE_LOCAL_IMAGE_REF: "local:dev" })).toBeNull();
  });

  it("reads the override from the given env in a test-hooks build", async () => {
    process.env.BUILDCAGE_BUILD_TEST_HOOKS = "1";
    const log = vi.fn();

    expect(
      await readLocalImageOverride(
        {
          BUILDCAGE_LOCAL_IMAGE_REF: "local:dev",
          BUILDCAGE_TEST_COMPOSE_FILE: "/repo/test/compose.test-inspect.yaml",
        },
        log,
      ),
    ).toStrictEqual({
      imageRef: "local:dev",
      pullPolicy: "never",
      composeFile: "/repo/test/compose.test-inspect.yaml",
    });
    // Skipping provenance verification is the one thing a reader of the log
    // must not have to infer.
    expect(log.mock.calls[0][0]).toContain("skipping image provenance verification");
  });

  it("reads nothing, and says nothing, when the flag is set but the env names no image", async () => {
    process.env.BUILDCAGE_BUILD_TEST_HOOKS = "1";
    const log = vi.fn();

    expect(await readLocalImageOverride({}, log)).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });
});
