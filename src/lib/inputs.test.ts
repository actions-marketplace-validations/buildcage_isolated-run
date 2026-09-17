/**
 * Unit tests for the action's input reading and the resolvers behind it.
 *
 * Run with: vp test run src/lib/inputs.test.ts
 */
import { describe, it, expect, vi } from "vitest";

import {
  readEngineInputs,
  readFailOnBlocked,
  readFilesystemInputs,
  readKnownBlockedRules,
  readRuleInputs,
  readRunCommand,
  readStepLabel,
  resolveFilesystemMode,
  resolveWriteThroughInput,
  splitWriteThroughInput,
  validateFilesystemInputs,
} from "./inputs.ts";
import { buildACLRules, InvalidRulesError } from "#core/lib/acl/rules.ts";
import { SandboxError } from "./errors.ts";
import { RESERVED_INTERNAL_DESTINATIONS } from "./sandbox/oci-config.ts";

describe("resolveFilesystemMode", () => {
  it("defaults to persistent for undefined", () => {
    expect(resolveFilesystemMode(undefined)).toBe("persistent");
  });

  it("defaults to persistent for empty string", () => {
    expect(resolveFilesystemMode("")).toBe("persistent");
  });

  it("accepts persistent explicitly", () => {
    expect(resolveFilesystemMode("persistent")).toBe("persistent");
  });

  it("accepts ephemeral", () => {
    expect(resolveFilesystemMode("ephemeral")).toBe("ephemeral");
  });

  it("throws SandboxError with code INVALID_FILESYSTEM_MODE for an invalid value", () => {
    expect.assertions(2);
    try {
      resolveFilesystemMode("readonly");
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxError);
      expect((err as SandboxError).code).toBe("INVALID_FILESYSTEM_MODE");
    }
  });
});

describe("resolveWriteThroughInput", () => {
  const inputs = (over: Partial<Parameters<typeof resolveWriteThroughInput>[0]> = {}) => ({
    writeThrough: "",
    writable: "",
    allowWrite: "",
    ...over,
  });

  it("returns write_through: as given", () => {
    expect(resolveWriteThroughInput(inputs({ writeThrough: "/opt/cache" }))).toBe("/opt/cache");
  });

  it("accepts writable: as the pre-rename spelling", () => {
    expect(resolveWriteThroughInput(inputs({ writable: "/opt/cache" }))).toBe("/opt/cache");
  });

  it("throws FILESYSTEM_INPUT_CONFLICT when both spellings are set", () => {
    expect.assertions(2);
    try {
      resolveWriteThroughInput(inputs({ writeThrough: "/opt/a", writable: "/opt/b" }));
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxError);
      expect((err as SandboxError).code).toBe("FILESYSTEM_INPUT_CONFLICT");
    }
  });

  it("rejects the removed allow_write: input rather than ignoring it", () => {
    expect.assertions(2);
    try {
      resolveWriteThroughInput(inputs({ allowWrite: "./dist" }));
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxError);
      expect((err as SandboxError).code).toBe("ALLOW_WRITE_REMOVED");
    }
  });

  it("returns an empty string when nothing is set", () => {
    expect(resolveWriteThroughInput(inputs())).toBe("");
  });
});

describe("splitWriteThroughInput", () => {
  it("splits on newlines, trims, and drops blank lines", () => {
    expect(splitWriteThroughInput(" /opt/cache \n\n./dist\n")).toStrictEqual([
      "/opt/cache",
      "./dist",
    ]);
    expect(splitWriteThroughInput("")).toStrictEqual([]);
  });
});

