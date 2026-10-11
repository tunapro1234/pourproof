import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  anomaly,
  embodiedCo2,
  fitStrength,
  maturityAt,
  maturitySeries,
  nurseSaul,
  saving,
  strengthRange,
  type Reading,
} from "../src/index.ts";

const ds = JSON.parse(readFileSync(new URL("../../../data/dataset/mendeley-nmr8pjx8d8.json", import.meta.url), "utf8")) as {
  license: string;
  series: Record<"box1" | "box2" | "cyl1" | "cyl2" | "ambient", Reading[]>;
  strength_tests: { age_d: number; specimen: string; mpa: number }[];
  authors_maturity: { t_h: number; cylinders_c_day: number; boxes_c_day: number }[];
};

const average = (a: Reading[], b: Reading[]): Reading[] => a.map((r, i) => ({ t_h: r.t_h, temp_c: (r.temp_c + b[i].temp_c) / 2 }));
const cylinders = (age: number) => ds.strength_tests.filter((t) => t.specimen === "cylinder_15x15cm" && t.age_d <= age);

describe("nurseSaul vs the authors' ASTM C1074 columns", () => {
  // The authors compute maturity on the average of the two boxes / two cylinders, datum -10 degC, in degC*day.
  for (const [name, a, b, key] of [
    ["boxes", ds.series.box1, ds.series.box2, "boxes_c_day"],
    ["cylinders", ds.series.cyl1, ds.series.cyl2, "cylinders_c_day"],
  ] as const) {
    it(`${name}: relative difference <= 2% at every reading`, () => {
      const ours = nurseSaul(average(a, b), -10);
      expect(ours.length).toBe(ds.authors_maturity.length);
      let worst = 0;
      ds.authors_maturity.forEach((row, i) => {
        expect(row.t_h).toBeCloseTo(a[i].t_h, 6);
        const theirs = row[key] * 24; // degC*day -> degC*h
        worst = Math.max(worst, Math.abs(ours[i] - theirs) / theirs);
      });
      expect(worst).toBeLessThanOrEqual(0.02);
    });
  }

  it("floors temperatures below the datum at zero", () => {
    expect(nurseSaul([{ t_h: 1, temp_c: -15 }, { t_h: 2, temp_c: 0 }], -10)).toEqual([0, 10]);
  });

  it("rejects readings out of order", () => {
    expect(() => nurseSaul([{ t_h: 2, temp_c: 20 }, { t_h: 1, temp_c: 20 }])).toThrow();
  });
});

describe("fitStrength / strengthRange", () => {
  const cylM = maturitySeries(average(ds.series.cyl1, ds.series.cyl2));
  const fit = fitStrength(cylM, cylinders(28));
  const box1M = maturitySeries(ds.series.box1);

  it("fits S = a + b ln(M) on the 5 lab cylinder ages", () => {
    expect(fit.n).toBe(5);
    expect(fit.b).toBeGreaterThan(0);
    expect(fit.sigma).toBeGreaterThan(0);
  });

  it("always returns low <= high, across the whole Box 1 record", () => {
    for (const p of box1M.filter((_, i) => i % 12 === 0)) {
      const r = strengthRange(fit, p.m_ch);
      expect(r.low_mpa).toBeLessThanOrEqual(r.high_mpa);
      expect(r.low_mpa).toBeGreaterThanOrEqual(0);
    }
  });

  it("brackets the 28-day cylinder test it was calibrated on", () => {
    const r = strengthRange(fit, maturityAt(cylM, 28 * 24));
    expect(r.low_mpa).toBeLessThanOrEqual(31.72);
    expect(r.high_mpa).toBeGreaterThanOrEqual(31.72);
    expect(r.extrapolated).toBe(false);
  });

  it("marks maturity outside the calibration span as extrapolated", () => {
    expect(strengthRange(fit, fit.m_min / 2).extrapolated).toBe(true);
  });

  it("refuses to fit fewer than 3 usable tests", () => {
    expect(() => fitStrength(cylM, cylinders(3))).toThrow();
  });
});

describe("embodiedCo2 / saving", () => {
  it("scales the EPD range by volume", () => {
    expect(embodiedCo2(8, { low: 250, high: 300 })).toEqual({ low_kg: 2000, high_kg: 2400 });
  });

  it("gives a conservative saving range, low <= high", () => {
    const s = saving({ low: 300, high: 340 }, { low: 220, high: 250 }, 10);
    expect(s).toEqual({ low_kg: 500, high_kg: 1200 });
    expect(s.low_kg).toBeLessThanOrEqual(s.high_kg);
  });

  it("keeps a negative low end when the ranges overlap", () => {
    const s = saving({ low: 260, high: 300 }, { low: 240, high: 280 }, 1);
    expect(s.low_kg).toBe(-20);
    expect(s.high_kg).toBe(60);
  });

  it("rejects inverted ranges and negative volume", () => {
    expect(() => embodiedCo2(1, { low: 300, high: 200 })).toThrow();
    expect(() => saving({ low: 1, high: 2 }, { low: 1, high: 2 }, -1)).toThrow();
  });
});

describe("anomaly", () => {
  it("Box 1 has a hydration signature and no gaps: no flags", () => {
    const r = anomaly(ds.series.box1, ds.series.ambient);
    expect(r.flags).toEqual([]);
    expect(r.stats.peak_over_ambient_c!).toBeGreaterThan(5);
  });

  it("the ambient series passed off as concrete is flagged no_hydration_signature", () => {
    const r = anomaly(ds.series.ambient, ds.series.ambient);
    expect(r.flags).toContain("no_hydration_signature");
  });

  it("a sensor that drifts with the air plus a constant offset is still flagged (correlation rule)", () => {
    const warmAir = ds.series.ambient.map((r) => ({ t_h: r.t_h, temp_c: r.temp_c + 3 }));
    expect(anomaly(warmAir, ds.series.ambient).flags).toContain("no_hydration_signature");
  });

  it("a missing stretch of readings is flagged gap", () => {
    const holed = ds.series.box1.filter((r) => r.t_h <= 100 || r.t_h > 106);
    const r = anomaly(holed, ds.series.ambient);
    expect(r.flags).toEqual(["gap"]);
    expect(r.stats.gaps).toEqual([{ from_h: 100, to_h: 106.5 }]);
  });
});
