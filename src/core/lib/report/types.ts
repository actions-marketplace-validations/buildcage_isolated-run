import type { HostTableRow } from "./render/host-table.ts";
import type { AnnotatedBlockedRow } from "./build/aggregate.ts";
import type { TrafficEvent } from "../log/traffic-event.ts";

/** Echoed back verbatim rather than re-derived — only the container's own
 *  env (or, for run, its own action input) reflects what was configured. */
export interface GenReportParameters {
  mode: string;
  allowedHttpsRules: string[];
  allowedHttpRules: string[];
  allowedIpRules: string[];
  allowedTlsRules: string[];
  /** Also drives whether the "Expected" column is shown (length > 0). */
  knownBlockedRules: string[];
}

export interface ReportDataCommon {
  parameters: GenReportParameters;

  /** restrict mode's allowed traffic or audit mode's audited traffic —
   *  which heading applies is decided from parameters.mode. */
  passed: HostTableRow[];

  /** Aggregated blocked-domain rows, already annotated against
   *  knownBlockedRules. Can be non-empty even in audit mode. */
  blocked: AnnotatedBlockedRow[];

  /** Raw blocked-event count — can differ from blocked.length for the
   *  universal engine (pre-aggregation log line count). */
  blockedCount: number;

  /** False iff the log is not a complete record of the run: its beginning is
   *  gone or it never carried a trace of a real one, or a decision line could
   *  not be read (haproxy.ts's logHeadIntact and unparsed). Anything written
   *  from this flag has to name both, since it no longer says which applied.
   *  The report fails closed rather than passing off what survived as
   *  everything. */
  logLooksPlausible: boolean;
}

export interface UniversalReportData extends ReportDataCommon {
  engine: "universal";
}

/** The inspect engine decrypts, so it has the method and full URL of every
 *  request, refused ones included. Nothing is attributable to a RUN step: the
 *  proxy log carries no vertex identifier. One timeline is therefore the only
 *  structure available, and the more useful one: a refusal reads in the
 *  context of what the build was doing when it happened. */
export interface InspectReportData extends ReportDataCommon {
  engine: "inspect";
  /** Every request, passthrough and refused name, oldest first. */
  timeline: TrafficEvent[];
  /** Seconds since the epoch the proxy itself started, so the report can
   *  show every event's time relative to it. Undefined when the proxy log
   *  carried no startup marker to read it from. */
  startedAt: number | undefined;
}

/** isolated-run's proxy image never produces buildkitd/vertex logs (there is
 *  no buildkitd here), so this union has no explicit-engine variant. */
export type ReportData = UniversalReportData | InspectReportData;
