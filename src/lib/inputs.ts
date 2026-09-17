/**
 * Every `core.getInput` this action makes, and the resolvers that turn those
 * strings into validated values, in one place — so what the action reads is
 * answerable from one file rather than by grepping the entry point.
 *
 * Read in several calls rather than one because main() needs them at
 * different points: the engine before it resolves the image, the filesystem
 * inputs before the privileged preflight checks, the rules only after the
 * image is verified. Folding them together would reorder validation against
 * those steps and change which error a run with more than one problem reports.
 */
import * as core from "@actions/core";

import {
  buildACLRules,
  parseKnownBlockedRulesOrThrow,
  parseRulesOrThrow,
} from "#core/lib/acl/rules.ts";
import { buildUrlRules } from "#core/lib/acl/url-rules.ts";
import { SandboxError } from "./errors.ts";
import { resolveProxyEngine, type ProxyEngine } from "./engine.ts";
import { isAtOrUnder } from "./sandbox/paths.ts";
import { RESERVED_INTERNAL_DESTINATIONS } from "./sandbox/oci-config.ts";
import { WRITE_THROUGH_ALL } from "./sandbox/write-through.ts";

/** Narrowed to what this module needs, so a test can pass a plain lookup. */
export type GetInput = (name: string, options?: { trimWhitespace?: boolean }) => string;
export type GetBooleanInput = (name: string) => boolean;

export function readKnownBlockedRules(input: string | undefined): string[] {
  return parseKnownBlockedRulesOrThrow(input);
}

export interface WriteThroughInputs {
  writeThrough: string;
  /** Pre-rename spelling of write_through, still accepted. */
  writable: string;
  /** Removed input, only read so it can be rejected with a migration hint. */
  allowWrite: string;
}

/**
 * Pick the effective write_through: input. `writable:` is the same input under
 * its old name and still works; `allow_write:` (the ephemeral-only input this
 * replaced) is rejected rather than ignored, since ignoring it would silently
 * discard writes the step asked to keep.
 */
export function resolveWriteThroughInput({
  writeThrough,
  writable,
  allowWrite,
}: WriteThroughInputs): string {
  if (allowWrite.trim()) {
    throw new SandboxError(
      "allow_write: has been replaced by write_through:, which covers both filesystem modes. " +
        "Rename the input -- the path syntax is unchanged.",
      "ALLOW_WRITE_REMOVED",
    );
  }
  if (writeThrough.trim() && writable.trim()) {
    throw new SandboxError(
      "write_through: and writable: are the same input under two names. Set only write_through:.",
      "FILESYSTEM_INPUT_CONFLICT",
    );
  }
  if (!writeThrough.trim() && writable.trim()) {
    console.log(
      "::notice::writable: is now called write_through:; writable: still works, but consider updating to write_through:.",
    );
    return writable;
  }
  return writeThrough;
}

const FILESYSTEM_MODES = ["persistent", "ephemeral"] as const;
export type FilesystemMode = (typeof FILESYSTEM_MODES)[number];

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

/** The write_through: input as bare lines, for the pre-resolution check in
 *  main(). Resolution proper (variables, ~/, relative paths) is
 *  resolveWriteThroughPaths' job. */
