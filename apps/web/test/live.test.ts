// Live mode against a real node: starts a private Anvil, runs the scenario on it (writing into a temp dir), then reads
// the chain with the web app's live reader. What it reads must equal the committed snapshot, and the published
// batches must verify against it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Address } from "viem";
import { anvil } from "viem/chains";
import type { Hex } from "@pourproof/core";
import { ROLE_NAMES, rpc, runScenario, startAnvil, type AnvilNode, type RoleName } from "@pourproof/chain";
import { eventsOf, type ChainView } from "../src/chain.ts";
import { readLive } from "../src/live.ts";
import { verifyBatches } from "../src/verify.ts";
import { batchesOf, snapshot, view as recorded } from "./fixtures.ts";

let node: AnvilNode;
let live: ChainView;
const out = mkdtempSync(join(tmpdir(), "pourproof-web-live-"));

beforeAll(async () => {
  node = await startAnvil(anvil.id);
  const accts = await rpc<Address[]>(node.url, "eth_accounts");
  const roles = Object.fromEntries(ROLE_NAMES.map((r, i) => [r, accts[i]])) as Record<RoleName, Address>;
  await runScenario({ network: "anvil", chain: anvil, rpcUrl: node.url, roles, pollingInterval: 20, outRoot: out, writeDataPours: false, log: () => {} });
  live = await readLive({ network: "anvil", rpcUrl: node.url, ledger: snapshot.ledger, fromBlock: 0n, labels: ["P-001", "P-002"], logChunk: 50n });
});

afterAll(async () => {
  await node?.stop();
  rmSync(out, { recursive: true, force: true });
});

describe("live mode (JSON-RPC, no wallet)", () => {
  it("reads the same events and pour state the snapshot recorded", () => {
    expect(live.source).toBe("live");
    expect(live.sourceLabel).toBe(`live read from ${node.url}, block ${snapshot.block}`);
    expect(live.chainId).toBe(recorded.chainId);
    expect(live.ledger).toBe(recorded.ledger);
    expect(live.block).toBe(recorded.block);
    expect(live.events).toEqual(recorded.events);
    for (const label of ["P-001", "P-002"]) expect(live.pours[label].state).toEqual(recorded.pours[label].state);
  });

  it("asks the node what a second claim would do: AlreadyClaimed, as a simulated call", () => {
    const r = live.pours["P-001"].rejected;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "simulated call", role: "contractor", fn: "claimSaving", revert: { name: "AlreadyClaimed" } });
    expect(live.pours["P-002"].rejected).toEqual([]);
  });

  it("the published batches verify against the live chain", () => {
    const p = live.pours["P-001"];
    const onChain = eventsOf(live, p.pourId, "BatchAppended").map((e) => ({ counter: Number(e.args.counter), fromTs: Number(e.args.fromTs), toTs: Number(e.args.toTs), root: e.args.root as Hex }));
    const r = verifyBatches({ chainId: live.chainId, ledger: live.ledger, pourId: p.pourId, deviceKey: { qx: p.state.device.qx, qy: p.state.device.qy }, onChain, published: batchesOf("P-001").batches });
    expect(r.ok).toBe(true);
  });
});
