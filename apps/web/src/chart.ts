// Curing curve as inline SVG. The data source label is drawn inside the chart, so a screenshot cannot lose it.
import type { Reading } from "@pourproof/core";
import { esc } from "./format.ts";

export interface ChartOptions {
  /** first line inside the plot, e.g. the device / dataset label */
  sourceLabel: string;
  /** optional second line */
  note?: string;
  /** readings to mark in red (tamper demo): indices from..to, inclusive */
  marked?: { from: number; to: number } | null;
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
  const a = o.marked ? readings[o.marked.from] : undefined;
  const b = o.marked ? readings[o.marked.to] : undefined;
  let mark = "";
  if (a && b && o.marked!.from === o.marked!.to) {
    mark = `<circle cx="${x(a.t_h)}" cy="${y(a.temp_c)}" r="6" class="mark"/><text x="${x(a.t_h) + 9}" y="${y(a.temp_c) - 8}" class="mark-text">changed reading</text>`;
  } else if (a && b) {
    const seg = readings.slice(o.marked!.from, o.marked!.to + 1).map((r) => `${x(r.t_h).toFixed(1)},${y(r.temp_c).toFixed(1)}`).join(" ");
    const x0 = x(a.t_h) - 2;
    const w = Math.max(4, x(b.t_h) - x(a.t_h) + 4);
    const top = Math.min(...readings.slice(o.marked!.from, o.marked!.to + 1).map((r) => y(r.temp_c)));
    // label on the right of the band, or on its left near the end of the chart
    const right = x0 + w + 120 < W - M.r;
    const tx = right ? x0 + w + 4 : x0 - 4;
    const ty = Math.max(M.t + 12, top - 8);
    mark = `<rect x="${x0.toFixed(1)}" y="${M.t}" width="${w.toFixed(1)}" height="${H - M.t - M.b}" class="mark-band" data-testid="chart-changed"/><polyline points="${seg}" class="mark-line"/><text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="${right ? "start" : "end"}" class="mark-text">changed readings</text>`;
  }
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
