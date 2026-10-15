// "Fake a warm night": tamper forms, nights, the saving the record supports, what an edited copy would claim, and the
// card and hero text. Run on the committed snapshot, published batches and evidence package; no number is typed in.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { eventsOf, type ChainView } from "../src/chain.ts";
import { CHECKPOINT_DAYS, claimableNow, forgedClaim, readingsOf, strengthView } from "../src/compute.ts";
import { TZ_OFFSET_H, range } from "../src/format.ts";
import { checkPour, type PourModel } from "../src/model.ts";
import { applyTamper, COLD_NIGHT_WITHIN_D, coldNight, nightsOf, nightTemps, paramOf, parseTamper, peakNight, TAMPER_DELTA_MILLIC, TAMPER_STEPS_C, tamperHref, tamperParam, type TamperContext } from "../src/tamper.ts";
import { homeHero } from "../src/views/home.ts";
import { claimableText, trustText, tryIt } from "../src/views/pour.ts";
import { batchesOf, evidence, inputs, REPO, view } from "./fixtures.ts";

const p1 = batchesOf("P-001");
const p2 = batchesOf("P-002");
const start1 = Number(view.pours["P-001"].state.pour.pourStart);
const ctx1: TamperContext = { batches: p1.batches, pourStart: start1 };
const all1 = p1.batches.flatMap((b) => b.readings);
const localHour = (t: number) => new Date((t + TZ_OFFSET_H * 3600) * 1000).getUTCHours();
const savingOnChain = view.pours["P-001"].state.savingRange.map(Number);

/** A pour page model from the committed files, as loadPour builds it (documents and AI left out). Each distinct page
 * is verified once (112 P-256 checks are slow under nice 19). */
const models = new Map<string, PourModel>();
function modelOf(label: string, search = ""): PourModel {
  const key = `${label}${search}`;
  if (!models.has(key)) models.set(key, buildModel(label, search));
  return models.get(key)!;
}

function buildModel(label: string, search: string, v: ChainView = view): PourModel {
  const chain = v.pours[label];
  const file = batchesOf(label);
  const inp = inputs.pours[label];
  return {
    label,
    view: v,
    chain,
    inputs: inp,
    delivered: inputs.mixes[inp.delivered_mix],
    baseline: inp.baseline_mix ? inputs.mixes[inp.baseline_mix] : null,
    file,
    ...checkPour(v, chain, file, search),
    docs: [],
    evidence: label === "P-001" ? { path: "scenario/anvil-evidence-P-001.json", url: "/published/scenario/anvil-evidence-P-001.json", pkg: evidence, check: null as never } : null,
    ai: null,
  };
}

describe("nights of a pour", () => {
  const nights = nightsOf(p1.batches, start1);

  it("P-001: every night is the readings from 18:00 to 06:00 local time after the pour start, in order", () => {
    expect(nights.length).toBeGreaterThan(20);
    nights.forEach((n, k) => {
      expect(n.n).toBe(k + 1);
      const rs = all1.slice(n.from, n.to + 1);
      for (const r of rs) expect(localHour(r.t_unix) >= 18 || localHour(r.t_unix) < 6).toBe(true);
      expect(rs[0].t_unix).toBe(n.from_unix);
      expect(rs[rs.length - 1].t_unix).toBe(n.to_unix);
      // the readings just before and after the night are daytime
      if (n.from > 0) expect(localHour(all1[n.from - 1].t_unix)).toBeGreaterThanOrEqual(6);
      if (n.to + 1 < all1.length) expect(localHour(all1[n.to + 1].t_unix)).toBeLessThan(18);
      // a night spans at most 12 h
      expect(n.to_unix - n.from_unix).toBeLessThan(12 * 3600);
    });
    expect(nights[0].from_unix).toBeGreaterThanOrEqual(start1);
    // every night reading of the pour is in exactly one night
    const inNights = nights.reduce((s, n) => s + n.to - n.from + 1, 0);
    expect(inNights).toBe(all1.filter((r) => localHour(r.t_unix) >= 18 || localHour(r.t_unix) < 6).length);
  });

  it("P-002 has its own nights, from its own pour start", () => {
    const n2 = nightsOf(p2.batches, Number(view.pours["P-002"].state.pour.pourStart));
    expect(n2.length).toBeGreaterThan(20);
    expect(n2[0].from_unix).toBeGreaterThanOrEqual(Number(view.pours["P-002"].state.pour.pourStart));
  });
});

