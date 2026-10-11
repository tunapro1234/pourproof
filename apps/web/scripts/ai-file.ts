// Builds public/ai/outputs.json from packages/ai, always in recorded mode, so the file is the same on every run.
// test/ai-file.test.ts fails when the committed file is out of date.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT, demoAnomalyCases, explainAnomaly, extractEpd, extractTicket, type RunOptions } from "@pourproof/ai";
import type { AiFile, AiPour } from "../src/ai.ts";

export const AI_FILE = join(REPO_ROOT, "apps/web/public/ai/outputs.json");

export async function buildAiFile(): Promise<AiFile> {
  const inputs = JSON.parse(readFileSync(join(REPO_ROOT, "data/scenario/inputs.json"), "utf8")) as {
    mixes: Record<string, { epd_doc: string }>;
    pours: Record<string, { baseline_mix: string | null; delivered_mix: string; ticket_doc: string }>;
  };
  const o: RunOptions = { mode: "recorded", root: REPO_ROOT };
  const rel = <T extends { document: string }>(x: T): T => ({ ...x, document: relative(REPO_ROOT, x.document) });
  const cases = demoAnomalyCases();
  const pours: Record<string, AiPour> = {};
  for (const [label, p] of Object.entries(inputs.pours)) {
    const epds: AiPour["epds"] = [];
    for (const [role, mix] of [["baseline", p.baseline_mix], ["delivered", p.delivered_mix]] as const) {
      if (mix) epds.push({ role, mix, ...rel(await extractEpd(join(REPO_ROOT, inputs.mixes[mix].epd_doc), o)) } as AiPour["epds"][number]);
    }
    const c = cases.find((x) => x.id === label);
    pours[label] = {
      ticket: rel(await extractTicket(join(REPO_ROOT, p.ticket_doc), o)) as AiPour["ticket"],
      epds,
      explanation: c ? ({ case_label: c.label, ...(await explainAnomaly(c.flags, c.stats, o)) } as AiPour["explanation"]) : null,
    };
  }
  return {
    format: "pourproof.web-ai/1",
    note: "Written by npm run export-ai -w apps/web from packages/ai in recorded mode. Each output says whether it is a live answer or a recorded response; a handwritten fixture says so too.",
    pours,
  };
}

export const aiFileText = async (): Promise<string> => JSON.stringify(await buildAiFile(), null, 1) + "\n";
