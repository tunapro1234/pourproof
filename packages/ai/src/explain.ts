// Plain-language explanation of curing flags raised by the rule-based check in packages/core (anomaly()). The rules
// decide whether there is a flag; Claude only explains it. An explanation that contains any number not present in
// the stats computed by code is rejected and not shown.
import type { AnomalyFlag, AnomalyResult } from "@pourproof/core";
import { build, canonical, type BuiltRequest } from "./request.ts";
import { run, type AiMeta, type RunOptions } from "./run.ts";
import { checkNumbers } from "./verify.ts";

export const FLAG_MEANING: Record<AnomalyFlag, string> = {
  no_hydration_signature:
    "inside the first window_h hours the concrete never rose clearly above the air temperature, or it followed the air closely (correlation at or above the threshold); setting concrete normally heats itself in the first day",
  gap: "the time between two consecutive readings is much longer than the usual step, so part of the curing record is missing",
};

export type ExplainStats = Record<string, unknown>;

const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);

/** The stats sent to the model, rounded the way an inspector reads them: degC to 0.1, correlation to 0.01. */
export function displayStats(s: AnomalyResult["stats"]): ExplainStats {
  return {
    readings: s.n,
    window_h: s.window_h,
    peak_over_ambient_c: r1(s.peak_over_ambient_c),
    peak_at_h: r1(s.peak_t_h),
    correlation_with_ambient: r2(s.corr_ambient),
    usual_step_h: s.median_step_h,
    longest_step_h: s.max_step_h,
    gaps: s.gaps.map((g) => ({ from_h: r1(g.from_h), to_h: r1(g.to_h) })),
  };
}

export const EXPLAIN_SYSTEM = [
  "You explain flags raised on a concrete curing temperature record to a site inspector.",
  "The flags were raised by fixed rules in software, not by you. Explain in two to four plain sentences what each flag means for this record and what the inspector could check on site.",
  "Use only numbers that appear in the stats JSON, written exactly as they appear there (same digits and decimals). If a number is not in the stats, do not write it; do not round, convert, add or estimate. Do not write identifiers, dates or standard numbers.",
  "Do not say whether the concrete is acceptable, safe or strong enough, and do not recommend formwork removal: the inspector decides.",
].join("\n");

export const explainSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

export function explainRequest(flags: readonly AnomalyFlag[], stats: ExplainStats): BuiltRequest {
  const meanings = flags.map((f) => `- ${f}: ${FLAG_MEANING[f]}`).join("\n");
  const text = `Flags raised by the rules:\n${meanings}\n\nStats computed by code (JSON):\n${canonical(stats)}`;
  return build("explainAnomaly", EXPLAIN_SYSTEM, text, explainSchema);
}

export interface Explanation extends AiMeta {
  task: "explainAnomaly";
  flags: AnomalyFlag[];
  stats: ExplainStats;
  status: "accepted" | "rejected";
  /** the explanation, only when every number in it comes from stats */
  text: string | null;
  /** numbers in the model's text that are not in stats (why it was rejected) */
  unknown_numbers: string[];
  /** the rejected text, kept for the audit trail and never shown as an explanation */
  rejected_text: string | null;
}

export async function explainAnomaly(flags: readonly AnomalyFlag[], stats: ExplainStats, o: RunOptions = {}): Promise<Explanation> {
  if (!flags.length) throw new Error("explainAnomaly: no flags to explain (the rule-based check found nothing)");
  const req = explainRequest(flags, stats);
  const { meta, output } = await run(req, o);
  const text = typeof (output as { text?: unknown } | null)?.text === "string" ? (output as { text: string }).text : "";
  const check = checkNumbers(text, stats);
  const ok = check.ok && text.trim() !== "";
  return {
    ...meta,
    task: "explainAnomaly",
    flags: [...flags],
    stats,
    status: ok ? "accepted" : "rejected",
    text: ok ? text : null,
    unknown_numbers: check.unknown,
    rejected_text: ok ? null : text,
  };
}