export function splitWriteThroughInput(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Validates write_through: paths against the filesystem mode. Pure, no I/O --
 * deliberately called on its own, ahead of
 * checkPasswordlessSudo()/checkOverlayfsSupport() in main(), so a plain input
 * mistake is rejected immediately rather than only after those privileged
 * preflight checks have already run. That early call passes the raw lines;
 * resolveFilesystemPlan calls it again on the resolved paths, which is the
 * authoritative one. Both see the same sentinel: resolveWriteThroughEntry
 * rejects a spelling that merely normalizes to "/", so only a literal one
 * reaches either call.
 */
export function validateFilesystemInputs(
  filesystemMode: FilesystemMode,
  writeThroughPaths: string[],
): void {
  if (filesystemMode === "ephemeral" && writeThroughPaths.includes(WRITE_THROUGH_ALL)) {
    throw new SandboxError(
      "write_through: / drops the read-only restriction wholesale, which has no meaning in " +
        "filesystem_mode: ephemeral -- it would persist every write, the one thing that mode exists " +
        "to prevent. List the paths that must survive instead.",
      "FILESYSTEM_INPUT_CONFLICT",
    );
  }

  for (const path of writeThroughPaths) {
    const reserved = RESERVED_INTERNAL_DESTINATIONS.find((r) => isAtOrUnder(path, r));
    if (reserved) {
      throw new SandboxError(
        `write_through entry ${JSON.stringify(path)} is reserved: the sandbox mounts ${JSON.stringify(reserved)} ` +
          "itself for the proxy's DNS and CA trust, last of all, so the entry would have no effect. " +
          "Name a containing directory instead to persist writes around it.",
        "FILESYSTEM_INPUT_CONFLICT",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The input reads themselves
// ---------------------------------------------------------------------------

/** The `run:` script. Read untrimmed: leading indentation is part of it. */
export function readRunCommand(getInput: GetInput = core.getInput): string {
  const runInput = getInput("run", { trimWhitespace: false });
  if (!runInput.trim()) {
    throw new SandboxError("Input 'run' is required.", "MISSING_RUN");
  }
  return runInput;
}

export interface EngineInputs {
  proxyEngine: ProxyEngine;
}

export function readEngineInputs(getInput: GetInput = core.getInput): EngineInputs {
  return { proxyEngine: resolveProxyEngine(getInput("proxy_engine")) };
}

export interface FilesystemInputs {
  filesystemMode: FilesystemMode;
  /** The effective write_through: text, one entry per line, unresolved. */
  writeThroughInput: string;
}

export function readFilesystemInputs(getInput: GetInput = core.getInput): FilesystemInputs {
  return {
    filesystemMode: resolveFilesystemMode(getInput("filesystem_mode")),
    writeThroughInput: resolveWriteThroughInput({
      writeThrough: getInput("write_through"),
      writable: getInput("writable"),
      allowWrite: getInput("allow_write"),
    }),
  };
}

export interface ParsedRuleInputs {
  proxyMode: string;
  httpsRules: string[];
  httpRules: string[];
  ipRules: string[];
  /** The raw text of each compiled URL rule, not the compiled form: only the
   *  proxy re-compiles them, and only inspect enforces them. */
  urlRules: string[];
  tlsRules: string[];
  knownBlockedRules: string[];
}

/**
 * Parse and validate every rule input.
 *
 * URL and TLS rules are compiled here even on the engine that ignores them,
 * purely so a typo fails at startup rather than silently inside the sandbox.
 *
 * The statement order is the order a malformed-rule error surfaces in, so it
 * is deliberate rather than incidental.
 *
 * @throws {InvalidRulesError} if any rule is malformed
 */
export function readRuleInputs(getInput: GetInput = core.getInput): ParsedRuleInputs {
  const proxyMode = getInput("proxy_mode") || "restrict";
  const rules = buildACLRules({
    httpsRulesInput: getInput("allowed_https_rules"),
    httpRulesInput: getInput("allowed_http_rules"),
    ipRulesInput: getInput("allowed_ip_rules"),
  });
  const knownBlockedRules = readKnownBlockedRules(getInput("known_blocked_rules"));
  const urlRulesInput = getInput("allowed_url_rules");
  const tlsRules = parseRulesOrThrow(getInput("allowed_tls_rules"));
  const urlRules = buildUrlRules(urlRulesInput).map((r) => r.raw);

  return {
    proxyMode,
    httpsRules: rules.httpsRules,
    httpRules: rules.httpRules,
    ipRules: rules.ipRules,
    urlRules,
    tlsRules,
    knownBlockedRules,
  };
}

/** The optional `label:`, which only titles the report heading. */
export function readStepLabel(getInput: GetInput = core.getInput): string | undefined {
  return getInput("label") || undefined;
}

/**
 * Several integration scripts invoke this action directly without setting
 * fail_on_blocked, unlike a real workflow where action.yml's own default
 * always supplies it — fall back to that same default.
 */
export function readFailOnBlocked(
  getBooleanInput: GetBooleanInput = core.getBooleanInput,
): boolean {
  try {
    return getBooleanInput("fail_on_blocked");
  } catch {
    return true;
  }
}
