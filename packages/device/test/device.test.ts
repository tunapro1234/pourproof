import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { afterAll, describe, expect, it } from "vitest";
import { anomaly, checkBatch, leafHash, pourIdOf, publicKeyOf, verifyProof, type BatchContext, type PublicKey } from "@pourproof/core";
import {
  ANVIL_FIRST_DEPLOY,
  REPO_ROOT,
  SOURCE,
  deviceKeyPath,
  keygen,
  loadDeviceKey,
  predictAppend,
  replay,
  secretsDir,
  tamperAttempts,
  toReadings,
  type BatchesFile,
  type Dataset,
  type LedgerView,
  type PublishedBatch,
  type TamperFile,
} from "../src/index.ts";

const dataset = JSON.parse(readFileSync(join(REPO_ROOT, "data", "dataset", "mendeley-nmr8pjx8d8.json"), "utf8")) as Dataset;
const tmp = mkdtempSync(join(tmpdir(), "pourproof-device-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Throwaway keys for tests only, derived from public strings.
const testKey = (seed: string) => {
  const secretKey = sha256(new TextEncoder().encode(seed));
  return { secretKey, ...publicKeyOf(secretKey) };
};
const kA = testKey("pourproof device test key A");
const kB = testKey("pourproof device test key B");

const ctxOf = (f: BatchesFile | TamperFile): BatchContext => ({ chainId: f.context.chainId, ledger: f.context.ledger, pourId: f.pourId });

/** Replays a list of submissions through the offline ledger mirror, accepting honest batches as the chain would. */
function run(ctx: BatchContext, start: number, device: PublicKey, subs: PublishedBatch[]) {
  const view: LedgerView = { nextCounter: 0, pourStart: start, device };
  return subs.map((b) => {
    const err = predictAppend(ctx, view, b);
    if (err === null) view.nextCounter = b.counter + 1;
    return err;
  });
}

describe("keygen / loadDeviceKey", () => {
  it("writes the key with mode 600 in a 700 folder, and loads it back", () => {
    const { path, key } = keygen("P-900", { dir: tmp });
    expect(path).toBe(join(tmp, "devices", "P-900.json"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(tmp, "devices")).mode & 0o777).toBe(0o700);
    const loaded = loadDeviceKey("P-900", { dir: tmp });
    expect({ qx: loaded.qx, qy: loaded.qy }).toEqual(key);
    expect(loaded.deviceKind).toBe("simulated");
    const f = JSON.parse(readFileSync(path, "utf8"));
    expect(f.pourId).toBe(pourIdOf("P-900"));
  });

  it("refuses to overwrite a key unless forced", () => {
    const first = keygen("P-901", { dir: tmp }).key;
    expect(() => keygen("P-901", { dir: tmp })).toThrow(/exists/);
    expect(keygen("P-901", { dir: tmp, force: true }).key).not.toEqual(first);
  });

  it("refuses a key file readable by others", () => {
    const { path } = keygen("P-902", { dir: tmp });
    chmodSync(path, 0o644);
    expect(() => loadDeviceKey("P-902", { dir: tmp })).toThrow(/must be 600/);
  });

  it("never keeps keys inside the repo", () => {
    expect(() => secretsDir({ POURPROOF_SECRETS: join(REPO_ROOT, "secrets") })).toThrow(/inside the repo/);
    expect(() => deviceKeyPath("P-001", join(REPO_ROOT, "data"))).toThrow(/inside the repo/);
    expect(() => deviceKeyPath("../P-001", tmp)).toThrow(/bad pour label/);
    expect(secretsDir({ POURPROOF_SECRETS: tmp })).toBe(tmp);
  });
});

describe("replay (simulated device)", () => {
  const pourStart = 1_760_000_000;
  const f = replay({ dataset, pourLabel: "P-T1", seriesName: "box1", scenario: "test", pourStart, chainId: 31337, ledger: ANVIL_FIRST_DEPLOY, key: kA });

  it("splits Box 1 into 6-hour batches of 12 readings, counters 0..n-1", () => {
    expect(f.batches).toHaveLength(dataset.series.box1.length / 12);
    f.batches.forEach((b, i) => {
      expect(b.counter).toBe(i);
      expect(b.readings).toHaveLength(12);
      expect(b.toTs - b.fromTs).toBe(11 * 1800);
    });
  });

  it("t_unix = pourStart + dataset hour * 3600, temperatures in milli-degC, nothing invented", () => {
    const flat = f.batches.flatMap((b) => b.readings);
    expect(flat).toHaveLength(dataset.series.box1.length);
    flat.forEach((r, i) => {
      expect(r.t_unix).toBe(pourStart + Math.round(dataset.series.box1[i].t_h * 3600));
      expect(r.temp_milliC).toBe(Math.round(dataset.series.box1[i].temp_c * 1000));
    });
  });

  it("every batch verifies against the device key, every reading proves into its root", () => {
    for (const b of f.batches) {
      expect(checkBatch(ctxOf(f), b, kA)).toEqual({ ok: true });
      for (const r of b.readings) {
        expect(r.leaf).toBe(leafHash(r));
        expect(verifyProof(r.proof, b.root, r.leaf)).toBe(true);
      }
    }
  });

  it("labels the output as simulated and replayed from the published dataset", () => {
    expect(f.deviceKind).toBe("simulated");
    expect(f.source).toBe("replayed from published dataset (Mendeley nmr8pjx8d8, CC BY 4.0)");
    expect(f.dataset.license).toBe("CC BY 4.0");
    expect(JSON.stringify(f)).not.toMatch(/secretKey/);
  });

  it("the offline ledger mirror accepts the honest sequence", () => {
    expect(run(ctxOf(f), pourStart, kA, f.batches).every((e) => e === null)).toBe(true);
  });

  it("the offline ledger mirror predicts each revert", () => {
    const ctx = ctxOf(f);
    const view = (nextCounter: number, device: PublicKey | null = kA): LedgerView => ({ nextCounter, pourStart, device });
    expect(predictAppend(ctx, view(0, null), f.batches[0])).toBe("NoDevice");
    expect(predictAppend(ctx, view(1), f.batches[2])).toBe("CounterGap");
    expect(predictAppend(ctx, { ...view(0), pourStart: f.batches[0].fromTs + 1 }, f.batches[0])).toBe("BadBatchWindow");
    expect(predictAppend(ctx, view(0, kB), f.batches[0])).toBe("BadSignature");
    expect(predictAppend({ ...ctx, pourId: pourIdOf("P-T2") }, view(0), f.batches[0])).toBe("BadSignature");
  });

  it("tamper attempts: skipped batch -> CounterGap, other device's key -> BadSignature", () => {
    const t = tamperAttempts(f, { pourLabel: "P-T0", ...kB });
    const ctx = ctxOf(f);
    for (const a of t.attempts) {
      const res = run(ctx, pourStart, kA, [...f.batches.slice(0, a.afterCounter + 1), a.batch]);
      expect(res.slice(0, -1).every((e) => e === null)).toBe(true);
      expect(res[res.length - 1]).toBe(a.expectRevert);
    }
    const other = t.attempts.find((a) => a.id === "other_device_key")!;
    // A genuine signature, just from the wrong device.
    expect(checkBatch(ctx, other.batch, kB)).toEqual({ ok: true });
    expect(other.batch.root).toBe(f.batches[1].root);
  });
});

describe("committed outputs in data/pours", () => {
  const load = <T>(p: string) => JSON.parse(readFileSync(join(REPO_ROOT, "data", "pours", p), "utf8")) as T;
  const p1 = load<BatchesFile>("P-001/batches.json");
  const p2 = load<BatchesFile>("P-002/batches.json");
  const tamper = load<TamperFile>("P-002/tamper.json");

  it("carry deviceKind 'simulated' and the dataset source, and no secret material", () => {
    for (const f of [p1, p2, tamper]) {
      expect(f.deviceKind).toBe("simulated");
      expect(f.source).toBe(SOURCE);
    }
    for (const dir of readdirSync(join(REPO_ROOT, "data", "pours"))) {
      for (const file of readdirSync(join(REPO_ROOT, "data", "pours", dir))) {
        expect(readFileSync(join(REPO_ROOT, "data", "pours", dir, file), "utf8")).not.toMatch(/secret/i);
      }
    }
    expect(p1.device).not.toEqual(p2.device);
  });

  for (const [f, series] of [
    [p1, "box1"],
    [p2, "ambient"],
  ] as const) {
    it(`${f.pourLabel}: replays ${series}, all batches signed by its device and every proof holds`, () => {
      expect(f.pourId).toBe(pourIdOf(f.pourLabel));
      expect(f.dataset.series).toBe(series);
      const flat = f.batches.flatMap((b) => b.readings);
      expect(flat.map(({ t_unix, temp_milliC }) => ({ t_unix, temp_milliC }))).toEqual(
        dataset.series[series].map((r) => ({ t_unix: f.pourStart + Math.round(r.t_h * 3600), temp_milliC: Math.round(r.temp_c * 1000) })),
      );
      expect(run(ctxOf(f), f.pourStart, f.device, f.batches).every((e) => e === null)).toBe(true);
      for (const b of f.batches) {
        expect(checkBatch(ctxOf(f), b, f.device)).toEqual({ ok: true });
        for (const r of b.readings) expect(verifyProof(r.proof, b.root, leafHash(r))).toBe(true);
      }
    });
  }

  it("the stored anomaly result is what core computes from the signed readings", () => {
    for (const f of [p1, p2]) {
      const { reference: _, ...stored } = f.anomaly;
      expect(stored).toEqual(anomaly(toReadings(f.batches.flatMap((b) => b.readings), f.pourStart), dataset.series.ambient));
    }
    expect(p1.anomaly.flags).toEqual([]);
    expect(p2.anomaly.flags).toContain("no_hydration_signature");
  });

  it("P-002 tamper file: each attempt gets the revert it claims, and the forged batch is P-001's device", () => {
    expect(tamper.pourId).toBe(p2.pourId);
    expect(tamper.context).toEqual(p2.context);
    for (const a of tamper.attempts) {
      const res = run(ctxOf(p2), p2.pourStart, p2.device, [...p2.batches.slice(0, a.afterCounter + 1), a.batch]);
      expect(res[res.length - 1]).toBe(a.expectRevert);
    }
    const other = tamper.attempts.find((a) => a.id === "other_device_key")!;
    expect(other.signer).toEqual({ pourLabel: "P-001", ...p1.device });
    expect(checkBatch(ctxOf(p2), other.batch, p1.device)).toEqual({ ok: true });
    expect(tamper.attempts.map((a) => a.expectRevert).sort()).toEqual(["BadSignature", "CounterGap"]);
  });

  it("changing one reading breaks exactly that reading's proof", () => {
    const b = p1.batches[3];
    const i = 7;
    const bad = { t_unix: b.readings[i].t_unix, temp_milliC: b.readings[i].temp_milliC + 2000 };
    b.readings.forEach((r, k) => expect(verifyProof(r.proof, b.root, leafHash(k === i ? bad : r))).toBe(k !== i));
  });
});