describe("parseTamper", () => {
  it("K3: the old reading:<i> link still means +5 °C", () => {
    expect(parseTamper("?tamper=reading:40", ctx1)).toEqual({ kind: "reading", index: 40, delta_milliC: TAMPER_DELTA_MILLIC });
    expect(TAMPER_DELTA_MILLIC).toBe(5000);
  });

  it("reads reading:<i>:<d> and night:<n>:<d> (whole degrees, -10 to 10, not 0)", () => {
    expect(parseTamper("?tamper=reading:40:-1", ctx1)).toEqual({ kind: "reading", index: 40, delta_milliC: -1000 });
    expect(parseTamper("?tamper=reading:0:10", ctx1)).toEqual({ kind: "reading", index: 0, delta_milliC: 10000 });
    const n1 = nightsOf(p1.batches, start1)[0];
    expect(parseTamper("?tamper=night:1:5", ctx1)).toEqual({ kind: "range", from: n1.from, to: n1.to, delta_milliC: 5000, night: 1 });
    const last = nightsOf(p1.batches, start1).at(-1)!;
    expect(parseTamper(`?tamper=night:${last.n}:-10`, ctx1)).toMatchObject({ kind: "range", from: last.from, to: last.to, delta_milliC: -10000 });
  });

  it("K4: anything else is null", () => {
    const nights = nightsOf(p1.batches, start1).length;
    for (const v of ["reading:40:0", "reading:40:11", "reading:40:1.5", "reading:-1:5", "reading:x", "night:0:5", "night:999:5", `night:${nights + 1}:5`, `reading:${all1.length}`, "night:1", "night:1:0", "night:1:-11", "reading:40:+5", "batch:1"]) {
      expect(parseTamper(`?tamper=${encodeURIComponent(v)}`, ctx1), v).toBeNull();
    }
    expect(parseTamper("", ctx1)).toBeNull();
    // without the pour a night cannot be resolved
    expect(parseTamper("?tamper=night:1:5")).toBeNull();
  });

  it("K4: an invalid parameter opens the page untouched (green)", () => {
    const m = modelOf("P-001", "?tamper=night:999:5");
    expect(m.tamper).toBeNull();
    expect(m.applied).toBeNull();
    expect(m.verify.ok).toBe(true);
  });

  it("tamperParam, paramOf and tamperHref round-trip", () => {
    for (const d of TAMPER_STEPS_C) {
      for (const target of [{ kind: "reading" as const, index: 40 }, { kind: "night" as const, n: 3 }]) {
        const p = tamperParam(target, d);
        const t = parseTamper(`?tamper=${p}`, ctx1)!;
        expect(t.delta_milliC).toBe(d * 1000);
        expect(paramOf(t)).toBe(p);
        const href = tamperHref("/pour/P-001?mode=live", p);
        expect(href.startsWith("/pour/P-001?mode=live&tamper=")).toBe(true);
        expect(href.endsWith("#try")).toBe(true);
        expect(parseTamper(href.slice(href.indexOf("?"), href.indexOf("#")), ctx1)).toEqual(t);
      }
    }
  });
});

