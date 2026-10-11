// Deterministic checks on what the model returns. AI output is never trusted as is:
// - PDF fields: the quote must appear in the pdftotext output of the cited page, and the value inside the quote.
//   Otherwise the field is "unverified" and the UI keeps its approve button locked.
// - Photo fields: there is no text layer to check against, so a field whose value sits inside its quote is
//   "needs_review" (a person compares it with the photo); anything else is "unverified".
// - Explanations: every number in the text must appear in the stats computed by code.
import { execFileSync } from "node:child_process";

export type FieldStatus = "verified" | "unverified" | "needs_review";

export interface RawField {
  value: string | null;
  unit: string | null;
  page: number;
  quote: string;
}

export interface Field {
  value: string | null;
  unit: string | null;
  source: { page: number; quote: string };
  status: FieldStatus;
  reason: string;
}

/** Runs of whitespace (line breaks from the PDF layout included) count as one space; nothing else is changed. */
export const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

export function pdfPages(path: string): string[] {
  const info = execFileSync("pdfinfo", [path], { encoding: "utf8" });
  const n = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0);
  const pages: string[] = [];
  for (let p = 1; p <= n; p++) pages.push(execFileSync("pdftotext", ["-f", String(p), "-l", String(p), path, "-"], { encoding: "utf8" }));
  return pages;
}

export function checkPdfField(f: RawField, pages: readonly string[]): Field {
  const base = { value: f.value, unit: f.unit, source: { page: f.page, quote: f.quote } };
  if (f.value === null || f.value === "") return { ...base, status: "unverified", reason: "no value returned" };
  if (!Number.isInteger(f.page) || f.page < 1 || f.page > pages.length) return { ...base, status: "unverified", reason: `page ${f.page} does not exist in the PDF` };
  const quote = squash(f.quote);
  if (!quote) return { ...base, status: "unverified", reason: "no quote returned" };
  if (!squash(pages[f.page - 1]).includes(quote)) return { ...base, status: "unverified", reason: `quote not found in the text of page ${f.page}` };
  if (!quote.includes(squash(f.value))) return { ...base, status: "unverified", reason: "value not found inside the quote" };
  return { ...base, status: "verified", reason: `quote found verbatim on page ${f.page}, value inside the quote` };
}

export function checkImageField(f: RawField): Field {
  const base = { value: f.value, unit: f.unit, source: { page: f.page, quote: f.quote } };
  if (f.value === null || f.value === "") return { ...base, status: "unverified", reason: "no value returned" };
  if (!squash(f.quote).includes(squash(f.value))) return { ...base, status: "unverified", reason: "value not found inside the quote" };
  return { ...base, status: "needs_review", reason: "read from a photo; no text layer to check against, compare with the image" };
}

/** Numbers as written in a text: 24, 0.5, 18.9 (a leading minus sign is ignored on both sides). */
export const numbersIn = (s: string): string[] => s.match(/\d+(?:\.\d+)?/g) ?? [];

function collectNumbers(v: unknown, out: Set<string>): Set<string> {
  if (typeof v === "number" && Number.isFinite(v)) out.add(String(Math.abs(v)));
  else if (typeof v === "string") for (const n of numbersIn(v)) out.add(n);
  else if (Array.isArray(v)) for (const x of v) collectNumbers(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) collectNumbers(x, out);
  return out;
}

export interface NumberCheck {
  ok: boolean;
  allowed: string[];
  unknown: string[];
}

/** Every number written in `text` must equal, character for character, a number in `stats`. */
export function checkNumbers(text: string, stats: unknown): NumberCheck {
  const allowed = collectNumbers(stats, new Set());
  const unknown = [...new Set(numbersIn(text).filter((n) => !allowed.has(n)))];
  return { ok: unknown.length === 0, allowed: [...allowed].sort(), unknown };
}
