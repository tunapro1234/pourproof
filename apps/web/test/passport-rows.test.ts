// Passport rows on the Embodied CO2, Mix and claim cards: the inventory, the two parts of the cement saving, the range
// note, the scope, the one-claim note and the baseline cap. No signature check here; the cards read chain state and inputs.
import { describe, expect, it } from "vitest";
import { about10, carbonView, savingSplit } from "../src/compute.ts";
import type { PourModel } from "../src/model.ts";
import { carbonCard, claimStatus, mixCard } from "../src/views/pour.ts";
import { inputs, view } from "./fixtures.ts";

type CardModel = Pick<PourModel, "view" | "chain" | "inputs" | "delivered" | "baseline">;

function cardModel(label: string): CardModel {
  const inp = inputs.pours[label];
  return {
    view,
    chain: view.pours[label],
    inputs: inp,
    delivered: inputs.mixes[inp.delivered_mix],
    baseline: inp.baseline_mix ? inputs.mixes[inp.baseline_mix] : null,
  };
}

/** Text of one element (by data-testid) as a reader sees it: tags dropped, entities decoded, spaces collapsed. */
function textOf(html: string, testid: string): string | null {
  const m = html.match(new RegExp(`<(\\w+)[^>]*data-testid="${testid}"[^>]*>([\\s\\S]*?)</\\1>`));
  if (!m) return null;
  return m[2]
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/ ([.,;)])/g, "$1")
    .trim();
}

const p1 = cardModel("P-001");
const vol1 = p1.chain.state.pour.volumeDm3 / 1000;
const saving1 = p1.chain.state.savingRange.map(Number);

describe("savingSplit", () => {
  const split = savingSplit(p1.baseline!, p1.delivered, vol1);
  const cementDiff = (m: typeof p1.delivered) => (m.cement_gwp_kg_per_m3[0] + m.cement_gwp_kg_per_m3[1]) / 2;

  it("the two parts add up to the cement difference, and both are positive", () => {
    expect(split.quantity.per_m3).toBeGreaterThan(0);
    expect(split.type.per_m3).toBeGreaterThan(0);
    expect(split.quantity.per_m3 + split.type.per_m3).toBeCloseTo(cementDiff(p1.baseline!) - cementDiff(p1.delivered), 9);
    expect(split.total.per_m3).toBeCloseTo(cementDiff(p1.baseline!) - cementDiff(p1.delivered), 9);
    expect(split.quantity.kg + split.type.kg).toBeCloseTo(split.total.kg, 9);
    expect(split.total.kg).toBeCloseTo(split.total.per_m3 * vol1, 9);
  });

  it("with the sample mixes: about 468 kg less cement, 210 kg cement type, 678 kg together for P-001", () => {
    expect(split.quantity.kg).toBeGreaterThan(463);
    expect(split.quantity.kg).toBeLessThan(473);
    expect(split.type.kg).toBeGreaterThan(205);
    expect(split.type.kg).toBeLessThan(215);
    expect(split.total.kg).toBeGreaterThan(673);
    expect(split.total.kg).toBeLessThan(683);
    expect(split.cement_kg_per_m3).toEqual({ baseline: p1.baseline!.cement_kg_per_m3, delivered: p1.delivered.cement_kg_per_m3 });
  });

  it("the cement difference sits inside the saving range on chain", () => {
    expect(split.total.kg).toBeGreaterThan(saving1[0]);
    expect(split.total.kg).toBeLessThan(saving1[1]);
  });

  it("about10 rounds kg to 10 kg", () => {
    expect([about10(468.0), about10(209.8), about10(678.4), about10(5)]).toEqual([470, 210, 680, 10]);
  });
});

