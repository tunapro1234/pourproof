// Spending cap for live Claude calls, enforced in code (the workspace limit in the Anthropic Console is only the last
// line of defence). Every live call is priced from response.usage and added to a counter file outside the repository;
// before each call the month and day totals are checked, and at or over a cap the call is not made (BudgetExceeded).
// There is no fallback to recorded responses when the cap is reached: the caller stops.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Hard caps in USD. The environment can only lower them (POURPROOF_AI_MONTH_CAP_USD, POURPROOF_AI_DAY_CAP_USD). */
export const MONTH_CAP_USD = 8;
export const DAY_CAP_USD = 1;
export const MONTH_CAP_ENV = "POURPROOF_AI_MONTH_CAP_USD";
export const DAY_CAP_ENV = "POURPROOF_AI_DAY_CAP_USD";
export const SPEND_ENV = "POURPROOF_AI_SPEND";

/**
 * USD per million tokens (platform.claude.com pricing, 12 Oct 2026). Two rate cards chosen by prompt length: a prompt is
 * every input token of the request (uncached, cache write and cache read). Cache reads cost 0.1x the input rate, cache
 * writes 1.25x (5 minute TTL) or 2x (1 hour TTL). A model without a row here is never called.
 */
export const PRICES: Record<string, { long_prompt_over: number; base: Rate; long: Rate }> = {
  "claude-haiku-5-5": { long_prompt_over: 100_000, base: { input: 0.1, output: 0.5 }, long: { input: 0.5, output: 2.5 } },
};
export const CACHE_READ_FACTOR = 0.1;
export const CACHE_WRITE_5M_FACTOR = 1.25;
export const CACHE_WRITE_1H_FACTOR = 2;

interface Rate {
  input: number;
  output: number;
}

/** The fields of response.usage that are billed. */
export interface BilledUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const round9 = (x: number) => Math.round(x * 1e9) / 1e9;

export function priceOf(model: string) {
  const p = PRICES[model];
  if (!p) throw new Error(`no price known for model ${model}; add it to PRICES in packages/ai/src/budget.ts before calling it`);
  return p;
}

/** Cost of one response in USD. Cache writes without a TTL breakdown are counted as 5 minute writes. */
export function costUsd(model: string, u: BilledUsage): number {
  const p = priceOf(model);
  const write = u.cache_creation_input_tokens ?? 0;
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = u.cache_creation ? u.cache_creation.ephemeral_5m_input_tokens : write;
  const read = u.cache_read_input_tokens ?? 0;
  const prompt = u.input_tokens + write + read;
  const r = prompt > p.long_prompt_over ? p.long : p.base;
  const usd =
    u.input_tokens * r.input +
    write5m * r.input * CACHE_WRITE_5M_FACTOR +
    write1h * r.input * CACHE_WRITE_1H_FACTOR +
    read * r.input * CACHE_READ_FACTOR +
    u.output_tokens * r.output;
  return round9(usd / 1e6);
}

function capFromEnv(name: string, hard: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return hard;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number of USD, at least 0`);
  return Math.min(hard, n);
}

/** Caps in force: the hard caps, or lower values from the environment. A higher value is ignored. */
export function caps(): { month_usd: number; day_usd: number } {
  return { month_usd: capFromEnv(MONTH_CAP_ENV, MONTH_CAP_USD), day_usd: capFromEnv(DAY_CAP_ENV, DAY_CAP_USD) };
}

/** Real path of `p`, or of its nearest existing parent with the rest appended (the file may not exist yet). */
function realish(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(realish(parent), basename(abs));
}

/** The counter file: $POURPROOF_AI_SPEND or ~/.cache/pourproof/ai-spend.json. It must be outside the repository. */
export function spendFile(override?: string): string {
  const p = resolve(override ?? process.env[SPEND_ENV] ?? join(homedir(), ".cache", "pourproof", "ai-spend.json"));
  const real = realish(p);
  const repo = realish(REPO_ROOT);
  if (real === repo || real.startsWith(repo + sep)) throw new Error(`the AI spend counter must live outside the repository (${SPEND_ENV} points inside it)`);
  return p;
}

export interface SpendCall {
  at: string;
  model: string;
  task: string;
  prompt_sha256: string;
  usage: BilledUsage;
  usd: number;
}

export interface SpendLedger {
  format: "pourproof.ai-spend/1";
  note: string;
  /** USD per UTC month, "2026-10" */
  months: Record<string, number>;
  /** USD per UTC day, "2026-10-12" */
  days: Record<string, number>;
  calls: SpendCall[];
}

const periods = (now: Date) => {
  const iso = now.toISOString();
  return { month: iso.slice(0, 7), day: iso.slice(0, 10) };
};

export function readLedger(path: string): SpendLedger {
  if (!existsSync(path))
    return {
      format: "pourproof.ai-spend/1",
      note: "Cost of live Claude calls made by packages/ai, priced from response.usage. Checked before every call.",
      months: {},
      days: {},
      calls: [],
    };
  const l = JSON.parse(readFileSync(path, "utf8")) as SpendLedger;
  if (l.format !== "pourproof.ai-spend/1") throw new Error(`${path} is not a pourproof AI spend counter`);
  return l;
}

export class BudgetExceeded extends Error {
  readonly scope: "month" | "day";
  readonly period: string;
  readonly spent_usd: number;
  readonly cap_usd: number;
  constructor(scope: "month" | "day", period: string, spent: number, cap: number, file: string) {
    super(`AI spending cap reached for the ${scope} ${period}: ${spent.toFixed(4)} USD spent, cap ${cap} USD (counter ${file}); no call was made`);
    this.name = "BudgetExceeded";
    this.scope = scope;
    this.period = period;
    this.spent_usd = spent;
    this.cap_usd = cap;
  }
}

export interface Spend {
  file: string;
  month: string;
  day: string;
  month_usd: number;
  day_usd: number;
  caps: { month_usd: number; day_usd: number };
}

export function spendNow(file?: string, now = new Date()): Spend {
  const f = spendFile(file);
  const l = readLedger(f);
  const { month, day } = periods(now);
  return { file: f, month, day, month_usd: l.months[month] ?? 0, day_usd: l.days[day] ?? 0, caps: caps() };
}

/** Throws BudgetExceeded when this month or today is at or over its cap, or when the model has no known price. */
export function checkBudget(model: string, file?: string, now = new Date()): Spend {
  priceOf(model);
  const s = spendNow(file, now);
  if (s.month_usd >= s.caps.month_usd) throw new BudgetExceeded("month", s.month, s.month_usd, s.caps.month_usd, s.file);
  if (s.day_usd >= s.caps.day_usd) throw new BudgetExceeded("day", s.day, s.day_usd, s.caps.day_usd, s.file);
  return s;
}

/** Adds one live call to the counter (written to a temporary file first, then renamed). Returns its cost. */
export function recordSpend(call: Omit<SpendCall, "at" | "usd">, file?: string, now = new Date()): SpendCall {
  const f = spendFile(file);
  const l = readLedger(f);
  const { month, day } = periods(now);
  const entry: SpendCall = { at: now.toISOString(), ...call, usd: costUsd(call.model, call.usage) };
  l.months[month] = round9((l.months[month] ?? 0) + entry.usd);
  l.days[day] = round9((l.days[day] ?? 0) + entry.usd);
  l.calls.push(entry);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(l, null, 1) + "\n");
  renameSync(tmp, f);
  return entry;
}
