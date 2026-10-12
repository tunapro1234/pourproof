// Runs one built request: live when ANTHROPIC_API_KEY is set, otherwise from recorded_responses/. Every result carries
// {model, prompt_sha256, mode} and a label the UI shows as is. A live call is checked against the spending cap first and
// priced afterwards (budget.ts); at the cap it is not made and the caller gets BudgetExceeded, not a recorded response.
// The API key is read only from the environment and never appears in an error message.
import { relative } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { checkBudget, recordSpend, type BilledUsage } from "./budget.ts";
import type { BuiltRequest } from "./request.ts";
import { RECORDED_DIR, readRecord, writeRecord, type Recording, type RecordFile } from "./store.ts";

export type Mode = "live" | "recorded";

export interface AiMeta {
  model: string;
  prompt_sha256: string;
  mode: Mode;
  /** where a recorded output came from; absent for live */
  recording?: Recording;
  /** "live", "recorded response" or "recorded response (handwritten fixture)" */
  label: string;
}

export interface RunOptions {
  /** "auto" (default): live if ANTHROPIC_API_KEY is set, else recorded */
  mode?: "auto" | Mode;
  /** directory of recorded responses; default packages/ai/recorded_responses */
  store?: string;
  /** after a live call, write the response to the store (npm run record) */
  record?: boolean;
  /** repository root, to store input paths relative to it */
  root?: string;
  /** AI spend counter file; default $POURPROOF_AI_SPEND or ~/.cache/pourproof/ai-spend.json (outside the repository) */
  spendFile?: string;
  /** stands in for the Anthropic client in tests (no network); never used by the package itself */
  client?: MessagesClient;
}

export interface MessagesClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

/** Replaces the API key in an error's message and stack, keeping the error's class. */
export function redactKey(e: unknown, key: string): unknown {
  if (!key) return e;
  if (e instanceof Error) {
    if (e.message.includes(key)) e.message = e.message.split(key).join("[redacted]");
    if (e.stack?.includes(key)) e.stack = e.stack.split(key).join("[redacted]");
    return e;
  }
  return typeof e === "string" ? e.split(key).join("[redacted]") : e;
}

export interface RunResult {
  meta: AiMeta;
  output: unknown;
}

export class AiRefused extends Error {
  readonly category: string | null;
  constructor(category: string | null) {
    super(`the model declined the request${category ? ` (${category})` : ""}`);
    this.name = "AiRefused";
    this.category = category;
  }
}

export function labelOf(mode: Mode, recording?: Recording): string {
  if (mode === "live") return "live";
  return recording === "handwritten fixture" ? "recorded response (handwritten fixture)" : "recorded response";
}

export function resolveMode(o: RunOptions): Mode {
  const m = o.mode ?? "auto";
  if (m !== "auto") return m;
  return process.env.ANTHROPIC_API_KEY ? "live" : "recorded";
}

const inputName = (req: BuiltRequest, root?: string): string =>
  req.attachment ? (root ? relative(root, req.attachment.path) : req.attachment.path) : `${req.task} request`;

const billed = (u: Anthropic.Usage): BilledUsage => ({
  input_tokens: u.input_tokens,
  output_tokens: u.output_tokens,
  cache_creation_input_tokens: u.cache_creation_input_tokens,
  cache_read_input_tokens: u.cache_read_input_tokens,
  cache_creation: u.cache_creation,
});

export async function run(req: BuiltRequest, o: RunOptions = {}): Promise<RunResult> {
  const mode = resolveMode(o);
  const store = o.store ?? RECORDED_DIR;
  if (mode === "recorded") {
    const r = readRecord(store, req.prompt_sha256, inputName(req, o.root));
    return { meta: { model: r.model, prompt_sha256: req.prompt_sha256, mode, recording: r.recording, label: labelOf(mode, r.recording) }, output: r.output };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("live mode needs ANTHROPIC_API_KEY");
  checkBudget(req.params.model, o.spendFile);
  let res: Anthropic.Message;
  try {
    const client: MessagesClient = o.client ?? new Anthropic({ apiKey });
    res = await client.messages.create(req.params);
  } catch (e) {
    throw redactKey(e, apiKey);
  }
  // Priced with the requested model (Haiku 5.5 has no fallback, so it is the model that answered); a refused or cut-off
  // response is billed too, so it is counted before those checks.
  recordSpend({ model: req.params.model, task: req.task, prompt_sha256: req.prompt_sha256, usage: billed(res.usage) }, o.spendFile);
  if (res.stop_reason === "refusal") throw new AiRefused(res.stop_details?.category ?? null);
  if (res.stop_reason === "max_tokens") throw new Error(`${req.task}: response cut off at max_tokens`);
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const output: unknown = JSON.parse(text);
  if (o.record) {
    const rec: RecordFile = {
      format: "pourproof.ai-recording/1",
      prompt_sha256: req.prompt_sha256,
      task: req.task,
      input: inputName(req, o.root),
      input_sha256: req.attachment?.sha256 ?? null,
      model: res.model,
      recording: "live call",
      note: "Response of a live API call, stored by npm run record -w packages/ai.",
      stop_reason: res.stop_reason,
      output,
    };
    writeRecord(store, rec);
  }
  return { meta: { model: res.model, prompt_sha256: req.prompt_sha256, mode, label: labelOf(mode) }, output };
}
