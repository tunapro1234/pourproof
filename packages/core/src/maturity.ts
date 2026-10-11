// Maturity, strength range, embodied CO2 and curing anomaly checks.
// Pure functions. Every estimate leaves this module as a {low, high} range, never a single number.

/** One temperature reading. `t_h` is hours since casting. */
export interface Reading {
  t_h: number;
  temp_c: number;
}

/** A cumulative maturity value at a point in time, in degC*h. */
export interface MaturityPoint {
  t_h: number;
  m_ch: number;
}

/** A compressive strength test at a given age. */
export interface StrengthTest {
  age_d: number;
  mpa: number;
}

export interface StrengthFit {
  /** S = a + b * ln(M), M in degC*h */
  a: number;
  b: number;
  /** residual standard deviation, MPa (n - 2 degrees of freedom) */
  sigma: number;
  n: number;
  /** maturity span of the calibration points, degC*h */
  m_min: number;
  m_max: number;
}

export interface StrengthRange {
  low_mpa: number;
  high_mpa: number;
  /** true when M is outside the maturity span the fit was calibrated on */
  extrapolated: boolean;
}

export interface Co2Range {
  low_kg: number;
  high_kg: number;
}

export interface GwpRange {
  /** kg CO2e per m3 */
  low: number;
  high: number;
}

/**
 * Nurse-Saul temperature-time factor (ASTM C1074): M(t) = sum (T - T0) * dt, with (T - T0) floored at 0.
 * Each reading covers the interval since the previous reading; the first one covers the time since casting (t = 0).
 * Returns cumulative degC*h, aligned with `series`.
 */
export function nurseSaul(series: readonly Reading[], datumC = -10): number[] {
  const out: number[] = [];
  let prevT = 0;
  let m = 0;
  for (const r of series) {
    const dt = r.t_h - prevT;
    if (dt < 0) throw new Error(`readings out of order at t_h=${r.t_h}`);
    m += Math.max(r.temp_c - datumC, 0) * dt;
    out.push(m);
    prevT = r.t_h;
  }
  return out;
}

/** Pairs a series with its Nurse-Saul maturity. */
export function maturitySeries(series: readonly Reading[], datumC = -10): MaturityPoint[] {
  const m = nurseSaul(series, datumC);
  return series.map((r, i) => ({ t_h: r.t_h, m_ch: m[i] }));
}

/** Maturity at time t_h by linear interpolation; throws outside the recorded span. */
export function maturityAt(points: readonly MaturityPoint[], t_h: number): number {
  if (points.length === 0) throw new Error("empty maturity series");
  if (t_h < 0 || t_h > points[points.length - 1].t_h) throw new Error(`t_h=${t_h} outside recorded span`);
  let prev: MaturityPoint = { t_h: 0, m_ch: 0 };
  for (const p of points) {
    if (p.t_h >= t_h) {
      const span = p.t_h - prev.t_h;
      return span === 0 ? p.m_ch : prev.m_ch + ((t_h - prev.t_h) / span) * (p.m_ch - prev.m_ch);
    }
    prev = p;
  }
  return points[points.length - 1].m_ch;
}

/**
 * Least-squares fit of S = a + b * ln(M) on strength tests, with M looked up at each test age.
 * Tests with zero strength or zero maturity are skipped (ln undefined). Needs at least 3 usable tests.
 */
export function fitStrength(maturity: readonly MaturityPoint[], tests: readonly StrengthTest[]): StrengthFit {
  const pts = tests
    .filter((t) => t.mpa > 0 && t.age_d > 0)
    .map((t) => ({ m: maturityAt(maturity, t.age_d * 24), s: t.mpa }))
    .filter((p) => p.m > 0);
  const n = pts.length;
  if (n < 3) throw new Error(`fitStrength needs at least 3 tests with M > 0, got ${n}`);
  const xs = pts.map((p) => Math.log(p.m));
  const ys = pts.map((p) => p.s);
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx === 0) throw new Error("fitStrength needs tests at different maturities");
  const b = sxy / sxx;
  const a = my - b * mx;
  let ssr = 0;
  for (let i = 0; i < n; i++) ssr += (ys[i] - (a + b * xs[i])) ** 2;
  const sigma = Math.sqrt(ssr / (n - 2));
  const ms = pts.map((p) => p.m);
  return { a, b, sigma, n, m_min: Math.min(...ms), m_max: Math.max(...ms) };
}

/** Estimated strength at maturity M (degC*h): prediction +- 2 sigma. Lower bound floored at 0 MPa. */
export function strengthRange(fit: StrengthFit, m_ch: number): StrengthRange {
  if (!(m_ch > 0)) throw new Error("maturity must be > 0");
  const s = fit.a + fit.b * Math.log(m_ch);
  return {
    low_mpa: Math.max(0, s - 2 * fit.sigma),
    high_mpa: Math.max(0, s + 2 * fit.sigma),
    extrapolated: m_ch < fit.m_min || m_ch > fit.m_max,
  };
}

function checkGwp(g: GwpRange, name: string): void {
  if (!(Number.isFinite(g.low) && Number.isFinite(g.high)) || g.low < 0 || g.low > g.high) {
    throw new Error(`${name}: need 0 <= low <= high, got ${g.low}..${g.high}`);
  }
}

