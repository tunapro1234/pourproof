// Curing curve as inline SVG. The data source label is drawn inside the chart, so a screenshot cannot lose it.
import type { Reading } from "@pourproof/core";
import { esc } from "./format.ts";

export interface ChartOptions {
  /** first line inside the plot, e.g. the device / dataset label */
  sourceLabel: string;
  /** optional second line */
  note?: string;
  /** reading index to mark in red (tamper demo) */
  marked?: number | null;
}

const W = 760;
const H = 300;
const M = { l: 48, r: 32, t: 14, b: 36 };

export function curingChart(readings: readonly Reading[], o: ChartOptions): string {
  if (!readings.length) return "";
  const maxT = Math.max(28 * 24, readings[readings.length - 1].t_h);
  const temps = readings.map((r) => r.temp_c);
  const lo = Math.floor(Math.min(...temps) / 5) * 5;
  const hi = Math.ceil(Math.max(...temps) / 5) * 5 + 10; // headroom for the label box
  const x = (t: number) => M.l + (t / maxT) * (W - M.l - M.r);
  const y = (c: number) => H - M.b - ((c - lo) / (hi - lo)) * (H - M.t - M.b);
  const pts = readings.map((r) => `${x(r.t_h).toFixed(1)},${y(r.temp_c).toFixed(1)}`).join(" ");

  const grid: string[] = [];
  for (let d = 0; d <= maxT / 24; d += 7) {
    grid.push(`<line x1="${x(d * 24)}" x2="${x(d * 24)}" y1="${M.t}" y2="${H - M.b}" class="grid"/>`);
    grid.push(`<text x="${x(d * 24)}" y="${H - M.b + 16}" text-anchor="middle" class="tick">day ${d}</text>`);
  }
  for (let c = lo; c <= hi; c += 5) {
    grid.push(`<line x1="${M.l}" x2="${W - M.r}" y1="${y(c)}" y2="${y(c)}" class="grid"/>`);
    grid.push(`<text x="${M.l - 6}" y="${y(c) + 4}" text-anchor="end" class="tick">${c}</text>`);
  }
  const m = o.marked != null && readings[o.marked] ? readings[o.marked] : null;
  const mark = m ? `<circle cx="${x(m.t_h)}" cy="${y(m.temp_c)}" r="6" class="mark"/><text x="${x(m.t_h) + 9}" y="${y(m.temp_c) - 8}" class="mark-text">changed reading</text>` : "";
  const lines = [o.sourceLabel, o.note].filter(Boolean) as string[];
  const box = lines.map((l, i) => `<text x="${M.l + 10}" y="${M.t + 18 + i * 17}" class="${i ? "chart-note" : "chart-label"}">${esc(l)}</text>`).join("");

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Curing temperature over time. ${esc(o.sourceLabel)}" class="chart" data-testid="curing-chart">
  ${grid.join("")}
  <text x="14" y="${M.t + (H - M.t - M.b) / 2}" transform="rotate(-90 14 ${M.t + (H - M.t - M.b) / 2})" text-anchor="middle" class="tick">°C</text>
  <polyline points="${pts}" class="curve"/>
  ${mark}
  <rect x="${M.l + 4}" y="${M.t + 4}" width="${Math.min(W - M.l - M.r - 8, 12 + Math.max(...lines.map((l) => l.length)) * 6.6)}" height="${10 + lines.length * 17}" class="label-box"/>
  ${box}
</svg>`;
}
