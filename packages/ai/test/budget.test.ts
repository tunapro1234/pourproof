// The spending cap, without a key and without network. A fake key (FAKE_KEY) stands in for a real one, and a
// stand-in client returns a fixed usage block, so no request ever leaves the machine; nothing here is a model answer.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BudgetExceeded,
  DAY_CAP_ENV,
  DAY_CAP_USD,
  MODEL,
  MONTH_CAP_ENV,
  MONTH_CAP_USD,
  REPO_ROOT,
  SPEND_ENV,
  caps,
  checkBudget,
  costUsd,
  explainRequest,
  demoAnomalyCases,
  readLedger,
  recordSpend,
  run,
  spendFile,
  type MessagesClient,
  type SpendLedger,
} from "../src/index.ts";

const FAKE_KEY = "fake-key-for-tests-0000-not-a-real-key";
const tmp = mkdtempSync(join(tmpdir(), "pourproof-budget-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", SPEND_ENV, MONTH_CAP_ENV, DAY_CAP_ENV] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
});

let n = 0;
const counter = () => join(tmp, `spend-${n++}.json`);
const req = () => {
  const c = demoAnomalyCases()[1];
  return explainRequest(c.flags, c.stats);
};
const usage = (input: number, output: number, extra: Partial<Anthropic.Usage> = {}) =>
  ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null, ...extra }) as Anthropic.Usage;

/** Stand-in client: counts calls and answers with the given usage (or throws). */
function standIn(u: Anthropic.Usage, fail?: Error) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    messages: {
      async create(p) {
        calls.push(p);
        if (fail) throw fail;
        return {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: p.model,
          content: [{ type: "text", text: JSON.stringify({ text: "stand-in" }), citations: null }],
          stop_reason: "end_turn",
          stop_sequence: null,
          stop_details: null,
          usage: u,
        } as unknown as Anthropic.Message;
      },
    },
  };
  return { client, calls };
}

/** A counter already holding `month` USD this month and `day` USD today. */
function seeded(month: number, day: number): string {
  const f = counter();
  const now = new Date().toISOString();
  const l: SpendLedger = { ...readLedger(f), months: { [now.slice(0, 7)]: month }, days: { [now.slice(0, 10)]: day } };
  writeFileSync(f, JSON.stringify(l));
  return f;
}

