// The AI part of the evidence package: which Claude outputs stand behind the ticket and EPD fields of a pour. Always
// read in recorded mode from packages/ai/recorded_responses, so the package (and the evidenceHash on chain) is the
// same on every run. Each entry names the exact request by prompt_sha256 and says how its fields fared in the checks.
import { join } from "node:path";
import { REPO_ROOT, extractEpd, extractTicket, type Extraction } from "@pourproof/ai";

export interface AiEvidenceEntry {
  task: "extractTicket" | "extractEpd";
  document: string;
  document_sha256: string;
  model: string;
  prompt_sha256: string;
  mode: string;
  label: string;
  checks: Record<string, number>;
}

export interface AiEvidence {
  note: string;
  outputs: AiEvidenceEntry[];
}

const entry = (document: string, x: Extraction<string>): AiEvidenceEntry => ({
  task: x.task,
  document,
  document_sha256: x.document_sha256,
  model: x.model,
  prompt_sha256: x.prompt_sha256,
  mode: x.mode,
  label: x.label,
  checks: { ...x.counts },
});

/** `ticket` and `epds` are paths relative to the repository root. */
export async function aiEvidence(ticket: string, epds: readonly string[]): Promise<AiEvidence> {
  const o = { mode: "recorded" as const, root: REPO_ROOT };
  const outputs = [entry(ticket, await extractTicket(join(REPO_ROOT, ticket), o))];
  for (const p of epds) outputs.push(entry(p, await extractEpd(join(REPO_ROOT, p), o)));
  return {
    note: "AI proposes field values with their source; code checks them (verified, needs_review, unverified) and the inspector decides. The AI approves nothing.",
    outputs,
  };
}
