// Builds each Claude request in one place, so the live call, the recording and prompt_sha256 all come from the same
// object. prompt_sha256 = sha256 of the canonical JSON of the request, with each attached file replaced by its sha256
// and size: it names the exact instructions, schema, model and input file behind an output.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-sonnet-5-5";
export const MAX_TOKENS = 16000;
// Server-side refusal fallback (Claude API only): on a policy decline the API re-runs the request on a fallback model
// inside the same call. The output records response.model, so a fallback shows up as a different model name.
export const BETAS = ["server-side-fallback-2026-07-01"];
export const FALLBACKS = "default" as const;

export type Task = "extractTicket" | "extractEpd" | "explainAnomaly";

export interface Attachment {
  kind: "image" | "pdf";
  path: string;
  bytes: Buffer;
  sha256: string;
}

export interface BuiltRequest {
  task: Task;
  params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
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

function fileBlock(a: Attachment): Anthropic.Beta.Messages.BetaContentBlockParam {
  const data = a.bytes.toString("base64");
  return a.kind === "pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
    : { type: "image", source: { type: "base64", media_type: "image/png", data } };
}

export function build(task: Task, system: string, text: string, schema: Record<string, unknown>, attachment?: Attachment): BuiltRequest {
  const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
  if (attachment) content.push(fileBlock(attachment));
  content.push({ type: "text", text });
  const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    system,
    messages: [{ role: "user", content }],
    output_config: { format: { type: "json_schema", schema } },
    betas: BETAS,
    fallbacks: FALLBACKS,
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