describe("model", () => {
  it("is Haiku 5.5, and requests carry no fallback or beta", () => {
    expect(MODEL).toBe("claude-haiku-5-5");
    const p = req().params as unknown as Record<string, unknown>;
    expect(p.model).toBe("claude-haiku-5-5");
    expect(p.betas).toBeUndefined();
    expect(p.fallbacks).toBeUndefined();
  });

  it("puts the fixed instructions and the output schema first, ending in a cache breakpoint", () => {
    const sys = req().params.system as Anthropic.TextBlockParam[];
    expect(sys).toHaveLength(2);
    expect(sys[0].cache_control).toBeUndefined();
    expect(sys[1].text).toContain('"required":["text"]');
    expect(sys[1].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("costUsd (Haiku 5.5: 0.10 / 0.50 USD per MTok up to 100K prompt tokens, 0.50 / 2.50 above)", () => {
  it("prices input and output", () => {
    expect(costUsd(MODEL, usage(100_000, 0))).toBeCloseTo(0.01, 9);
    expect(costUsd(MODEL, usage(0, 1_000_000))).toBeCloseTo(0.5, 9);
    expect(costUsd(MODEL, usage(2_000, 1_000))).toBeCloseTo(0.0002 + 0.0005, 9);
  });

  it("prices cache reads at 0.1x and cache writes at 1.25x (5 min) or 2x (1 h) the input rate", () => {
    expect(costUsd(MODEL, usage(0, 0, { cache_read_input_tokens: 10_000 }))).toBeCloseTo(0.0001, 9);
    expect(costUsd(MODEL, usage(0, 0, { cache_creation_input_tokens: 10_000 }))).toBeCloseTo(0.00125, 9);
    const both = { cache_creation_input_tokens: 20_000, cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 10_000 } };
    expect(costUsd(MODEL, usage(0, 0, both))).toBeCloseTo(0.00125 + 0.002, 9);
  });

  it("switches to the long-prompt rates when all input tokens together pass 100K", () => {
    expect(costUsd(MODEL, usage(100_000, 1_000))).toBeCloseTo(0.01 + 0.0005, 9);
    expect(costUsd(MODEL, usage(1_000_000, 0))).toBeCloseTo(0.5, 9);
    expect(costUsd(MODEL, usage(90_000, 1_000, { cache_read_input_tokens: 20_000 }))).toBeCloseTo(0.045 + 0.001 + 0.0025, 9);
  });

  it("refuses to price (and so to call) a model it has no price for", () => {
    expect(() => costUsd("claude-opus-5-5", usage(1, 1))).toThrow(/no price known/);
    expect(() => checkBudget("claude-opus-5-5", counter())).toThrow(/no price known/);
  });
});

describe("caps", () => {
  it("are 8 USD a month and 1 USD a day", () => {
    expect([MONTH_CAP_USD, DAY_CAP_USD]).toEqual([8, 1]);
    expect(caps()).toEqual({ month_usd: 8, day_usd: 1 });
  });

  it("can be lowered from the environment but not raised", () => {
    process.env[MONTH_CAP_ENV] = "2.5";
    process.env[DAY_CAP_ENV] = "0.2";
    expect(caps()).toEqual({ month_usd: 2.5, day_usd: 0.2 });
    process.env[MONTH_CAP_ENV] = "500";
    process.env[DAY_CAP_ENV] = "50";
    expect(caps()).toEqual({ month_usd: 8, day_usd: 1 });
    process.env[DAY_CAP_ENV] = "lots";
    expect(() => caps()).toThrow(/must be a number/);
  });

  it("refuse a call when the month is at its cap, even with today empty", () => {
    const f = seeded(8, 0);
    expect(() => checkBudget(MODEL, f)).toThrow(BudgetExceeded);
    try {
      checkBudget(MODEL, f);
    } catch (e) {
      expect(e).toMatchObject({ scope: "month", spent_usd: 8, cap_usd: 8 });
    }
  });

  it("refuse a call when today is at its cap", () => {
    expect(() => checkBudget(MODEL, seeded(3, 1))).toThrow(/cap reached for the day/);
    expect(() => checkBudget(MODEL, seeded(3, 0.999))).not.toThrow();
  });

  it("an environment value above the hard cap does not reopen a full day", () => {
    process.env[DAY_CAP_ENV] = "5";
    expect(() => checkBudget(MODEL, seeded(3, 1))).toThrow(BudgetExceeded);
  });
});

describe("live calls under the cap (stand-in client, fake key)", () => {
  it("are not made at the cap: BudgetExceeded, no request sent, no recorded response instead", async () => {
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    const { client, calls } = standIn(usage(1000, 100));
    const f = seeded(1, 1);
    const err = await run(req(), { spendFile: f, client }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceeded);
    expect(calls).toHaveLength(0);
    expect(String((err as Error).message)).not.toContain(FAKE_KEY);
    expect(String((err as Error).stack)).not.toContain(FAKE_KEY);
  });

  it("are priced from response.usage and added to the month and the day", async () => {
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    const { client, calls } = standIn(usage(2_000, 1_000, { cache_read_input_tokens: 10_000 }));
    const f = counter();
    const r = await run(req(), { spendFile: f, client });
    expect(r.meta.mode).toBe("live");
    expect(calls).toHaveLength(1);
    const l = readLedger(f);
    const now = new Date().toISOString();
    const usd = 0.0002 + 0.0001 + 0.0005;
    expect(l.months[now.slice(0, 7)]).toBeCloseTo(usd, 9);
    expect(l.days[now.slice(0, 10)]).toBeCloseTo(usd, 9);
    expect(l.calls[0]).toMatchObject({ model: MODEL, task: "explainAnomaly", prompt_sha256: req().prompt_sha256 });
    expect(readFileSync(f, "utf8")).not.toContain(FAKE_KEY);
  });

  it("stop once a call takes the day over its cap", async () => {
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    process.env[DAY_CAP_ENV] = "0.001";
    const { client, calls } = standIn(usage(0, 1_000));
    const f = counter();
    await run(req(), { spendFile: f, client });
    await run(req(), { spendFile: f, client });
    await expect(run(req(), { spendFile: f, client })).rejects.toBeInstanceOf(BudgetExceeded);
    expect(calls).toHaveLength(2);
  });

  it("never put the key in an error message, even when the error carries it", async () => {
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    const { client } = standIn(usage(0, 0), new Error(`upstream said: bad header x-api-key: ${FAKE_KEY}`));
    const err = (await run(req(), { spendFile: counter(), client }).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("[redacted]");
    expect(err.message).not.toContain(FAKE_KEY);
    expect(String(err.stack)).not.toContain(FAKE_KEY);
  });

  it("never put the key in the SDK's own error (connection refused on a local port, no network)", async () => {
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
    const f = counter();
    const err = (await run(req(), { spendFile: f }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(`${err.message}\n${err.stack}`).not.toContain(FAKE_KEY);
    expect(readLedger(f).calls).toHaveLength(0);
  });
});

describe("spend counter file", () => {
  it("defaults to ~/.cache/pourproof/ai-spend.json, outside the repository", () => {
    const f = spendFile();
    expect(f.endsWith(join(".cache", "pourproof", "ai-spend.json"))).toBe(true);
    expect(f.startsWith(REPO_ROOT)).toBe(false);
  });

  it("follows POURPROOF_AI_SPEND", () => {
    process.env[SPEND_ENV] = join(tmp, "elsewhere.json");
    expect(spendFile()).toBe(join(tmp, "elsewhere.json"));
  });

  it("refuses a path inside the repository", () => {
    process.env[SPEND_ENV] = join(REPO_ROOT, "packages/ai/ai-spend.json");
    expect(() => spendFile()).toThrow(/outside the repository/);
    expect(() => recordSpend({ model: MODEL, task: "explainAnomaly", prompt_sha256: "x", usage: usage(1, 1) })).toThrow(/outside the repository/);
  });
});