describe("validateFilesystemInputs", () => {
  it("throws FILESYSTEM_INPUT_CONFLICT for write_through: / in ephemeral mode", () => {
    expect.assertions(2);
    try {
      validateFilesystemInputs("ephemeral", ["/"]);
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxError);
      expect((err as SandboxError).code).toBe("FILESYSTEM_INPUT_CONFLICT");
    }
  });

  it("finds the / sentinel among other entries, not just on its own", () => {
    expect(() => validateFilesystemInputs("ephemeral", ["./dist", "/"])).toThrow(SandboxError);
  });

  it("allows the / sentinel in persistent mode, and ordinary paths in either", () => {
    expect(() => validateFilesystemInputs("persistent", ["/"])).not.toThrow();
    expect(() => validateFilesystemInputs("persistent", ["/opt/cache"])).not.toThrow();
    expect(() => validateFilesystemInputs("ephemeral", ["./dist"])).not.toThrow();
    expect(() => validateFilesystemInputs("persistent", [])).not.toThrow();
    expect(() => validateFilesystemInputs("ephemeral", [])).not.toThrow();
  });

  it.each(RESERVED_INTERNAL_DESTINATIONS)("rejects the reserved path %s in either mode", (path) => {
    expect(() => validateFilesystemInputs("persistent", [path])).toThrow(/reserved/);
    expect(() => validateFilesystemInputs("ephemeral", [path])).toThrow(/reserved/);
  });

  // The CA paths are only really mounted by the inspect engine, but this
  // function never sees the engine: an input accepted under one engine and
  // refused under another would be worse than refusing it everywhere.
  it("rejects a path under a reserved one", () => {
    expect(() => validateFilesystemInputs("persistent", ["/etc/resolv.conf/x"])).toThrow(
      /reserved/,
    );
  });

  it("allows a directory containing a reserved path, which the reserved mount is layered over", () => {
    expect(() => validateFilesystemInputs("persistent", ["/etc"])).not.toThrow();
    expect(() => validateFilesystemInputs("ephemeral", ["/etc/ssl/certs"])).not.toThrow();
  });

  it("names the offending entry and the reserved path it collides with", () => {
    expect(() => validateFilesystemInputs("persistent", ["/etc/resolv.conf"])).toThrow(
      /"\/etc\/resolv\.conf"/,
    );
  });
});

describe("buildACLRules", () => {
  it("parses whitespace-separated HTTPS rules", () => {
    const { httpsRules } = buildACLRules({
      httpsRulesInput: "example.com:443 *.cdn.example.com:443",
      httpRulesInput: "",
      ipRulesInput: "",
    });
    expect(httpsRules).toStrictEqual(["example.com:443", "*.cdn.example.com:443"]);
  });

  it("handles newline-separated rules", () => {
    const { httpsRules } = buildACLRules({
      httpsRulesInput: "a.com:443\nb.com:443",
      httpRulesInput: "",
      ipRulesInput: "",
    });
    expect(httpsRules).toStrictEqual(["a.com:443", "b.com:443"]);
  });

  it("returns empty arrays for empty/undefined inputs", () => {
    const result = buildACLRules({
      httpsRulesInput: "",
      httpRulesInput: undefined,
      ipRulesInput: "   ",
    });
    expect(result.httpsRules).toStrictEqual([]);
    expect(result.httpRules).toStrictEqual([]);
    expect(result.ipRules).toStrictEqual([]);
  });

  it("throws InvalidRulesError with code INVALID_RULES for invalid rule syntax", () => {
    expect.assertions(2);
    try {
      buildACLRules({
        httpsRulesInput: "no-port-specified",
        httpRulesInput: "",
        ipRulesInput: "",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidRulesError);
      expect((err as InvalidRulesError).code).toBe("INVALID_RULES");
    }
  });
});

describe("readKnownBlockedRules", () => {
  it("parses whitespace-separated rules", () => {
    expect(readKnownBlockedRules("known-bad.example.com:443 *.noisy.example.com:80")).toStrictEqual(
      ["known-bad.example.com:443", "*.noisy.example.com:80"],
    );
  });

  it("returns an empty array for empty/undefined input", () => {
    expect(readKnownBlockedRules(undefined)).toStrictEqual([]);
    expect(readKnownBlockedRules("")).toStrictEqual([]);
  });

  it("reads a rule that names no port as any port", () => {
    // A refused name has no port at all, so requiring one here would mean
    // writing a port that was never involved.
    expect(readKnownBlockedRules("_mongodb._tcp.c0.example.net")).toStrictEqual([
      "_mongodb._tcp.c0.example.net:*",
    ]);
  });

  it("throws InvalidRulesError with code INVALID_RULES for invalid rule syntax", () => {
    expect.assertions(2);
    try {
      readKnownBlockedRules("a*b.example.com:443");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidRulesError);
      expect((err as InvalidRulesError).code).toBe("INVALID_RULES");
    }
  });
});

// ---------------------------------------------------------------------------
// The input reads themselves
// ---------------------------------------------------------------------------

/** Stands in for core.getInput, which returns "" for anything unset. */
function inputs(values: Record<string, string> = {}): (name: string) => string {
  return (name) => values[name] ?? "";
}

describe("readRunCommand", () => {
  it("returns the run script as given", () => {
    expect(readRunCommand(inputs({ run: "npm ci" }))).toBe("npm ci");
  });

  // Read untrimmed, so a heredoc or an indented block survives intact.
  it("keeps leading and trailing whitespace", () => {
    expect(readRunCommand(inputs({ run: "  npm ci\n" }))).toBe("  npm ci\n");
  });

  it("rejects an absent run input", () => {
    expect(() => readRunCommand(inputs())).toThrow(/'run' is required/);
  });

  it("rejects a run input that is only whitespace", () => {
    expect(() => readRunCommand(inputs({ run: "  \n\t" }))).toThrow(/'run' is required/);
  });
});

