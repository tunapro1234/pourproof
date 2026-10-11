// Numbers on the passport, computed in the browser with packages/core from the readings that passed verification.
// Strength uses the calibration fit stored in the evidence package (whose sha256 the inspector put on chain).
import { embodiedCo2, maturityAt, maturitySeries, saving, strengthRange, type Co2Range, type MaturityPoint, type Reading, type StrengthFit, type StrengthRange } from "@pourproof/core";
import type { Mix } from "./data.ts";
import type { PublishedBatch } from "./verify.ts";

export const CHECKPOINT_DAYS = [3, 7, 14, 28];
export const STRENGTH_LABEL = "estimated range, inspector decides";

export interface EvidencePackage {
  format: "pourproof.evidence/1";
  pourLabel: string;
  pourId: string;
  maturity: { method: string; at_h: number; maturity_ch: number };
  strength: {
    label: string;
    calibration: string;
    fit: StrengthFit;
    range: string;
    checkpoints: { age_d: number; maturity_ch: number; strength: StrengthRange }[];
    reference: { standard_28d_mpa: number; paper_70pct_threshold_mpa: number; source: string; ui_rule: string } | null;
  };
  carbon: { saving_kg: Co2Range; note: string };
  ai: { note: string; outputs: { task: string; document: string; prompt_sha256: string; mode: string; label: string; checks: Record<string, number> }[] } | null;
}

export function readingsOf(batches: readonly PublishedBatch[], pourStart: number): Reading[] {
  return batches.flatMap((b) => b.readings).map((r) => ({ t_h: (r.t_unix - pourStart) / 3600, temp_c: r.temp_milliC / 1000 }));
}

export interface StrengthView {
  maturity: MaturityPoint[];
  lastH: number;
  lastM: number;
  checkpoints: { age_d: number; maturity_ch: number; strength: StrengthRange }[];
}

export function strengthView(readings: readonly Reading[], fit: StrengthFit): StrengthView {
  const maturity = maturitySeries(readings);
  const lastH = readings[readings.length - 1].t_h;
  const checkpoints = CHECKPOINT_DAYS.filter((d) => d * 24 <= lastH).map((d) => {
    const m = maturityAt(maturity, d * 24);
    return { age_d: d, maturity_ch: m, strength: strengthRange(fit, m) };
  });
  return { maturity, lastH, lastM: maturity[maturity.length - 1].m_ch, checkpoints };
}

const gwp = (m: Mix) => ({ low: m.gwp_total_kg_per_m3[0], high: m.gwp_total_kg_per_m3[1] });

export interface CarbonView {
  delivered: Co2Range;
  baseline: Co2Range | null;
  saving: Co2Range | null;
}

export function carbonView(volume_m3: number, delivered: Mix, baseline: Mix | null): CarbonView {
  return {
    delivered: embodiedCo2(volume_m3, gwp(delivered)),
    baseline: baseline ? embodiedCo2(volume_m3, gwp(baseline)) : null,
    saving: baseline ? saving(gwp(baseline), gwp(delivered), volume_m3) : null,
  };
}
