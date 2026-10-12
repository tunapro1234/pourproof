// Builds each Claude request in one place, so the live call, the recording and prompt_sha256 all come from the same
// object. prompt_sha256 = sha256 of the canonical JSON of the request, with each attached file replaced by its sha256
// and size: it names the exact instructions, schema, model and input file behind an output.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

// Haiku 5.5 is the default model under the team's API budget. It has no server-side refusal fallback: a decline stops
// the call (AiRefused) and nothing else answers in its place.
export const MODEL = "claude-haiku-5-5";
export const MAX_TOKENS = 16000;

export type Task = "extractTicket" | "extractEpd" | "explainAnomaly";

export interface Attachment {
  kind: "image" | "pdf";
  path: string;
  bytes: Buffer;
  sha256: string;
}

export interface BuiltRequest {
  task: Task;
  params: Anthropic.MessageCreateParamsNonStreaming;
  attachment?: Attachment;
  prompt_sha256: string;
}

export const sha256Hex = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

export function attach(path: string): Attachment {
  const bytes = readFileSync(path);
  const lower = path.toLowerCase();
  if (lower.endsWith(".pdf")) return { kind: "pdf", path, bytes, sha256: sha256Hex(bytes) };
  if (lower.endsWith(".png")) return { kind: "image", path, bytes, sha256: sha256Hex(bytes) };
  throw new Error(`unsupported file type: ${basename(path)} (expected .png or .pdf)`);
}

/** Keys sorted at every level, no whitespace. */
export function canonical(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]));
    return x;
  };
  return JSON.stringify(sort(v));
}

function fileBlock(a: Attachment): Anthropic.ContentBlockParam {
  const data = a.bytes.toString("base64");
  return a.kind === "pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
    : { type: "image", source: { type: "base64", media_type: "image/png", data } };
}

export function build(task: Task, system: string, text: string, schema: Record<string, unknown>, attachment?: Attachment): BuiltRequest {
  const content: Anthropic.ContentBlockParam[] = [];
  if (attachment) content.push(fileBlock(attachment));
  content.push({ type: "text", text });
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    // The fixed part of every request of a task (instructions, then the output schema) comes first and ends in a cache
    // breakpoint; the document and the per-request text follow it. A prefix under the model's minimum (512 tokens on
    // Haiku 5.5) is simply not cached; usage.cache_read_input_tokens shows whether it was.
    system: [
      { type: "text", text: system },
      { type: "text", text: `The response is JSON matching this schema:\n${canonical(schema)}`, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content }],
    output_config: { format: { type: "json_schema", schema } },
  };
  const hashed = {
    ...params,
    messages: [
      {
        role: "user",
        content: [...(attachment ? [{ type: attachment.kind, sha256: attachment.sha256, size: attachment.bytes.length }] : []), { type: "text", text }],
      },
    ],
  };
  return { task, params, attachment, prompt_sha256: sha256Hex(canonical(hashed)) };
}