describe("readEngineInputs", () => {
  it("defaults to universal when unset", () => {
    expect(readEngineInputs(inputs())).toStrictEqual({ proxyEngine: "universal" });
  });

  it("passes the input through resolveProxyEngine", () => {
    expect(readEngineInputs(inputs({ proxy_engine: "inspect" }))).toStrictEqual({
      proxyEngine: "inspect",
    });
  });

  it("rejects an unknown engine", () => {
    expect(() => readEngineInputs(inputs({ proxy_engine: "nope" }))).toThrow(
      /Invalid proxy_engine/,
    );
  });
});

describe("readFilesystemInputs", () => {
  it("defaults to persistent with no write_through entries", () => {
    expect(readFilesystemInputs(inputs())).toStrictEqual({
      filesystemMode: "persistent",
      writeThroughInput: "",
    });
  });

  it("reads both inputs together", () => {
    expect(
      readFilesystemInputs(inputs({ filesystem_mode: "ephemeral", write_through: "/tmp/out" })),
    ).toStrictEqual({ filesystemMode: "ephemeral", writeThroughInput: "/tmp/out" });
  });

  it("still accepts the old writable: spelling", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(readFilesystemInputs(inputs({ writable: "/tmp/out" })).writeThroughInput).toBe(
        "/tmp/out",
      );
    } finally {
      log.mockRestore();
    }
  });

  it("rejects the removed allow_write: input", () => {
    expect(() => readFilesystemInputs(inputs({ allow_write: "/tmp/out" }))).toThrow(
      /allow_write: has been replaced/,
    );
  });
});

describe("readRuleInputs", () => {
  it("defaults proxy_mode to restrict", () => {
    expect(readRuleInputs(inputs()).proxyMode).toBe("restrict");
  });

  it("returns empty rule lists when nothing is set", () => {
    expect(readRuleInputs(inputs())).toStrictEqual({
      proxyMode: "restrict",
      httpsRules: [],
      httpRules: [],
      ipRules: [],
      urlRules: [],
      tlsRules: [],
      knownBlockedRules: [],
    });
  });

  it("parses every rule kind", () => {
    const parsed = readRuleInputs(
      inputs({
        proxy_mode: "audit",
        allowed_https_rules: "a.example.com:443",
        allowed_http_rules: "b.example.com:80",
        allowed_ip_rules: "10.0.0.5:5432",
        allowed_tls_rules: "db.example.com:443",
        allowed_url_rules: "GET https://a.example.com/pkg.json",
        known_blocked_rules: "*.sury.org:*",
      }),
    );
    expect(parsed).toStrictEqual({
      proxyMode: "audit",
      httpsRules: ["a.example.com:443"],
      httpRules: ["b.example.com:80"],
      ipRules: ["10.0.0.5:5432"],
      urlRules: ["GET https://a.example.com/pkg.json"],
      tlsRules: ["db.example.com:443"],
      knownBlockedRules: ["*.sury.org:*"],
    });
  });

  it("rejects a malformed rule rather than passing it to the proxy", () => {
    expect(() => readRuleInputs(inputs({ allowed_https_rules: "no-port" }))).toThrow();
  });

  // Compiled at startup on both engines, even the one that ignores them, so a
  // typo fails here rather than silently doing nothing inside the sandbox.
  it("rejects a malformed URL rule even though only inspect enforces one", () => {
    expect(() => readRuleInputs(inputs({ allowed_url_rules: "GET not-a-url" }))).toThrow();
  });
});

describe("readStepLabel", () => {
  it("returns the label when set", () => {
    expect(readStepLabel(inputs({ label: "install" }))).toBe("install");
  });

  it("returns undefined rather than an empty string when unset", () => {
    expect(readStepLabel(inputs())).toBeUndefined();
  });
});

describe("readFailOnBlocked", () => {
  it("returns what the input says", () => {
    expect(readFailOnBlocked(() => false)).toBe(false);
    expect(readFailOnBlocked(() => true)).toBe(true);
  });

  // The integration scripts run this action without action.yml's defaults, so
  // getBooleanInput throws on the unset input rather than returning one.
  it("falls back to action.yml's own default when the input is absent", () => {
    expect(
      readFailOnBlocked(() => {
        throw new Error("Input required and not supplied: fail_on_blocked");
      }),
    ).toBe(true);
  });
});
