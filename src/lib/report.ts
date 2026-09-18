import { appendFileSync } from "node:fs";

import type { Annotation } from "#core/lib/actions/annotation.ts";
import { writeStepSummary } from "#core/lib/actions/write-step-summary.ts";
import { createDocker, type Docker } from "#core/lib/docker/client.ts";
import { readRotatedLog } from "#core/lib/docker/rotated-log.ts";
import { describeBlockedOutcome } from "#core/lib/report/outcome/blocked-outcome.ts";
import { renderReportMarkdown } from "#core/lib/report/render/render-report-markdown.ts";
import { truncateForStepSummary } from "#core/lib/report/render/truncate-communication-details.ts";
import { buildUniversalReportData } from "#core/lib/report/build/universal.ts";
import { buildInspectReportData } from "#core/lib/report/build/inspect.ts";
import { applyOutcomeAnnotation } from "#core/lib/report/outcome/annotate.ts";
import type { GenReportParameters, ReportData } from "#core/lib/report/types.ts";
import type { ProxyEngine } from "./engine.ts";

export type Report = ReportData;
export type { ProxyEngine };

const HAPROXY_LOG_DIR = "/var/log/haproxy";
/** inspect-only: the resolver's own log, the sole trace of a name that was
 *  only looked up and never connected to. */
const COREDNS_LOG_DIR = "/var/log/coredns";

/**
 * This action has no version-skew concern of its own (one pinned version
 * end to end, unlike a separately-versioned report action), so it fetches
 * the raw log(s) and calls the shared builder in-process. Which log(s) to
 * read and which builder to call depends on which proxy image ran --
 * inspect's has a second (CoreDNS) log the universal image does not.
 */
// Untested by design: the log reader and both builders are tested directly.
/* v8 ignore start */
export function fetchReport(
  containerName: string,
  parameters: GenReportParameters,
  proxyEngine: ProxyEngine,
): Promise<Report> {
  const docker = createDocker();
  if (proxyEngine === "inspect") {
    return buildInspectReportData(
      readRotatedLog(docker, containerName, HAPROXY_LOG_DIR),
      readRotatedLog(docker, containerName, COREDNS_LOG_DIR),
      parameters,
    );
  }
  return buildUniversalReportData(
    readRotatedLog(docker, containerName, HAPROXY_LOG_DIR),
    parameters,
  );
}
/* v8 ignore stop */

/**
 * Best-effort `org.opencontainers.image.version` label read, converted back
 * into the `vX.Y.Z` git tag it was published from (the label itself is the
 * bare Docker tag, e.g. `3.1.4-inspect` for a non-universal engine — see
 * image-tag.ts). A `docker inspect` failure here must not fail the report
 * over one comment.
 */
export function readActionVersion(
  containerName: string,
  proxyEngine: ProxyEngine,
  docker?: Docker,
): string | undefined {
  // Untested by design: the default behind the seam, which only builds the
  // client the tested caller would otherwise hand in.
  /* v8 ignore next */
  const client = docker ?? createDocker();
  try {
    const label = client.readLabels(containerName)["org.opencontainers.image.version"];
    if (!label) return undefined;
    const suffix = `-${proxyEngine}`;
    const version = label.endsWith(suffix) ? label.slice(0, -suffix.length) : label;
    return `v${version}`;
  } catch {
    return undefined;
  }
}

export interface ComputeReportOutcomeOptions {
  stepLabel?: string;
  actionRepo: string;
  actionRef: string;
  runCommand?: string;
  actionVersion?: string;
  failOnBlocked?: boolean;
}

export interface ReportOutcome {
  markdown: string;
  message: string;
  level: "none" | "notice" | "error";
  shouldFail: boolean;
}

/**
 * Pure decision + rendering step, kept free of process.env/file I/O so it's
 * testable without touching the filesystem — writeReportSummary below is the
 * side-effecting half (actual summary/annotation output).
 */
export function computeReportOutcome(
  report: Report,
  {
    stepLabel,
    failOnBlocked,
    actionRepo,
    actionRef,
    runCommand,
    actionVersion,
  }: ComputeReportOutcomeOptions,
): ReportOutcome {
  const { level, message, shouldFail } = describeBlockedOutcome({
    isAudit: report.parameters.mode === "audit",
    failOnBlocked: failOnBlocked ?? false,
    blockedCount: report.blockedCount,
    blockedRows: report.blocked,
    logLooksPlausible: report.logLooksPlausible,
    engineLabel: "sandbox",
  });
  const markdown = renderReportMarkdown(report, actionRepo, actionRef, {
    title: stepLabel ? `Outbound Traffic Report — ${stepLabel}` : undefined,
    runCommand,
    actionVersion,
  });

  return { markdown, message, level, shouldFail };
}

/** The one write this module makes that isn't the Job Summary; injected for
 *  the same reason the Docker client and the Annotation are. */
export interface WriteReportSummaryDeps {
  appendFile?: (path: string, content: string) => void;
}

/**
 * Side-effecting half of the report step: computeReportOutcome() decides
 * what to say, this writes it to the Job Summary/annotations/exit code.
 * `artifactAvailable` only affects the wording of a truncation notice if the
 * report turns out to be too large for GitHub's own per-step limit -- it
 * does not gate whether truncation happens.
 *
 * Both destinations come from `env` rather than being read here, so a test
 * decides where the summary goes the same way the runner does.
 */
export async function writeReportSummary(
  report: Report,
  annotation: Annotation,
  options: ComputeReportOutcomeOptions,
  artifactAvailable: boolean,
  env: NodeJS.ProcessEnv,
  { appendFile = appendFileSync }: WriteReportSummaryDeps = {},
): Promise<void> {
  const outcome = computeReportOutcome(report, options);

  await writeStepSummary(
    truncateForStepSummary(outcome.markdown, artifactAvailable),
    env.GITHUB_STEP_SUMMARY,
  );

  // Debug-only mirror: GITHUB_STEP_SUMMARY is unique per step and can't be
  // reassigned, so a later step has no way to read this step's copy back.
  // This repo's own integration assertions read it instead -- see
  // test/assert-sandbox.sh.
  const debugSummaryFile = env.BUILDCAGE_RUN_DEBUG_SUMMARY_FILE;
  if (debugSummaryFile) {
    appendFile(debugSummaryFile, outcome.markdown);
  }

  applyOutcomeAnnotation(annotation, outcome);
}
