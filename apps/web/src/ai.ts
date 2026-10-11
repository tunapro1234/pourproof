// AI outputs as the web app shows them: public/ai/outputs.json, written by `npm run export-ai -w apps/web` from
// packages/ai in recorded mode. Claude proposes each field with the page and quote it read it from; code checks it
// (verified / needs_review / unverified) and a person approves. An unverified field cannot be approved.

export type FieldStatus = "verified" | "needs_review" | "unverified";

export interface AiField {
  value: string | null;
  unit: string | null;
  source: { page: number; quote: string };
  status: FieldStatus;
  reason: string;
}

export interface AiMeta {
  model: string;
  prompt_sha256: string;
  mode: "live" | "recorded";
  recording?: "live call" | "handwritten fixture";
  /** "live", "recorded response" or "recorded response (handwritten fixture)", shown as is */
  label: string;
}

export interface AiExtraction extends AiMeta {
  task: "extractTicket" | "extractEpd";
  document: string;
  document_sha256: string;
  fields: Record<string, AiField>;
  counts: Record<FieldStatus, number>;
}

export interface AiExplanation extends AiMeta {
  task: "explainAnomaly";
  case_label: string;
  flags: string[];
  stats: Record<string, unknown>;
  status: "accepted" | "rejected";
  text: string | null;
  unknown_numbers: string[];
  rejected_text: string | null;
}

export interface AiPour {
  ticket: AiExtraction;
  epds: (AiExtraction & { role: "baseline" | "delivered"; mix: string })[];
  explanation: AiExplanation | null;
}

export interface AiFile {
  format: "pourproof.web-ai/1";
  note: string;
  pours: Record<string, AiPour>;
}

export const STATUS_TEXT: Record<FieldStatus, string> = {
  verified: "verified: quote found on the cited PDF page, value inside the quote",
  needs_review: "needs review: a photo has no text layer, compare with the image",
  unverified: "unverified: approval locked",
};

/** The label every AI output carries on screen: live answers say "live", stored ones "recorded response". */
export function aiLabel(m: AiMeta): string {
  if (m.mode === "live") return "live";
  return m.recording === "handwritten fixture" ? "recorded response (handwritten fixture)" : "recorded response";
}
