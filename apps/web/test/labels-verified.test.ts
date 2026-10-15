// Screen wording checked against arastirma/dogrulama.md: the roles note on a local Anvil chain, the headline strength
// line, the notes word for word, and none of the old wordings left in the web sources.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readingsOf, strengthView } from "../src/compute.ts";
import { range } from "../src/format.ts";
import { inventoryText, ONE_CLAIM_NOTE, ROLES_NOTE, TAMPER_NOTE, TAMPER_NOTE_CLAIMED, trustNote } from "../src/labels.ts";
import { sourceBar } from "../src/views/layout.ts";
import { strengthHeadline } from "../src/views/pour.ts";
import { batchesOf, evidence, REPO, view } from "./fixtures.ts";

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe("roles note", () => {
  it("on Anvil the source bar says the roles are public dev accounts, next to the network label", () => {
    const html = sourceBar(view);
    expect(view.network).toBe("anvil");
    expect(html).toContain(`data-testid="roles-note">Roles are test accounts we run (Anvil&#39;s default dev accounts, whose keys are public).</span>`);
    expect(html.indexOf('data-testid="roles-note"')).toBeGreaterThan(html.indexOf('data-testid="network-label"'));
    expect(html.indexOf('data-testid="roles-note"')).toBeLessThan(html.indexOf('data-testid="state-label"'));
    expect(ROLES_NOTE).toBe("Roles are test accounts we run (Anvil's default dev accounts, whose keys are public).");
  });

  it("not on another network", () => {
    expect(sourceBar({ ...view, network: "baseSepolia" })).not.toContain("roles-note");
  });
});

describe("strength line", () => {
  it("day 7 estimate from the verified readings and the evidence package fit, with where the curve comes from", () => {
    const b = batchesOf("P-001");
    const sv = strengthView(readingsOf(b.batches, Number(view.pours["P-001"].state.pour.pourStart)), evidence.strength.fit);
    const d7 = sv.checkpoints.find((c) => c.age_d === 7)!;
    const pkg = evidence.strength.checkpoints.find((c) => c.age_d === 7)!;
    expect(d7.strength.low_mpa).toBeCloseTo(pkg.strength.low_mpa, 6);
    expect(strengthHeadline(sv)).toBe(
      `<p data-testid="strength-line"><strong>Estimated strength at day 7: ${range(d7.strength.low_mpa, d7.strength.high_mpa, "MPa", 1)}, from a curve fitted on the dataset&#39;s own B25 cylinders, not the delivered mix</strong>.</p>`,
    );
  });

  it("a record shorter than 7 days gets its last checkpoint", () => {
    const b = batchesOf("P-001");
    const r = readingsOf(b.batches, Number(view.pours["P-001"].state.pour.pourStart)).filter((x) => x.t_h <= 5 * 24);
    expect(strengthHeadline(strengthView(r, evidence.strength.fit))).toContain("Estimated strength at day 3: ");
  });
});

describe("notes word for word", () => {
  it("one-claim, inventory, tamper and trust notes", () => {
    expect(ONE_CLAIM_NOTE).toBe(
      "Saving claim recorded once, by the supplier. If the saving is ever issued as a certificate, the buyer of the concrete reports the delivered mix at the baseline value (Isometric draft protocol rule).",
    );
    expect(inventoryText("1", "2")).toBe(
      "Inventory, delivered mix: 1 to 2 kg CO2e (absolute, A1-A3, GWP-total). This is the pour's own footprint. The saving below is an avoided-emissions estimate against the contractor's declared baseline (A1-A3 only, not checked against a market-average mix). It sits outside the inventory and is never subtracted from it.",
    );
    expect(TAMPER_NOTE_CLAIMED).toBe("The recorded chain state did not change. Only your copy in this browser did; the claim already made used the untouched record.");
    expect(TAMPER_NOTE).toBe("The recorded chain state did not change. Only your copy in this browser did.");
    expect(trustNote("9", "abc")).toMatch(
      /Re-running the scenario yourself re-signs everything with your own keys: it checks the code, not this record\. A run on a public testnet would let you check this record; it has not run yet\.$/,
    );
  });

  it("no old wording in the web sources", () => {
    const old = ["Reduction claim recorded once", "Nothing on chain changed", "To check against a chain you run yourself", "avoided-emissions claim and sits", "not approved strength"];
    for (const f of filesUnder(join(REPO, "apps/web/src"))) {
      const text = readFileSync(f, "utf8");
      for (const o of old) expect([f, o, text.includes(o)]).toEqual([f, o, false]);
    }
  });
});
