// Display helpers. Times are shown in the pours' local time (UTC+3), labelled as such.

export const TZ_OFFSET_H = 3;
export const TZ_LABEL = "UTC+3";

const pad = (n: number) => String(n).padStart(2, "0");

export function fmtTime(unix: number | string | bigint): string {
  const d = new Date((Number(unix) + TZ_OFFSET_H * 3600) * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} ${TZ_LABEL}`;
}

export const short = (h: string, n = 6): string => (h.length > 2 + 2 * n ? `${h.slice(0, 2 + n)}...${h.slice(-4)}` : h);

/** A range always as "low to high unit", never one number. */
export function range(low: number, high: number, unit: string, digits = 0): string {
  const f = (x: number) => x.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${f(low)} to ${f(high)} ${unit}`;
}

export const celsius = (milliC: number): string => `${(milliC / 1000).toFixed(2)} °C`;

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
