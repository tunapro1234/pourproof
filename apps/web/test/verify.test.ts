// Browser verification logic, run on the committed snapshot and published batches.
import { describe, expect, it } from "vitest";
import type { Hex } from "@pourproof/core";
import { eventsOf, type ChainView } from "../src/chain.ts";
import { fmtTime } from "../src/format.ts";
import { applyTamper, parseTamper, TAMPER_DELTA_MILLIC } from "../src/tamper.ts";
import { readingMismatch, verifyBatches, type BatchesFile, type OnChainBatch, type VerifyInput } from "../src/verify.ts";
import { batchesOf, view } from "./fixtures.ts";

function inputFor(v: ChainView, label: string, file: BatchesFile): VerifyInput {
  const p = v.pours[label];
  const onChain: OnChainBatch[] = eventsOf(v, p.pourId, "BatchAppended").map((e) => ({
    counter: Number(e.args.counter),
    fromTs: Number(e.args.fromTs),
    toTs: Number(e.args.toTs),
    root: e.args.root as Hex,
  }));
  return { chainId: v.chainId, ledger: v.ledger, pourId: p.pourId, deviceKey: { qx: p.state.device.qx, qy: p.state.device.qy }, onChain, published: file.batches };
}

const p1 = batchesOf("P-001");
const p2 = batchesOf("P-002");

describe("verifyBatches on the recorded chain state", () => {
  for (const [label, file] of [["P-001", p1], ["P-002", p2]] as const) {
    it(`${label}: every batch matches its on-chain root and every signature verifies with the registered key`, () => {
      const r = verifyBatches(inputFor(view, label, file));
      expect(r.problems).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.batches).toHaveLength(112);
      expect(r.readings).toBe(1344);
      expect(r.batches.every((b) => b.rootMatches && b.signatureValid && b.windowMatches)).toBe(true);
    });
  }

  it("the device key used is the one registered on chain, and the published file says the same", () => {
    const reg = eventsOf(view, view.pours["P-001"].pourId, "DeviceRegistered")[0];
    expect(reg.args.qx).toBe(view.pours["P-001"].state.device.qx);
    expect(p1.device.qx).toBe(reg.args.qx);
  });
});

describe("tamper: ?tamper=reading:<i>", () => {
  it("parses only reading:<non-negative integer>", () => {
    expect(parseTamper("?tamper=reading:40")).toEqual({ kind: "reading", index: 40 });
    expect(parseTamper("?mode=snapshot&tamper=reading:0")).toEqual({ kind: "reading", index: 0 });
    expect(parseTamper("?tamper=reading:-1")).toBeNull();
    expect(parseTamper("?tamper=batch:1")).toBeNull();
    expect(parseTamper("")).toBeNull();
  });

  it("one changed reading turns verification red and names that reading; the signature over the on-chain root still holds", () => {
    const t = applyTamper(p1.batches, { kind: "reading", index: 40 })!;
    const original = p1.batches[3].readings[4];
    expect(t.applied).toMatchObject({ counter: 3, t_unix: original.t_unix, before_milliC: original.temp_milliC, after_milliC: original.temp_milliC + TAMPER_DELTA_MILLIC });
    expect(p1.batches[3].readings[4].temp_milliC).toBe(original.temp_milliC); // input untouched

    const r = verifyBatches({ ...inputFor(view, "P-001", p1), published: t.batches });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([readingMismatch(original.t_unix)]);
    expect(r.problems[0]).toBe(`Reading ${fmtTime(original.t_unix)} does not match the signed root`);
    const bad = r.batches.filter((b) => !b.ok);
    expect(bad.map((b) => b.counter)).toEqual([3]);
    expect(bad[0].rootMatches).toBe(false);
    expect(bad[0].signatureValid).toBe(true);
    expect(bad[0].badReadings).toEqual([{ index: 40, counter: 3, t_unix: original.t_unix, temp_milliC: original.temp_milliC + TAMPER_DELTA_MILLIC }]);
  });

  it("works on the first and last reading, and an index past the end changes nothing", () => {
    for (const i of [0, 1343]) {
      const t = applyTamper(p1.batches, { kind: "reading", index: i })!;
      const r = verifyBatches({ ...inputFor(view, "P-001", p1), published: t.batches });
      expect(r.ok).toBe(false);
      expect(r.batches.flatMap((b) => b.badReadings.map((x) => x.index))).toEqual([i]);
    }
    expect(applyTamper(p1.batches, { kind: "reading", index: 1344 })).toBeNull();
  });

  it("without published proofs the batch still fails, reported as a batch", () => {
    const t = applyTamper(p1.batches, { kind: "reading", index: 40 })!;
    const stripped = t.batches.map((b) => ({ ...b, readings: b.readings.map(({ t_unix, temp_milliC }) => ({ t_unix, temp_milliC })) }));
    const r = verifyBatches({ ...inputFor(view, "P-001", p1), published: stripped });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(["Batch 3 does not match the signed root (no per-reading proofs published, so the changed reading cannot be named)"]);
    expect(r.batches[3].badReadings).toEqual([]);
  });
});

describe("other failures", () => {
  it("another pour's device key: every signature fails", () => {
    const i = inputFor(view, "P-001", p1);
    const r = verifyBatches({ ...i, deviceKey: { qx: view.pours["P-002"].state.device.qx, qy: view.pours["P-002"].state.device.qy } });
    expect(r.ok).toBe(false);
    expect(r.batches.every((b) => b.rootMatches && !b.signatureValid)).toBe(true);
  });

  it("a different ledger or chain id: the rebuilt digest differs, signatures fail", () => {
    const i = inputFor(view, "P-001", p1);
    expect(verifyBatches({ ...i, ledger: "0x000000000000000000000000000000000000dead" }).batches.some((b) => b.signatureValid)).toBe(false);
    expect(verifyBatches({ ...i, chainId: 84532 }).batches.some((b) => b.signatureValid)).toBe(false);
  });

  it("a root on chain that differs from the readings is caught even when the file's own root field was edited to match", () => {
    const i = inputFor(view, "P-001", p1);
    const onChain = i.onChain.map((b) => (b.counter === 7 ? { ...b, root: `0x${"ab".repeat(32)}` as Hex } : b));
    const r = verifyBatches({ ...i, onChain });
    expect(r.batches[7].rootMatches).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("a batch withheld from the published file, or one not on chain, is reported", () => {
    const i = inputFor(view, "P-001", p1);
    expect(verifyBatches({ ...i, published: p1.batches.filter((b) => b.counter !== 5) }).problems).toContain("Batch 5 is on chain but missing from the published file");
    expect(verifyBatches({ ...i, onChain: i.onChain.filter((b) => b.counter !== 111) }).problems).toContain("Batch 111 is in the published file but not on chain");
  });
});