describe("applyTamper", () => {
  it("one reading by -1 °C and by +5 °C", () => {
    for (const d of [-1000, 5000]) {
      const t = applyTamper(p1.batches, { kind: "reading", index: 40, delta_milliC: d })!;
      expect(t.applied.count).toBe(1);
      expect(t.applied.changed[0].after_milliC - t.applied.changed[0].before_milliC).toBe(d);
      expect(t.batches.flatMap((b) => b.readings)[40].temp_milliC).toBe(all1[40].temp_milliC + d);
    }
  });

  it("a night: every reading of that night changes, nothing else; the batches it touches are listed", () => {
    for (const n of [1, 2, nightsOf(p1.batches, start1).length]) {
      const night = nightsOf(p1.batches, start1)[n - 1];
      const t = applyTamper(p1.batches, parseTamper(`?tamper=night:${n}:5`, ctx1)!)!;
      expect(t.applied.count).toBe(night.to - night.from + 1);
      const after = t.batches.flatMap((b) => b.readings);
      after.forEach((r, i) => expect(r.temp_milliC - all1[i].temp_milliC).toBe(i >= night.from && i <= night.to ? 5000 : 0));
      const counters = [...new Set(p1.batches.flatMap((b) => b.readings.map(() => b.counter)).slice(night.from, night.to + 1))];
      expect(t.applied.counters).toEqual(counters);
      expect(counters.length).toBeGreaterThan(1);
    }
    // the input is not modified
    expect(p1.batches.flatMap((b) => b.readings).map((r) => r.temp_milliC)).toEqual(all1.map((r) => r.temp_milliC));
  });

  it("K2: any night, any step: the record no longer verifies and the changed batches are named", () => {
    const nights = nightsOf(p1.batches, start1).length;
    // every step once, on nights from the first to the last (each case is a full verification)
    const cases = TAMPER_STEPS_C.map((d, k) => [[1, 2, Math.ceil(nights / 2), nights][k], d]);
    for (const [n, d] of cases) {
      const m = modelOf("P-001", `?tamper=night:${n}:${d}`);
      expect(m.verify.ok).toBe(false);
      expect(m.verify.batches.filter((b) => !b.ok).map((b) => b.counter)).toEqual(m.applied!.counters);
      expect(m.verify.batches.filter((b) => !b.ok).every((b) => !b.rootMatches && b.signatureValid)).toBe(true);
      expect(claimableNow(m)).toEqual({ status: "unsupported", reason: "the curing record does not verify" });
    }
  });
});

describe("claimableNow: the saving the record supports", () => {
  it("K1: P-001 as signed: claimed once by the supplier, the range from the SavingClaimed event", () => {
    const m = modelOf("P-001");
    const c = claimableNow(m);
    expect(c).toEqual({ status: "claimed", by: "supplier", saving: { low_kg: savingOnChain[0], high_kg: savingOnChain[1] } });
    expect(claimableText(m)).toBe(`Saving this record supports: ${range(savingOnChain[0], savingOnChain[1], "kg CO2e")}, already claimed once by supplier. A second claim reverts on chain.`);
  });

  it("a record that does not verify supports none", () => {
    const m = modelOf("P-001", "?tamper=night:1:5");
    expect(claimableText(m)).toBe("Saving this record supports: none. The curing record does not verify.");
  });

  it("K5: P-002 verifies but the inspector approved nothing", () => {
    const m = modelOf("P-002");
    expect(m.verify.ok).toBe(true);
    expect(claimableNow(m)).toEqual({ status: "unsupported", reason: "the inspector has not approved this pour's curing record" });
    expect(claimableText(m)).toBe("Saving this record supports: none. The inspector has not approved this pour's curing record.");
  });

  it("not claimed yet: supported, with the ledger's savingRange", () => {
    const unclaimed: ChainView = { ...view, events: view.events.filter((e) => e.name !== "SavingClaimed") };
    const m = { ...modelOf("P-001"), view: unclaimed };
    expect(claimableNow(m)).toEqual({ status: "supported", saving: { low_kg: savingOnChain[0], high_kg: savingOnChain[1] } });
    expect(claimableText(m)).toBe(`Saving this record supports: ${range(savingOnChain[0], savingOnChain[1], "kg CO2e")}, not claimed yet.`);
  });

  it("no baseline declared before the pour: none", () => {
    const p = view.pours["P-001"];
    const noBaseline: ChainView = {
      ...view,
      events: view.events.filter((e) => e.name !== "SavingClaimed"),
      pours: { ...view.pours, "P-001": { ...p, state: { ...p.state, baseline: { ...p.state.baseline, mixHash: `0x${"00".repeat(32)}` } } } },
    };
    expect(claimableNow({ ...modelOf("P-001"), view: noBaseline, chain: noBaseline.pours["P-001"] })).toEqual({ status: "unsupported", reason: "no baseline was declared before the pour" });
  });

  it("no baseline comes before no approval", () => {
    const p = view.pours["P-002"];
    const noBaseline: ChainView = { ...view, pours: { ...view.pours, "P-002": { ...p, state: { ...p.state, baseline: { ...p.state.baseline, mixHash: `0x${"00".repeat(32)}` } } } } };
    expect(p.state.pour.strengthApproved).toBe(false);
    expect(claimableNow({ ...modelOf("P-002"), view: noBaseline, chain: noBaseline.pours["P-002"] })).toEqual({ status: "unsupported", reason: "no baseline was declared before the pour" });
  });
});

