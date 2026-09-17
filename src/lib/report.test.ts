import { describe, it, expect, beforeEach, vi } from "vitest";

// readActionVersion's only external call is `docker inspect` via the shared
// client, so the client is what gets replaced here.
const docker = vi.hoisted(() => ({ readLabels: vi.fn() }));
vi.mock("#core/lib/docker/client.ts", () => ({ createDocker: () => docker }));

import {
  computeReportOutcome,
  readActionVersion,
  type ComputeReportOutcomeOptions,
} from "./report.ts";
import { annotateKnownBlocked } from "#core/lib/report/build/aggregate.ts";
import type { GenReportParameters, UniversalReportData } from "#core/lib/report/types.ts";

function parameters(overrides: Partial<GenReportParameters> = {}): GenReportParameters {
  return {
    mode: "restrict",
    allowedHttpsRules: [],
    allowedHttpRules: [],
    allowedIpRules: [],
    allowedTlsRules: [],
    knownBlockedRules: [],
    ...overrides,
  };
}

function options(
  overrides: Partial<ComputeReportOutcomeOptions> = {},
): ComputeReportOutcomeOptions {
  return { actionRepo: "buildcage/isolated-run", actionRef: "v1", ...overrides };
}

// blocked rows are already expected to be annotated by the time a Report
// reaches computeReportOutcome — this mirrors that, applying
// parameters.knownBlockedRules the same way. computeReportOutcome only ever
// touches ReportDataCommon fields, so a universal-shaped fixture exercises
// it just as well as an inspect-shaped one would.
function report(overrides: Partial<UniversalReportData> = {}): UniversalReportData {
  const params = overrides.parameters ?? parameters();
  return {
    engine: "universal",
    parameters: params,
    passed: [],
    blocked: [],
    blockedCount: 0,
    logLooksPlausible: true,
    ...overrides,
  };
}

// The decision matrix itself is tested elsewhere; these only verify
// shouldFail and the rendered markdown combine correctly.
// The decision matrix itself is tested elsewhere; these only verify
// shouldFail and the rendered markdown combine correctly. Markdown content
// itself is covered by render-report-markdown.test.ts, which
// computeReportOutcome delegates to.
describe("computeReportOutcome", () => {
  it("does not fail when there are no blocked connections", () => {
    const r = report({ blockedCount: 0 });
    expect(computeReportOutcome(r, options({ failOnBlocked: true })).shouldFail).toBe(false);
  });

  it("fails when blocked connections are detected and failOnBlocked is true", () => {
    const r = report({
      blockedCount: 2,
      blocked: annotateKnownBlocked(
        [
          {
            host: "bad.example.com",
            port: "443",
            ruleType: "HTTPS",
            reason: "not in allowlist",
            count: 2,
          },
        ],
        [],
      ),
    });
    expect(computeReportOutcome(r, options({ failOnBlocked: true })).shouldFail).toBe(true);
  });

  // Audit's outcome never depends on known_blocked_rules matching, so the
  // notice text shouldn't either.
  it("audit-mode notice text stays fixed even when known_blocked_rules matches every blocked connection", () => {
    const knownBlockedRules = ["known-bad.example.com:443"];
    const r = report({
      parameters: parameters({ mode: "audit", knownBlockedRules }),
      blockedCount: 2,
      blocked: annotateKnownBlocked(
        [{ host: "known-bad.example.com", port: "443", ruleType: "HTTPS", reason: "-", count: 2 }],
        knownBlockedRules,
      ),
    });
    const outcome = computeReportOutcome(r, options({ failOnBlocked: true }));
    expect(outcome.level).toBe("notice");
    expect(outcome.message).toBe("2 blocked connection(s) detected by buildcage sandbox");
  });

  it("passes stepLabel/runCommand through to the rendered markdown", () => {
    const r = report({
      parameters: parameters({ mode: "audit" }),
      passed: [
        { host: "registry.npmjs.org", port: "443", ruleType: "HTTPS", reason: "-", count: 3 },
      ],
    });
    const { markdown } = computeReportOutcome(
      r,
      options({ stepLabel: "npm install", runCommand: "npm install" }),
    );
    expect(markdown).toMatch(/^## Outbound Traffic Report — npm install \(audit mode\)/);
    expect(markdown).toMatch(/uses: buildcage\/isolated-run@v1/);
    expect(markdown).toMatch(/run: \|\n\s+npm install/);
  });
});

describe("readActionVersion", () => {
  const containerName = "buildcage-proxy-abcd1234";

  beforeEach(() => {
    docker.readLabels.mockReset();
  });

  it("turns the image's bare version label back into its git tag", () => {
    docker.readLabels.mockReturnValueOnce({ "org.opencontainers.image.version": "3.1.4" });
    expect(readActionVersion(containerName, "universal")).toBe("v3.1.4");
  });

  // A non-universal engine publishes as `<version>-<engine>`, which is a Docker
  // tag rather than anything that was ever released under that name.
  it("strips the engine suffix a non-universal image carries", () => {
    docker.readLabels.mockReturnValueOnce({ "org.opencontainers.image.version": "3.1.4-inspect" });
    expect(readActionVersion(containerName, "inspect")).toBe("v3.1.4");
  });

  it("leaves a label alone when it does not end in the engine being asked about", () => {
    docker.readLabels.mockReturnValueOnce({ "org.opencontainers.image.version": "3.1.4-inspect" });
    expect(readActionVersion(containerName, "universal")).toBe("v3.1.4-inspect");
  });

  it("returns undefined when the image carries no version label", () => {
    docker.readLabels.mockReturnValueOnce({});
    expect(readActionVersion(containerName, "universal")).toBeUndefined();
  });

  // The version only decorates one comment in the report, so a docker failure
  // here must not take the whole report down with it.
  it("returns undefined rather than throwing when docker inspect fails", () => {
    docker.readLabels.mockImplementationOnce(() => {
      throw new Error("No such container");
    });
    expect(readActionVersion(containerName, "universal")).toBeUndefined();
  });
});
