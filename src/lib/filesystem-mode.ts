import { SandboxError } from "./errors.ts";

/**
 * Lives here rather than in inputs.ts for the same reason engine.ts does:
 * sandbox/ needs the type, and keeping it beside the input reads made every
 * module that wanted only the type reach into the module that performs them.
 */
const FILESYSTEM_MODES = ["persistent", "ephemeral"] as const;
export type FilesystemMode = (typeof FILESYSTEM_MODES)[number];

/** Resolve and validate the filesystem_mode input. */
export function resolveFilesystemMode(input: string | undefined): FilesystemMode {
  const trimmed = input?.trim() || "persistent";
  if (!(FILESYSTEM_MODES as readonly string[]).includes(trimmed)) {
    throw new SandboxError(
      `Invalid filesystem_mode: ${JSON.stringify(input)}. Must be one of ${FILESYSTEM_MODES.join(", ")}.`,
      "INVALID_FILESYSTEM_MODE",
    );
  }
  return trimmed as FilesystemMode;
}