describe("forgedClaim: what the edited copy would claim", () => {
  it("is null without a tamper, and on P-002 (no evidence package, no strength fit)", () => {
    expect(forgedClaim(modelOf("P-001"))).toBeNull();
    expect(forgedClaim(modelOf("P-002", "?tamper=night:1:5"))).toBeNull();
  });

  it("a warmer night raises the claimed early strength, a colder one lowers it; signed numbers stay those of the published readings", () => {
    const up = forgedClaim(modelOf("P-001", "?tamper=night:1:5"))!;
    const down = forgedClaim(modelOf("P-001", "?tamper=night:1:-5"))!;
    const night1 = nightsOf(p1.batches, start1)[0];
    const expectedDay = CHECKPOINT_DAYS.find((d) => d * 24 >= (night1.to_unix - start1) / 3600)!;
    expect(up.age_d).toBe(expectedDay);
    expect(up.forged.high_mpa).toBeGreaterThan(up.signed.high_mpa);
    expect(up.forged.low_mpa).toBeGreaterThan(up.signed.low_mpa);
    expect(down.forged.high_mpa).toBeLessThan(down.signed.high_mpa);
    expect(up.signed).toEqual(down.signed);
    const sig = evidence.strength.checkpoints.find((c) => c.age_d === expectedDay)!;
    expect(up.signed.low_mpa).toBeCloseTo(sig.strength.low_mpa, 6);
    expect(up.signed.high_mpa).toBeCloseTo(sig.strength.high_mpa, 6);
  });

  it("a later night is judged at the first checkpoint after it", () => {
    const nights = nightsOf(p1.batches, start1);
    const late = nights[nights.length - 1];
    const f = forgedClaim(modelOf("P-001", `?tamper=night:${late.n}:5`))!; // same page as the last K2 case
    const lastH = readingsOf(p1.batches, start1).at(-1)!.t_h;
    const days = CHECKPOINT_DAYS.filter((d) => d * 24 <= lastH);
    expect(f.age_d).toBe(days.find((d) => d * 24 >= (late.to_unix - start1) / 3600) ?? days[days.length - 1]);
  });
});

