// public/ai/outputs.json is what packages/ai returns now, and says what it is.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aiLabel, type AiFile } from "../src/ai.ts";
import { AI_FILE, aiFileText } from "../scripts/ai-file.ts";
import { evidence } from "./fixtures.ts";

const committed = readFileSync(AI_FILE, "utf8");
const file = JSON.parse(committed) as AiFile;

describe("AI outputs shown by the web app", () => {
  it("are up to date with packages/ai (run npm run export-ai -w apps/web after changing it)", async () => {
    expect(committed).toBe(await aiFileText());
  });

  it("every output carries model, prompt_sha256 and mode, and is labelled recorded or live", () => {
    const all = Object.values(file.pours).flatMap((p) => [p.ticket, ...p.epds, ...(p.explanation ? [p.explanation] : [])]);
    expect(all.length).toBe(7);
    for (const o of all) {
      expect(o.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(["live", "recorded"]).toContain(o.mode);
      expect(o.label).toBe(aiLabel(o));
      if (o.recording === "handwritten fixture") {
        expect(o.label).toBe("recorded response (handwritten fixture)");
        expect(o.model).not.toMatch(/^claude/);
      }
    }
  });

  it("P-001's outputs are the ones listed in the evidence package hashed on chain", () => {
    const p = file.pours["P-001"];
    const listed = evidence.ai!.outputs.map((o) => o.prompt_sha256);
    expect([p.ticket, ...p.epds].map((o) => o.prompt_sha256)).toEqual(listed);
  });

  it("P-002 has the rule flag and an accepted explanation; the PDF fields are verified, ticket fields wait for a person", () => {
    const p = file.pours["P-002"];
    expect(p.explanation?.flags).toEqual(["no_hydration_signature"]);
    expect(p.explanation?.status).toBe("accepted");
    expect(p.epds.map((e) => [e.role, e.counts.unverified])).toEqual([
      ["baseline", 0],
      ["delivered", 0],
    ]);
    // the same declared baseline as P-001: the same EPD and the same recorded output
    expect(p.epds[0].prompt_sha256).toBe(file.pours["P-001"].epds[0].prompt_sha256);
    expect(p.ticket.counts.needs_review).toBe(Object.keys(p.ticket.fields).length);
  });
});
