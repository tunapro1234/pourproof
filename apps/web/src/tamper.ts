// ?tamper=... changes downloaded readings before verification, the way someone editing the published file would.
// The on-chain roots are untouched, so verification must fail.
//   reading:<i>       reading <i> (counted over the whole pour from 0) +5 °C; the original demo link, kept working
//   reading:<i>:<d>   reading <i> changed by <d> °C
//   night:<n>:<d>     every reading of the pour's n-th night (18:00 to 06:00 local time) changed by <d> °C
// <d> is a whole number of degrees from -10 to 10, not 0. One reading is 30 minutes; raising a whole night is the
// edit that hides a cold night (higher maturity, so the edited copy would claim a higher early strength).
import { TZ_OFFSET_H } from "./format.ts";
import type { PublishedBatch } from "./verify.ts";

export type Tamper =
  | { kind: "reading"; index: number; delta_milliC: number }
  /** readings from..to (inclusive, counted over the whole pour), the pour's night number <night> */
  | { kind: "range"; from: number; to: number; delta_milliC: number; night: number };

export interface ChangedReading {
  index: number;
  counter: number;
  t_unix: number;
  before_milliC: number;
  after_milliC: number;
}

export interface TamperApplied {
  tamper: Tamper;
  /** how many readings were changed */
  count: number;
  /** counters of the batches that hold a changed reading */
  counters: number[];
  changed: ChangedReading[];
}

/** The original demo's change: +5 degC on one reading. */
export const TAMPER_DELTA_MILLIC = 5000;
/** Changes offered on the passport card, in degC. */
export const TAMPER_STEPS_C = [-5, -1, 1, 5];
export const NIGHT_FROM_H = 18;
export const NIGHT_TO_H = 6;

export interface Night {
  /** 1 for the first night after the pour started */
  n: number;
  /** first and last reading index of the night (inclusive) */
  from: number;
  to: number;
  from_unix: number;
  to_unix: number;
}

/** The pour's nights: readings from 18:00 to 06:00 local time, after pourStart, grouped by night. */
export function nightsOf(batches: readonly PublishedBatch[], pourStart: number): Night[] {
  const nights: Night[] = [];
  let key: number | null = null;
  let index = 0;
  for (const b of batches) {
    for (const r of b.readings) {
      const local = r.t_unix + TZ_OFFSET_H * 3600;
      const hour = Math.floor((((local % 86400) + 86400) % 86400) / 3600);
      const atNight = hour >= NIGHT_FROM_H || hour < NIGHT_TO_H;
      // a night belongs to the local date it started on (after midnight it is still the previous evening's night)
      const k = Math.floor(local / 86400) - (hour < NIGHT_TO_H ? 1 : 0);
      if (atNight && r.t_unix >= pourStart) {
        const last = nights[nights.length - 1];
        if (k === key && last) {
          last.to = index;
          last.to_unix = r.t_unix;
        } else nights.push({ n: nights.length + 1, from: index, to: index, from_unix: r.t_unix, to_unix: r.t_unix });
        key = k;
      }
      index++;
    }
  }
  return nights;
}

export interface TamperContext {
  batches: readonly PublishedBatch[];
  pourStart: number;
}

function delta(d: string | undefined): number | null {
  if (d === undefined) return TAMPER_DELTA_MILLIC;
  const c = Number(d);
  return Number.isInteger(c) && c !== 0 && c >= -10 && c <= 10 ? c * 1000 : null;
}

/**
 * Reads ?tamper= from a query string. Anything else (a step of 0 or over 10 °C, a fraction, a negative index, night 0,
 * a night or reading the pour does not have) gives null, and the page opens untouched. Without a context only
 * reading:<i>[:<d>] can be read, unchecked against the pour.
 */
export function parseTamper(search: string, ctx?: TamperContext): Tamper | null {
  const v = new URLSearchParams(search).get("tamper") ?? "";
  const r = v.match(/^reading:(\d+)(?::(-?\d+))?$/);
  if (r) {
    const d = delta(r[2]);
    const index = Number(r[1]);
    if (d === null || !Number.isSafeInteger(index)) return null;
    if (ctx && index >= ctx.batches.reduce((n, b) => n + b.readings.length, 0)) return null;
    return { kind: "reading", index, delta_milliC: d };
  }
  const n = v.match(/^night:(\d+):(-?\d+)$/);
  if (n && ctx) {
    const d = delta(n[2]);
    const night = nightsOf(ctx.batches, ctx.pourStart)[Number(n[1]) - 1];
    if (d === null || !night) return null;
    return { kind: "range", from: night.from, to: night.to, delta_milliC: d, night: night.n };
  }
  return null;
}

/** The ?tamper= value for a change: reading:<i>:<d> or night:<n>:<d> (d in whole degC). */
export function tamperParam(target: { kind: "reading"; index: number } | { kind: "night"; n: number }, deltaC: number): string {
  return target.kind === "reading" ? `reading:${target.index}:${deltaC}` : `night:${target.n}:${deltaC}`;
}

/** `base` (a page link that may carry data-source parameters) with ?tamper=<value> and a #hash added. */
export function tamperHref(base: string, value: string, hash = "try"): string {
  const u = new URL(base, "http://x");
  u.searchParams.set("tamper", value);
  return `${u.pathname}${u.search}${hash ? `#${hash}` : ""}`;
}

/** The ?tamper= value that reproduces a parsed change. */
export function paramOf(t: Tamper): string {
  const d = t.delta_milliC / 1000;
  return t.kind === "reading" ? tamperParam({ kind: "reading", index: t.index }, d) : tamperParam({ kind: "night", n: t.night }, d);
}

/** Returns a changed copy of the batches; the input is not modified. A change that hits no reading -> null. */
export function applyTamper(batches: readonly PublishedBatch[], t: Tamper): { batches: PublishedBatch[]; applied: TamperApplied } | null {
  const [from, to] = t.kind === "reading" ? [t.index, t.index] : [t.from, t.to];
  const changed: ChangedReading[] = [];
  let index = 0;
  const copy = batches.map((b) => {
    const start = index;
    index += b.readings.length;
    if (to < start || from >= index) return b;
    return {
      ...b,
      readings: b.readings.map((r, j) => {
        const i = start + j;
        if (i < from || i > to) return r;
        const after = { ...r, temp_milliC: r.temp_milliC + t.delta_milliC };
        changed.push({ index: i, counter: b.counter, t_unix: r.t_unix, before_milliC: r.temp_milliC, after_milliC: after.temp_milliC });
        return after;
      }),
    };
  });
  if (!changed.length) return null;
  const counters = [...new Set(changed.map((c) => c.counter))];
  return { batches: copy, applied: { tamper: t, count: changed.length, counters, changed } };
}
