// Runs without ANTHROPIC_API_KEY: every call answers from recorded_responses/ (mode "recorded"). Checks the extracted
// fields against the values the sample documents were made from, the "unverified" path of the PDF check, and that
// an explanation with a number not in the stats is rejected.
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEMO_EPDS,
  DEMO_TICKETS,
  NoRecording,
  RECORDED_DIR,
  REPO_ROOT,
  checkNumbers,
  checkPdfField,
  demoAnomalyCases,
  epdRequest,
  explainAnomaly,
  explainRequest,
  extractEpd,
  extractTicket,
  pdfPages,
  readRecord,
  resolveMode,
  run,
  sha256Hex,
  ticketRequest,
  type RecordFile,
} from "../src/index.ts";

const R = { mode: "recorded" as const, root: REPO_ROOT };
const abs = (p: string) => join(REPO_ROOT, p);
const inputs = JSON.parse(readFileSync(abs("data/scenario/inputs.json"), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "pourproof-ai-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A store holding one committed record, changed by `edit`: lets a test feed the code a response the model could give. */
function storeWith(hash: string, edit: (r: RecordFile) => void): string {
  const dir = mkdtempSync(join(tmp, "store-"));
  const r = readRecord(RECORDED_DIR, hash, "test");
  edit(r);
  writeFileSync(join(dir, `${hash}.json`), JSON.stringify(r));
  return dir;
}

const localTime = (unix: number) => {
  const d = new Date((unix + 3 * 3600) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return { date: `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`, hm: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` };
};

describe("recorded mode", () => {
  it("is the default without ANTHROPIC_API_KEY, and live mode refuses to run without it", async () => {
    if (!process.env.ANTHROPIC_API_KEY) expect(resolveMode({})).toBe("recorded");
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(run(ticketRequest(abs(DEMO_TICKETS[0])), { mode: "live" })).rejects.toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("has a committed recording for every demo request, made from the current files", () => {
    const hashes = [
      ...DEMO_TICKETS.map((p) => [p, ticketRequest(abs(p))] as const),
      ...DEMO_EPDS.map((p) => [p, epdRequest(abs(p))] as const),
    ];
    for (const [p, req] of hashes) {
      const r = readRecord(RECORDED_DIR, req.prompt_sha256, p);
      expect(r.input).toBe(p);
      expect(r.input_sha256).toBe(sha256Hex(readFileSync(abs(p))));
      expect(r.task).toBe(req.task);
    }
    for (const c of demoAnomalyCases()) expect(readRecord(RECORDED_DIR, explainRequest(c.flags, c.stats).prompt_sha256, c.id).task).toBe("explainAnomaly");
    const names = new Set(readdirSync(RECORDED_DIR));
    expect(names.size).toBe(hashes.length + demoAnomalyCases().length);
  });

  it("labels a handwritten fixture as such and never as a live answer", async () => {
    const t = await extractTicket(abs(DEMO_TICKETS[0]), R);
    expect(t.mode).toBe("recorded");
    expect(t.recording).toBe("handwritten fixture");
    expect(t.label).toBe("recorded response (handwritten fixture)");
    expect(t.model).toMatch(/^none: handwritten fixture/);
    expect(t.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws NoRecording for a request with no stored response", async () => {
    const empty = mkdtempSync(join(tmp, "empty-"));
    await expect(extractEpd(abs(DEMO_EPDS[0]), { ...R, store: empty })).rejects.toBeInstanceOf(NoRecording);
  });
});

describe("prompt_sha256", () => {
  it("is stable and changes with one byte of the input file", () => {
    const p = abs(DEMO_EPDS[0]);
    expect(epdRequest(p).prompt_sha256).toBe(epdRequest(p).prompt_sha256);
    const copy = join(tmp, "copy.pdf");
    copyFileSync(p, copy);
    expect(epdRequest(copy).prompt_sha256).toBe(epdRequest(p).prompt_sha256);
    writeFileSync(copy, Buffer.concat([readFileSync(p), Buffer.from("\n")]));
    expect(epdRequest(copy).prompt_sha256).not.toBe(epdRequest(p).prompt_sha256);
  });
});

describe("extractTicket", () => {
  for (const label of ["P-001", "P-002"]) {
    it(`reads ticket ${label}: values match what the ticket was made from, each one waits for a person`, async () => {
      const t = await extractTicket(abs(`data/sample-docs/delivery-ticket-${label}.png`), R);
      const pour = inputs.pours[label];
      const start = localTime(JSON.parse(readFileSync(abs(`data/pours/${label}/batches.json`), "utf8")).pourStart);
      expect(t.fields.pour_id.value).toBe(label);
      expect(t.fields.mix_code.value).toBe(pour.ticket.mix_code);
      expect(pour.ticket.truck_plate.startsWith(t.fields.truck_plate.value!)).toBe(true);
      expect(Number(t.fields.volume.value)).toBe(pour.volume_m3);
      expect(t.fields.volume.unit).toBe("m3");
      expect(Number(t.fields.cement_content.value)).toBe(inputs.mixes[pour.delivered_mix].cement_kg_per_m3);
      expect(t.fields.date.value).toBe(start.date);
      expect(t.fields.discharge_start.value).toBe(start.hm);
      expect(t.counts).toEqual({ verified: 0, needs_review: 12, unverified: 0 });
    });
  }
});

describe("extractEpd", () => {
  for (const [file, key] of [
    [DEMO_EPDS[0], "mix_a_baseline"],
    [DEMO_EPDS[1], "mix_b_actual"],
  ] as const) {
    it(`reads ${file}: every field verified against the PDF text, values match inputs.json`, async () => {
      const e = await extractEpd(abs(file), R);
      const mix = inputs.mixes[key];
      expect(e.counts).toEqual({ verified: 10, needs_review: 0, unverified: 0 });
      expect(e.fields.mix_code.value).toBe(mix.mix_code);
      expect(Number(e.fields.cement_content.value)).toBe(mix.cement_kg_per_m3);
      expect([Number(e.fields.gwp_total_low.value), Number(e.fields.gwp_total_high.value)]).toEqual(mix.gwp_total_kg_per_m3);
      expect(e.fields.gwp_total_low.source.page).toBe(1);
      expect(e.document_sha256).toBe(sha256Hex(readFileSync(abs(file))));
    });
  }

  it("marks a field unverified when the quote is not on the page, the value is not in the quote, or the page does not exist", async () => {
    const p = abs(DEMO_EPDS[0]);
    const store = storeWith(epdRequest(p).prompt_sha256, (r) => {
      const o = r.output as Record<string, { value: string; quote: string; page: number }>;
      o.gwp_total_low.value = "395";
      o.gwp_total_low.quote = "GWP-total, modules A1-A3: 395 to 411 kg CO2e per m3 of concrete.";
      o.cement_content.value = "330";
      o.declared_unit.page = 3;
    });
    const e = await extractEpd(p, { ...R, store });
    expect(e.fields.gwp_total_low).toMatchObject({ status: "unverified", reason: "quote not found in the text of page 1" });
    expect(e.fields.cement_content).toMatchObject({ status: "unverified", reason: "value not found inside the quote" });
    expect(e.fields.declared_unit).toMatchObject({ status: "unverified", reason: "page 3 does not exist in the PDF" });
    expect(e.fields.gwp_total_high.status).toBe("verified");
    expect(e.counts).toEqual({ verified: 7, needs_review: 0, unverified: 3 });
  });

  it("does not accept a quote from the wrong page", () => {
    const pages = pdfPages(abs(DEMO_EPDS[0]));
    const quote = "Cement: 380 kg/m3 x 974.92 kg CO2e/t = 370.5 kg CO2e/m3";
    expect(checkPdfField({ value: "370.5", unit: null, page: 2, quote }, pages).status).toBe("verified");
    expect(checkPdfField({ value: "370.5", unit: null, page: 1, quote }, pages).status).toBe("unverified");
  });
});

describe("explainAnomaly", () => {
  const cases = demoAnomalyCases();

  it("computes the flags with packages/core: P-002 has no hydration signature, the missing batch is a gap", () => {
    expect(cases.map((c) => [c.id, c.flags])).toEqual([
      ["P-002", ["no_hydration_signature"]],
      ["missing-batch", ["gap"]],
    ]);
    expect(cases[1].stats).toMatchObject({ longest_step_h: 6.5, gaps: [{ from_h: 18, to_h: 24.5 }] });
  });

  for (const c of cases) {
    it(`accepts the recorded explanation for ${c.id}: every number in it comes from the stats`, async () => {
      const x = await explainAnomaly(c.flags, c.stats, R);
      expect(x.status).toBe("accepted");
      expect(x.text).toBeTruthy();
      expect(x.unknown_numbers).toEqual([]);
      expect(x.mode).toBe("recorded");
    });
  }

  it("rejects an explanation that makes up a number, and does not return its text as the explanation", async () => {
    const c = cases[1];
    const store = storeWith(explainRequest(c.flags, c.stats).prompt_sha256, (r) => {
      (r.output as { text: string }).text = "One step is 6.5 hours long, so the concrete probably reached about 21 MPa by then.";
    });
    const x = await explainAnomaly(c.flags, c.stats, { ...R, store });
    expect(x.status).toBe("rejected");
    expect(x.text).toBeNull();
    expect(x.unknown_numbers).toEqual(["21"]);
    expect(x.rejected_text).toMatch(/21 MPa/);
  });

  it("refuses to explain when the rules raised no flag", async () => {
    await expect(explainAnomaly([], cases[0].stats, R)).rejects.toThrow(/no flags/);
  });
});

describe("checkNumbers", () => {
  const stats = { peak: 18.9, corr: -0.97, gaps: [{ from_h: 18, to_h: 24.5 }] };
  it("accepts numbers written exactly as in the stats, sign aside", () => {
    expect(checkNumbers("peak 18.9, correlation -0.97, from 18 to 24.5", stats).ok).toBe(true);
    expect(checkNumbers("no numbers at all", stats).ok).toBe(true);
  });
  it("rejects rounded, reformatted or new numbers", () => {
    expect(checkNumbers("peak 19", stats).unknown).toEqual(["19"]);
    expect(checkNumbers("from 18.0 h", stats).unknown).toEqual(["18.0"]);
    expect(checkNumbers("28 days", stats).unknown).toEqual(["28"]);
  });
});
