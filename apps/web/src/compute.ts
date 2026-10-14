// Numbers on the passport, computed in the browser with packages/core from the readings that passed verification.
// Strength uses the calibration fit stored in the evidence package (whose sha256 the inspector put on chain).
// One exception, forgedClaim: the same code run on a copy edited in this browser, shown only next to its refusal.
import { embodiedCo2, maturityAt, maturitySeries, saving, strengthRange, type Co2Range, type MaturityPoint, type Reading, type StrengthFit, type StrengthRange } from "@pourproof/core";
import { eventsOf } from "./chain.ts";
import type { Mix } from "./data.ts";
import type { PourModel } from "./model.ts";
import { roleName, type Role } from "./roles.ts";
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

/** One part of the cement saving, per m³ and for the pour's volume (kg CO2e). */
export interface SplitPart {
  per_m3: number;
  kg: number;
}

/**
 * The cement difference between baseline and delivered mix, split in two:
 * quantity (less cement, priced at the baseline cement's factor), which the strength record backs, and
 * type (the delivered cement priced at both factors), which only the supplier's EPD declares.
 * The two parts add up to the cement difference exactly. Factor = mid cement GWP per m³ / cement kg per m³.
 */
export interface SavingSplit {
  cement_kg_per_m3: { baseline: number; delivered: number };
  quantity: SplitPart;
  type: SplitPart;
  total: SplitPart;
}

const mid = (r: readonly [number, number]) => (r[0] + r[1]) / 2;
const part = (per_m3: number, volume_m3: number): SplitPart => ({ per_m3, kg: per_m3 * volume_m3 });

export function savingSplit(baseline: Mix, delivered: Mix, volume_m3: number): SavingSplit {
  const cA = baseline.cement_kg_per_m3;
  const cB = delivered.cement_kg_per_m3;
  const gA = mid(baseline.cement_gwp_kg_per_m3);
  const gB = mid(delivered.cement_gwp_kg_per_m3);
  const fA = gA / cA;
  return {
    cement_kg_per_m3: { baseline: cA, delivered: cB },
    quantity: part((cA - cB) * fA, volume_m3),
    type: part(cB * fA - gB, volume_m3),
    total: part(gA - gB, volume_m3),
  };
}

/** "about" amounts on the passport: kg rounded to 10 kg. */
export const about10 = (kg: number): number => Math.round(kg / 10) * 10;

/** The saving the curing record supports right now. Every number comes from the chain; nothing new is computed. */
export type Claimable =
  | { status: "claimed"; by: Role | "unknown role"; saving: Co2Range }
  | { status: "supported"; saving: Co2Range }
  | { status: "unsupported"; reason: string };

export function claimableNow(m: Pick<PourModel, "verify" | "view" | "chain">): Claimable {
  if (!m.verify.ok) return { status: "unsupported", reason: "the curing record does not verify" };
  const claim = eventsOf(m.view, m.chain.pourId, "SavingClaimed")[0];
  if (claim) {
    return { status: "claimed", by: roleName(String(claim.args.role)) ?? "unknown role", saving: { low_kg: Number(claim.args.savingLow_kg), high_kg: Number(claim.args.savingHigh_kg) } };
  }
  const s = m.chain.state;
  if (!s.pour.strengthApproved) return { status: "unsupported", reason: "the inspector has not approved strength" };
  if (/^0x0+$/i.test(s.baseline.mixHash)) return { status: "unsupported", reason: "no baseline was declared before the pour" };
  return { status: "supported", saving: { low_kg: Number(s.savingRange[0]), high_kg: Number(s.savingRange[1]) } };
}

/** What the edited copy would claim: strength at the first checkpoint after the last changed reading. */
export interface ForgedClaim {
  age_d: number;
  /** from the edited readings */
  forged: StrengthRange;
  /** from the signed (published, unedited) readings */
  signed: StrengthRange;
}

/**
 * With a tamper on a pour whose evidence package carries a strength fit: the same strength code run on the edited
 * readings and on the signed ones, side by side. The edited numbers are what a forged record would claim, not an
 * estimate; the page shows them only next to the refusal.
 */
export function forgedClaim(m: Pick<PourModel, "applied" | "batches" | "file" | "chain" | "evidence">): ForgedClaim | null {
  const fit = m.evidence?.pkg?.strength.fit;
  if (!m.applied || !fit) return null;
  const pourStart = Number(m.chain.state.pour.pourStart);
  const forged = strengthView(readingsOf(m.batches, pourStart), fit);
  const signed = strengthView(readingsOf(m.file.batches, pourStart), fit);
  const lastChangedH = (m.applied.changed[m.applied.changed.length - 1].t_unix - pourStart) / 3600;
  const at = forged.checkpoints.find((c) => c.age_d * 24 >= lastChangedH) ?? forged.checkpoints[forged.checkpoints.length - 1];
  const before = at && signed.checkpoints.find((c) => c.age_d === at.age_d);
  return at && before ? { age_d: at.age_d, forged: at.strength, signed: before.strength } : null;
}
