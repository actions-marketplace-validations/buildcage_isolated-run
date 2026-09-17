import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@actions/core";

import { buildComposeDownArgs } from "#core/lib/docker/args.ts";
import { planPostCleanup } from "./lib/post-cleanup.ts";
import type { PostCleanupTargets } from "./lib/post-state.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultComposeFile = join(__dirname, "../docker/compose.action.yaml");

// Same gate as main.ts's own LOCAL_IMAGE_OVERRIDE_ENABLED — see its comment
// there. Needed here too: if main.ts started the proxy via
// BUILDCAGE_TEST_COMPOSE_FILE (this repo's own inspect-engine fixture tests)
// and the process was then killed before its own finally block ran, this
// fallback must tear down the same compose file that started it, not the
// shipped default it never used.
const LOCAL_IMAGE_OVERRIDE_ENABLED = process.env.BUILDCAGE_BUILD_TEST_HOOKS === "1";

async function stopProxyContainer({ containerName, projectName }: PostCleanupTargets) {
  const localOverride = LOCAL_IMAGE_OVERRIDE_ENABLED
    ? (await import("./core/lib/provenance/local-image-override.ts")).readLocalImageOverride(
        process.env,
      )
    : null;
  const composeFile = localOverride?.composeFile ?? defaultComposeFile;

  execFileSync("docker", buildComposeDownArgs({ composeFile, projectName }), {
    stdio: "inherit",
    env: { ...process.env, PROXY_CONTAINER_NAME: containerName },
  });
}

// Fallback-only cleanup: main.ts already stops the proxy container in its
// own finally block on every normal exit path. This only matters if the
// process was killed outright before reaching that finally (e.g. the
// runner cancels the step). State saved by main.ts's core.saveState surfaces
// here via core.getState — see
// https://docs.github.com/en/actions/creating-actions/dockerfile-support-for-github-actions#saving-state.
function main(): void {
  const targets = planPostCleanup(
    {
      containerName: core.getState("container_name"),
      ephemeralRoots: core.getState("ephemeral_overlay_roots"),
    },
    process.env,
  );
  // No catch: a failure here should crash this script the same way the
  // original synchronous execFileSync call did (an uncaught error, non-zero
  // exit) -- Node's default unhandled-rejection behavior matches that.
  if (targets) void stopProxyContainer(targets);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