describe("the cold night the card opens on", () => {
  const nights = nightTemps(p1.batches, start1);
  const peak = peakNight(nights)!;
  const cold = coldNight(p1.batches, start1)!;

  it("the peak night is the warmest; the cold night comes after it, within the first days, with the lowest mean of those", () => {
    for (const n of nights) expect(n.mean_c).toBeLessThanOrEqual(peak.mean_c);
    expect(cold.n).toBeGreaterThan(peak.n);
    expect(cold.to_unix - start1).toBeLessThanOrEqual(COLD_NIGHT_WITHIN_D * 86400);
    const candidates = nights.filter((n) => n.n > peak.n && n.to_unix - start1 <= COLD_NIGHT_WITHIN_D * 86400);
    expect(candidates.length).toBeGreaterThan(1);
    for (const n of candidates) expect(cold.mean_c).toBeLessThanOrEqual(n.mean_c);
    // the night's temperatures are those of its signed readings
    const t = all1.slice(cold.from, cold.to + 1).map((r) => r.temp_milliC / 1000);
    expect([cold.min_c, cold.max_c]).toEqual([Math.min(...t), Math.max(...t)]);
    // colder than the peak night by a wide margin: the record's own numbers, no constant typed here
    expect(cold.max_c).toBeLessThan(peak.min_c);
  });

  it("P-002 has a cold night of its own", () => {
    const start2 = Number(view.pours["P-002"].state.pour.pourStart);
    expect(coldNight(p2.batches, start2)).not.toBeNull();
  });

  it("+5 °C on it: the forged claim is the first decision day after the night that the edit moves; small but caught", () => {
    const f = forgedClaim(modelOf("P-001", `?tamper=night:${cold.n}:5`))!;
    const nightEndH = (cold.to_unix - start1) / 3600;
    const after = CHECKPOINT_DAYS.filter((d) => d * 24 >= nightEndH);
    expect(after).toContain(f.age_d);
    const shown = (x: { low_mpa: number; high_mpa: number }) => `${x.low_mpa.toFixed(1)}/${x.high_mpa.toFixed(1)}`;
    expect(shown(f.forged)).not.toBe(shown(f.signed));
    // every earlier decision day after the night shows the same range either way
    const fit = evidence.strength.fit;
    const signed = strengthView(readingsOf(p1.batches, start1), fit);
    const forged = strengthView(readingsOf(modelOf("P-001", `?tamper=night:${cold.n}:5`).batches, start1), fit);
    for (const d of after.filter((d) => d < f.age_d)) {
      expect(shown(forged.checkpoints.find((c) => c.age_d === d)!.strength)).toBe(shown(signed.checkpoints.find((c) => c.age_d === d)!.strength));
    }
    expect(f.forged.high_mpa).toBeGreaterThan(f.signed.high_mpa);
    // a small edit: under 1 MPa at either end
    expect(f.forged.high_mpa - f.signed.high_mpa).toBeLessThan(1);
    expect(modelOf("P-001", `?tamper=night:${cold.n}:5`).verify.ok).toBe(false);
  });
});

