// ?tamper=reading:<i> changes one downloaded reading before verification, the way someone editing the published file
// would. <i> counts readings over the whole pour from 0. The on-chain root is untouched, so verification must fail.
import type { PublishedBatch } from "./verify.ts";

export interface Tamper {
  kind: "reading";
  index: number;
}

export interface TamperApplied extends Tamper {
  counter: number;
  t_unix: number;
  before_milliC: number;
  after_milliC: number;
}

/** How much the tampered reading is changed by: +5 degC, a believable edit that hides a cold night. */
export const TAMPER_DELTA_MILLIC = 5000;

export function parseTamper(search: string): Tamper | null {
  const v = new URLSearchParams(search).get("tamper");
  const m = v?.match(/^reading:(\d+)$/);
  return m ? { kind: "reading", index: Number(m[1]) } : null;
}

/** Returns a changed copy of the batches; the input is not modified. Out-of-range index -> null. */
export function applyTamper(batches: readonly PublishedBatch[], t: Tamper): { batches: PublishedBatch[]; applied: TamperApplied } | null {
  let i = t.index;
  for (let bi = 0; bi < batches.length; bi++) {
    const b = batches[bi];
    if (i < b.readings.length) {
      const before = b.readings[i];
      const after = { ...before, temp_milliC: before.temp_milliC + TAMPER_DELTA_MILLIC };
      const copy = batches.map((x, k) => (k === bi ? { ...x, readings: x.readings.map((r, j) => (j === i ? after : r)) } : x));
      return { batches: copy, applied: { ...t, counter: b.counter, t_unix: before.t_unix, before_milliC: before.temp_milliC, after_milliC: after.temp_milliC } };
    }
    i -= b.readings.length;
  }
  return null;
}