/** Embodied CO2 of a pour: volume (m3) times the EPD GWP range (kg CO2e/m3). */
export function embodiedCo2(volume_m3: number, gwpPerM3: GwpRange): Co2Range {
  if (!(volume_m3 >= 0)) throw new Error("volume must be >= 0");
  checkGwp(gwpPerM3, "gwpPerM3");
  return { low_kg: volume_m3 * gwpPerM3.low, high_kg: volume_m3 * gwpPerM3.high };
}

/**
 * Saving of the actual mix against the declared baseline mix, as a conservative range:
 * low = (baseline.low - actual.high) * V, high = (baseline.high - actual.low) * V.
 * The low end can be negative when the two GWP ranges overlap; it is not clamped.
 */
export function saving(baseline: GwpRange, actual: GwpRange, volume_m3: number): Co2Range {
  if (!(volume_m3 >= 0)) throw new Error("volume must be >= 0");
  checkGwp(baseline, "baseline");
  checkGwp(actual, "actual");
  return {
    low_kg: (baseline.low - actual.high) * volume_m3,
    high_kg: (baseline.high - actual.low) * volume_m3,
  };
}

export type AnomalyFlag = "no_hydration_signature" | "gap";

export interface AnomalyOptions {
  /** hydration window from casting, hours */
  windowH?: number;
  /** minimum peak of concrete over ambient inside the window, degC */
  minPeakOverAmbientC?: number;
  /** correlation with ambient at or above this inside the window counts as "follows the air" */
  maxAmbientCorrelation?: number;
  /** a step longer than this multiple of the median step is a gap */
  gapFactor?: number;
}

export interface AnomalyResult {
  flags: AnomalyFlag[];
  stats: {
    n: number;
    window_h: number;
    peak_over_ambient_c: number | null;
    peak_t_h: number | null;
    corr_ambient: number | null;
    median_step_h: number | null;
    max_step_h: number | null;
    gaps: { from_h: number; to_h: number }[];
  };
}

/**
 * Rule-based curing checks (no LLM).
 * - no_hydration_signature: inside the first `windowH` hours the concrete never rises `minPeakOverAmbientC`
 *   above ambient, or it tracks ambient with correlation >= `maxAmbientCorrelation`.
 * - gap: a step between readings longer than `gapFactor` x the median step.
 * Ambient readings are matched to concrete readings by time (nearest within half a median step).
 */
export function anomaly(series: readonly Reading[], ambient: readonly Reading[], opts: AnomalyOptions = {}): AnomalyResult {
  const windowH = opts.windowH ?? 24;
  const minPeak = opts.minPeakOverAmbientC ?? 1;
  const maxCorr = opts.maxAmbientCorrelation ?? 0.95;
  const gapFactor = opts.gapFactor ?? 1.5;
  const flags: AnomalyFlag[] = [];

  const steps: number[] = [];
  for (let i = 1; i < series.length; i++) steps.push(series[i].t_h - series[i - 1].t_h);
  const medianStep = steps.length ? median(steps) : null;
  const gaps: { from_h: number; to_h: number }[] = [];
  if (medianStep !== null && medianStep > 0) {
    for (let i = 1; i < series.length; i++) {
      if (series[i].t_h - series[i - 1].t_h > gapFactor * medianStep) gaps.push({ from_h: series[i - 1].t_h, to_h: series[i].t_h });
    }
  }
  if (gaps.length) flags.push("gap");

  const tol = (medianStep ?? 0.5) / 2;
  const pairs: { t: number; c: number; a: number }[] = [];
  let j = 0;
  for (const r of series) {
    if (r.t_h > windowH) break;
    while (j + 1 < ambient.length && Math.abs(ambient[j + 1].t_h - r.t_h) <= Math.abs(ambient[j].t_h - r.t_h)) j++;
    if (ambient.length && Math.abs(ambient[j].t_h - r.t_h) <= tol) pairs.push({ t: r.t_h, c: r.temp_c, a: ambient[j].temp_c });
  }

  let peak: number | null = null;
  let peakT: number | null = null;
  let corr: number | null = null;
  if (pairs.length >= 3) {
    for (const p of pairs) {
      const d = p.c - p.a;
      if (peak === null || d > peak) {
        peak = d;
        peakT = p.t;
      }
    }
    corr = pearson(pairs.map((p) => p.c), pairs.map((p) => p.a));
    const tracksAir = corr !== null && corr >= maxCorr;
    if ((peak as number) < minPeak || tracksAir) flags.push("no_hydration_signature");
  }

  return {
    flags,
    stats: {
      n: series.length,
      window_h: windowH,
      peak_over_ambient_c: peak,
      peak_t_h: peakT,
      corr_ambient: corr,
      median_step_h: medianStep,
      max_step_h: steps.length ? Math.max(...steps) : null,
      gaps,
    },
  };
}

function mean(v: readonly number[]): number {
  return v.reduce((s, x) => s + x, 0) / v.length;
}

function median(v: readonly number[]): number {
  const s = [...v].sort((x, y) => x - y);
  const k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

/** Pearson correlation; null when either side is constant. */
function pearson(x: readonly number[], y: readonly number[]): number | null {
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}
