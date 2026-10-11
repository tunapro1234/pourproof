import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, type Abi, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { batchDigest, merkleRoot, leafHash, saving, verifyDigest, type Hex } from "@pourproof/core";
import { REPO_ROOT, type BatchesFile } from "@pourproof/device";
import { canonical, checkBalances, docHash, evidencePackage, loadLedgerArtifact, loadRoleKeys, revertOf, rolesKeygen, sha256Hex, type EvidenceDataset, type ScenarioInputs } from "../src/index.ts";

const read = <T>(p: string) => JSON.parse(readFileSync(join(REPO_ROOT, p), "utf8")) as T;
const tmp = mkdtempSync(join(tmpdir(), "pourproof-chain-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("json helpers", () => {
  it("canonical JSON sorts keys at every level and handles bigints", () => {
    expect(canonical({ b: 1, a: { d: 2n, c: [3, { f: 1, e: 0 }] } })).toBe('{"a":{"c":[3,{"e":0,"f":1}],"d":"2"},"b":1}');
    expect(sha256Hex("abc")).toBe("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("revertOf", () => {
  it("returns the custom error name and arguments from a reverted call", () => {
    const { abi } = loadLedgerArtifact();
    const pourId = `0x${"11".repeat(32)}` as Hex;
    const first = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const data = encodeErrorResult({ abi, errorName: "AlreadyClaimed", args: [pourId, first] });
    const err = new BaseError("call failed", { cause: new ContractFunctionRevertedError({ abi: abi as Abi, data, functionName: "claimSaving" }) });
    expect(revertOf(err)).toEqual({ name: "AlreadyClaimed", args: [pourId, first] });
    expect(revertOf(new Error("network down"))).toBeNull();
  });
});

describe("role keys for Base Sepolia", () => {
  it("roles-keygen writes mode 600 and refuses to overwrite; load checks mode and distinct roles", () => {
    const path = join(tmp, "roles.json");
    const { addresses } = rolesKeygen({ path });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => rolesKeygen({ path })).toThrow(/exists/);
    const keys = loadRoleKeys(path);
    expect(privateKeyToAccount(keys.supplier).address).toBe(addresses.supplier);
    expect(privateKeyToAccount(keys.admin).address).toBe(addresses.funder);
    expect(keys.relay).toBe(keys.admin);
    chmodSync(path, 0o644);
    expect(() => loadRoleKeys(path)).toThrow(/must be 600/);
    const f = JSON.parse(readFileSync(path, "utf8"));
    f.owner = f.supplier;
    writeFileSync(path, JSON.stringify(f), { mode: 0o600 });
    chmodSync(path, 0o600);
    expect(() => loadRoleKeys(path)).toThrow(/distinct/);
    f.owner = { ...f.inspector, address: f.supplier.address };
    writeFileSync(path, JSON.stringify(f));
    expect(() => loadRoleKeys(path)).toThrow(/does not match/);
    expect(() => loadRoleKeys(join(tmp, "none.json"))).toThrow(/roles-keygen/);
  });

  it("an underfunded role stops the run before any transaction, with no fallback to Anvil", async () => {
    // Stand-in client: only the two reads checkBalances makes.
    const client = { getGasPrice: async () => 1_000_000n, getBalance: async () => 0n } as unknown as PublicClient;
    const a = "0x0000000000000000000000000000000000000001";
    await expect(checkBalances(client, { admin: a, supplier: a, contractor: a, inspector: a, owner: a, relay: a }, "baseSepolia")).rejects.toThrow(
      /not enough test ETH.*no fallback to Anvil/s,
    );
    const rich = { getGasPrice: async () => 1_000_000n, getBalance: async () => 10n ** 18n } as unknown as PublicClient;
    await expect(checkBalances(rich, { admin: a, supplier: a, contractor: a, inspector: a, owner: a, relay: a }, "baseSepolia")).resolves.toBeUndefined();
  });
});

// The committed Anvil run (npm run scenario -w packages/chain -- --network anvil). The run is deterministic: a fixed
// genesis time and 12 s blocks, so re-running it rewrites these files byte for byte.
describe("committed Anvil scenario", () => {
  interface LogStep {
    step: number;
    pour: string | null;
    role: string;
    fn: string;
    args: string[];
    status: string;
    events: { name: string; args: Record<string, string> }[];
    revert: { name: string; args: string[] } | null;
  }
  const log = read<{ chainId: number; ledger: Hex; deviceKind: string; evidence: { path: string; sha256: Hex }; steps: LogStep[] }>("scenario/anvil-log.json");
  const dep = read<{ chainId: number; ledger: { address: Hex } }>("deployments/anvil.json");
  const snap = read<{
    block: string;
    ledger: Hex;
    events: { name: string; args: Record<string, string> }[];
    pours: Record<string, { pourId: Hex; batches: { counter: number; fromTs: number; toTs: number; root: Hex; r: Hex; s: Hex; readings: [number, number][] }[]; device: { qx: Hex; qy: Hex }; chain: { pour: Record<string, unknown>; savingRange: [string, string]; nextCounter: string } }>;
  }>("apps/web/public/snapshot/anvil.json");
  const p1 = read<BatchesFile>("data/pours/P-001/batches.json");
  const p2 = read<BatchesFile>("data/pours/P-002/batches.json");

  it("deployment, log, snapshot and device files describe the same ledger", () => {
    expect(dep.chainId).toBe(31337);
    for (const x of [log.ledger, snap.ledger, p1.context.ledger, p2.context.ledger]) expect(x.toLowerCase()).toBe(dep.ledger.address.toLowerCase());
    expect(p1.context.chainId).toBe(31337);
  });

  it("runs the P-001 story in order and the second claim is rejected on chain", () => {
    const seq = log.steps.filter((s) => s.pour === "P-001" && s.fn !== "appendBatch").map((s) => `${s.role}:${s.fn}:${s.status}`);
    expect(seq).toEqual([
      "contractor:declareBaseline:success",
      "supplier:createPour:success",
      "inspector:registerDevice:success",
      "contractor:acceptPour:success",
      "inspector:approveStrength:success",
      "supplier:claimSaving:success",
      "contractor:claimSaving:reverted",
    ]);
    const claims = log.steps.filter((s) => s.fn === "claimSaving");
    expect(claims[0].events.map((e) => e.name)).toEqual(["SavingClaimed"]);
    expect(claims[1].revert?.name).toBe("AlreadyClaimed");
    expect(claims[1].revert?.args[1]).toBe(claims[0].events[0].args.claimant);
    expect(log.steps.filter((s) => s.pour === "P-001" && s.fn === "appendBatch" && s.status === "success")).toHaveLength(p1.batches.length);
    const reg = log.steps.find((s) => s.fn === "registerDevice")!;
    expect(reg.events[0]).toMatchObject({ name: "DeviceRegistered", args: { deviceKind: "simulated" } });
  });

  it("P-002: the batch signed by another device and the skipped batch are rejected, the honest record is complete", () => {
    const bad = log.steps.filter((s) => s.pour === "P-002" && s.status === "reverted");
    expect(bad.map((s) => s.revert?.name)).toEqual(["BadSignature", "CounterGap"]);
    expect(bad.every((s) => s.events.length === 0)).toBe(true);
    expect(snap.pours["P-002"].chain.nextCounter).toBe(String(p2.batches.length));
    expect(snap.pours["P-002"].chain.pour.strengthApproved).toBe(false);
    expect(p2.anomaly.flags).toContain("no_hydration_signature");
  });

  it("every other transaction succeeded", () => {
    const expected = new Set(["AlreadyClaimed", "BadSignature", "CounterGap"]);
    for (const s of log.steps) expect(s.status === "success" || expected.has(s.revert?.name ?? "")).toBe(true);
  });

  it("evidenceHash on chain = sha256 of the evidence file, which packages/core rebuilds from the signed readings", () => {
    const text = readFileSync(join(REPO_ROOT, log.evidence.path), "utf8");
    expect(sha256Hex(text)).toBe(log.evidence.sha256);
    expect(snap.pours["P-001"].chain.pour.evidenceHash).toBe(log.evidence.sha256);
    const inputs = read<ScenarioInputs>("data/scenario/inputs.json");
    const dataset = read<EvidenceDataset>("data/dataset/mendeley-nmr8pjx8d8.json");
    const in1 = inputs.pours["P-001"];
    const ev = evidencePackage({
      pour: p1,
      dataset,
      network: "anvil",
      baseline: inputs.mixes[in1.baseline_mix!],
      delivered: inputs.mixes[in1.delivered_mix],
      volume_m3: in1.volume_m3,
      strengthReference: in1.strength_reference,
    });
    expect(ev.text).toBe(text);
    expect(ev.pkg.strength.label).toBe("estimated range, inspector decides");
    for (const c of ev.pkg.strength.checkpoints) expect(c.strength.low_mpa).toBeLessThanOrEqual(c.strength.high_mpa);
  });

  it("ticketHash, epdHash and baselineMixHash on chain are the sha256 of the committed sample documents", () => {
    const inputs = read<ScenarioInputs>("data/scenario/inputs.json");
    for (const label of ["P-001", "P-002"]) {
      const p = inputs.pours[label];
      expect(snap.pours[label].chain.pour.ticketHash).toBe(docHash(p.ticket_doc));
      expect(snap.pours[label].chain.pour.epdHash).toBe(docHash(inputs.mixes[p.delivered_mix].epd_doc));
    }
    const base = inputs.mixes[inputs.pours["P-001"].baseline_mix!];
    expect((snap.pours["P-001"].chain as unknown as { baseline: { mixHash: Hex } }).baseline.mixHash).toBe(docHash(base.epd_doc));
    expect(docHash(base.epd_doc)).not.toBe(docHash(inputs.mixes.mix_b_actual.epd_doc));
  });

  it("on-chain saving range matches the core calculation on the declared integers", () => {
    const inputs = read<ScenarioInputs>("data/scenario/inputs.json");
    const [bl, bh] = inputs.mixes.mix_a_baseline.gwp_total_kg_per_m3;
    const [al, ah] = inputs.mixes.mix_b_actual.gwp_total_kg_per_m3;
    const s = saving({ low: bl, high: bh }, { low: al, high: ah }, inputs.pours["P-001"].volume_m3);
    expect(snap.pours["P-001"].chain.savingRange).toEqual([String(s.low_kg), String(s.high_kg)]);
  });

  it("snapshot batches match the BatchAppended events and verify against the registered device key", () => {
    const appended = snap.events.filter((e) => e.name === "BatchAppended");
    expect(appended).toHaveLength(p1.batches.length + p2.batches.length);
    for (const label of ["P-001", "P-002"]) {
      const p = snap.pours[label];
      const onChain = new Map(appended.filter((e) => e.args.pourId === p.pourId).map((e) => [Number(e.args.counter), e.args.root]));
      for (const b of p.batches) {
        const root = merkleRoot(b.readings.map(([t_unix, temp_milliC]) => leafHash({ t_unix, temp_milliC })));
        expect(root).toBe(b.root);
        expect(onChain.get(b.counter)).toBe(b.root);
        const digest = batchDigest({ chainId: 31337, ledger: snap.ledger, pourId: p.pourId, counter: b.counter, fromTs: b.fromTs, toTs: b.toTs, root });
        expect(verifyDigest(digest, b, p.device)).toBe(true);
      }
    }
  });
});