describe("card and hero text", () => {
  const snapSha = createHash("sha256").update(readFileSync(join(REPO, "apps/web/public/snapshot/anvil.json"))).digest("hex");

  it("K9: the trust note names the snapshot block and its sha256, computed when built", () => {
    const html = trustText(view);
    expect(html).toContain(`block ${view.block}, sha256 <span class="mono" title="${snapSha}">${snapSha.slice(0, 12)}</span>`);
    expect(html).toContain("It does not show that the server is honest.");
    expect(html).toContain(
      "It does not show that the server is honest. Re-running the scenario yourself re-signs everything with your own keys: it checks the code, not this record. A run on a public testnet would let you check this record; it has not run yet.",
    );
    expect(html).not.toContain("To check against a chain you run yourself");
    expect(trustText({ ...view, source: "live", rpcUrl: "http://127.0.0.1:8545" })).toBe("Live mode: chain state read from http://127.0.0.1:8545");
  });

  it("P-001 card: every night is a link, the change buttons, the claim line, the sources line; no forged claim before a change", () => {
    const html = tryIt(modelOf("P-001"), "");
    const cold = coldNight(p1.batches, start1)!;
    expect(html).toContain('id="try"');
    expect(html).toContain("<h2>Fake a warm night</h2>");
    expect(html.match(/data-testid="try-night"/g)).toHaveLength(nightsOf(p1.batches, start1).length);
    // opens on the cold night: its chip is picked, the change buttons edit it, its readings and temperatures are shown
    expect(html).toMatch(new RegExp(`aria-current="true" data-testid="try-night">${cold.n}<`));
    expect(html).toContain(`href="${tamperHref("/pour/P-001", `night:${cold.n}:5`)}"`);
    expect(html).toContain(`href="${tamperHref("/pour/P-001", `night:${cold.n}:-1`)}"`);
    expect(html).toContain(`night ${cold.n}: ${cold.to - cold.from + 1} readings, `);
    expect(html).toContain(`, ${range(cold.min_c, cold.max_c, "°C", 1)} as signed</span>`);
    const peak = peakNight(nightTemps(p1.batches, start1))!;
    expect(html).toContain(
      `Night ${cold.n} (${range(cold.min_c, cold.max_c, "°C", 1)}) is the coldest night in the first ${COLD_NIGHT_WITHIN_D} days after the hydration peak (night ${peak.n}, ${range(peak.min_c, peak.max_c, "°C", 1)}), so the card opens on it.`,
    );
    expect(html).toContain("already claimed once by supplier");
    expect(html).toContain("Where the numbers come from:");
    expect(html).toContain('<a href="#carbon">the two sample EPDs shown in the passport</a>');
    expect(html).not.toContain('data-testid="forged-claim"');
    expect(html).not.toContain('data-testid="tamper-note"');
  });

  it("P-001 card after a changed night: forged claim, refusal, undo; the night and the step stay picked", () => {
    const html = tryIt(modelOf("P-001", "?tamper=night:2:-1"), "?tamper=night:2:-1");
    expect(html).toContain('data-testid="forged-claim"');
    expect(html).toMatch(/The edited copy would claim day \d+: \d+\.\d to \d+\.\d MPa, against \d+\.\d to \d+\.\d MPa from the signed readings\. It is refused below, so neither number is used\./);
    expect(html).toContain("Saving this record supports: none. The curing record does not verify.");
    expect(html).toContain("The recorded chain state did not change. Only your copy in this browser did; the claim already made used the untouched record.");
    expect(html).toContain("Undo the change");
    expect(html).toMatch(/aria-current="true" data-testid="try-night">2</);
    // another night keeps the change of -1 °C
    expect(html).toContain(`href="${tamperHref("/pour/P-001", "night:3:-1")}"`);
  });

  it("P-002 card: no forged claim even after a change, the real reason before it", () => {
    expect(tryIt(modelOf("P-002"), "").replace(/&#39;/g, "'")).toContain("Saving this record supports: none. The inspector has not approved this pour's curing record.");
    const html = tryIt(modelOf("P-002", "?tamper=night:1:5"), "?tamper=night:1:5");
    expect(html).not.toContain('data-testid="forged-claim"');
    expect(html).toContain("The recorded chain state did not change. Only your copy in this browser did.");
    expect(html).not.toContain("the claim already made");
  });

  it("home hero: numbers from the snapshot, the inputs and the published file", () => {
    const html = homeHero(view, inputs, "", p1);
    const claim = eventsOf(view, view.pours["P-001"].pourId, "SavingClaimed")[0];
    const batches = eventsOf(view, view.pours["P-001"].pourId, "BatchAppended").length;
    expect(html).toContain('data-testid="hero"');
    expect(html).toContain("Pour P-001 left one signed curing record. Fake a warm night in it and see what happens.");
    expect(html).toContain(
      `${inputs.pours["P-001"].volume_m3} m³ of a leaner mix. A simulated device replays ${all1.length.toLocaleString("en-US")} published curing readings, signs them in ${batches} batches, and anchors each batch on a local test chain. The supplier claimed the saving, ${range(Number(claim.args.savingLow_kg), Number(claim.args.savingHigh_kg), "kg CO2e")}, once; the record is what that claim rests on.`,
    );
    expect(html).toContain("Who opens it: ");
    expect(html).toContain(`href="${tamperHref("/pour/P-001", `night:${coldNight(p1.batches, start1)!.n}:5`)}"`);
    expect(html).toContain(">Open the passport of P-001</a>");
    expect(html).not.toMatch(/clinker/i);
  });
});