describe("Embodied CO2 card", () => {
  const html = carbonCard(p1);
  const split = savingSplit(p1.baseline!, p1.delivered, vol1);
  const c = carbonView(vol1, p1.delivered, p1.baseline);
  const n = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 0 });

  it("in order: inventory, baseline and its cap, saving and its split, range note, scope then source", () => {
    const order = ["inventory", "baseline-cap", "saving", "saving-split", "range-note", "scope"].map((id) => html.indexOf(`data-testid="${id}"`));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.indexOf("Scope: A1-A3")).toBeLessThan(html.indexOf("Source: sample EPDs"));
  });

  it("the inventory is the delivered mix's absolute footprint, computed", () => {
    expect(textOf(html, "inventory")).toContain(
      `Inventory, delivered mix: ${n(c.delivered.low_kg)} to ${n(c.delivered.high_kg)} kg CO2e (absolute, A1-A3, GWP-total). This is the pour's own footprint; the saving below is an avoided-emissions claim and sits outside the inventory.`,
    );
  });

  it("the saving row stays; below it the two parts and the cement difference, rounded to 10 kg", () => {
    expect(textOf(html, "saving")).toContain(`${n(saving1[0])} to ${n(saving1[1])} kg CO2e`);
    const text = textOf(html, "saving-split");
    expect(text).toContain(
      `Less cement: about ${n(split.quantity.per_m3)} kg CO2e/m³ (${about10(split.quantity.kg)} kg for ${vol1} m³), from ${p1.baseline!.cement_kg_per_m3} vs ${p1.delivered.cement_kg_per_m3} kg/m³ cement. The strength record backs this part.`,
    );
    expect(text).toContain(
      `Cement type: about ${n(split.type.per_m3)} kg CO2e/m³ (${about10(split.type.kg)} kg), from the two cement EPDs. The supplier's EPD declares this part; a curing record cannot prove it.`,
    );
    expect(text).toContain(`Cement difference alone: about ${about10(split.total.kg)} kg for ${vol1} m³.`);
  });

  it("the range note reads the range from the chain and says it is not an error bar", () => {
    expect(textOf(html, "range-note")).toBe(
      `The ${saving1[0]} to ${saving1[1]} kg range comes from the sample mixes' other constituents counted on both sides. It is not an error bar.`,
    );
  });

  it("scope label and baseline cap, word for word", () => {
    expect(textOf(html, "scope")).toBe(
      "Scope: A1-A3, GWP-total. Cement factors from a US-PCR EPD (ISO 21930, NSF PCR v3.2, not EN 15804) that includes transport to the US market.",
    );
    expect(textOf(html, "baseline-cap")).toBe("Baseline cap against a regional benchmark: not yet. The contractor's declared baseline is used as is.");
  });

  it("P-002 (no baseline): inventory and scope, no split, no range note, no cap", () => {
    const h2 = carbonCard(cardModel("P-002"));
    expect(h2).toContain('data-testid="inventory"');
    expect(h2).toContain('data-testid="scope"');
    expect(h2).toContain("No saving: no baseline was declared before this pour.");
    for (const id of ["saving-split", "range-note", "baseline-cap", "saving"]) expect(h2).not.toContain(`data-testid="${id}"`);
  });
});

describe("Mix and volume card", () => {
  it("each sample cement basis says 'assumption'; a strength class gets its note", () => {
    const html = mixCard(p1);
    const bases = [...html.matchAll(/data-testid="cement-basis">\(([^)]*)\)/g)].map((m) => m[1]);
    expect(bases).toHaveLength(2);
    for (const b of bases) expect(b).toMatch(/assumption/);
    expect(html).toContain("C30/37 (assumed strength class, sample)");
    expect(html.match(/\(assumed strength class, sample\)/g)).toHaveLength(html.match(/C\d\d\/\d\d/g)!.length);
  });

  it("P-002: no baseline", () => {
    expect(mixCard(cardModel("P-002"))).toContain("<strong>Baseline:</strong> none declared");
  });
});

describe("Saving claim card", () => {
  it("P-001: one claim, by the supplier, and what that means if it is ever sold", () => {
    expect(textOf(claimStatus(p1), "one-claim")).toBe(
      "Reduction claim recorded once, by the supplier. If it is ever sold as a certificate, the delivered mix is reported at baseline intensity.",
    );
  });

  it("P-002: no claim, no note", () => {
    expect(claimStatus(cardModel("P-002"))).not.toContain('data-testid="one-claim"');
  });
});
