// Live mode: reads the ledger over JSON-RPC with viem. Read calls only; there is no wallet and nothing is signed.
// Refused calls cannot be found in logs (a reverted transaction emits no events), so live mode asks the node what
// would happen if the other parties called claimSaving now (eth_call) and shows that as a simulated call.
import { BaseError, ContractFunctionRevertedError, createPublicClient, http, type Address, type PublicClient } from "viem";
import { pourIdOf, type Hex } from "@pourproof/core";
import { LEDGER_ABI, LEDGER_EVENTS, LEDGER_READS } from "./abi.ts";
import { NETWORK_LABEL, TIME_MODE, TIME_NOTE, plain, type ChainEvent, type ChainPour, type ChainView, type NetworkName, type PourState, type Rejected } from "./chain.ts";
import { accountRoles, whoIs } from "./roles.ts";

export interface LiveConfig {
  network: NetworkName;
  rpcUrl: string;
  ledger: Hex;
  /** first block to scan for events (the deployment block) */
  fromBlock: bigint;
  /** pour labels to name pour ids with (pourId = keccak256(label)) */
  labels: string[];
  /** blocks per eth_getLogs request; public RPCs cap the range */
  logChunk?: bigint;
}

export function liveClient(rpcUrl: string): PublicClient {
  return createPublicClient({ transport: http(rpcUrl, { batch: true, retryCount: 2 }) }) as PublicClient;
}

export async function readLive(c: LiveConfig, client: PublicClient = liveClient(c.rpcUrl)): Promise<ChainView> {
  const chainId = await client.getChainId();
  const head = await client.getBlock();
  const chunk = c.logChunk ?? 5000n;
  const logs = [];
  for (let from = c.fromBlock; from <= head.number; from += chunk) {
    const to = from + chunk - 1n < head.number ? from + chunk - 1n : head.number;
    logs.push(...(await client.getLogs({ address: c.ledger, events: LEDGER_EVENTS, fromBlock: from, toBlock: to, strict: true })));
  }
  const blocks = [...new Set(logs.map((l) => l.blockNumber))];
  const times = new Map<bigint, bigint>();
  await Promise.all(blocks.map(async (n) => times.set(n, (await client.getBlock({ blockNumber: n })).timestamp)));
  const events: ChainEvent[] = logs
    .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
    .map((l) => ({
      name: l.eventName,
      args: plain(l.args) as Record<string, unknown>,
      block: l.blockNumber.toString(),
      timestamp: times.get(l.blockNumber)!.toString(),
      txHash: l.transactionHash,
      logIndex: l.logIndex,
    }));

  const byId = new Map(c.labels.map((label) => [pourIdOf(label).toLowerCase(), label]));
  const ids = events.filter((e) => e.name === "PourCreated").map((e) => String(e.args.pourId) as Hex);
  const roles = accountRoles(events);
  const read = (functionName: "pour" | "baseline" | "deviceOf" | "nextCounter" | "savingRange", id: Hex) =>
    client.readContract({ address: c.ledger, abi: LEDGER_READS, functionName, args: [id] }) as Promise<unknown>;

  const pours: Record<string, ChainPour> = {};
  for (const id of ids) {
    const label = byId.get(id.toLowerCase()) ?? id;
    const state = plain({
      pour: await read("pour", id),
      baseline: await read("baseline", id),
      device: await read("deviceOf", id),
      nextCounter: await read("nextCounter", id),
      savingRange: await read("savingRange", id),
    }) as PourState;
    pours[label] = { label, pourId: id, state, rejected: await probeClaims(client, c.ledger, id, state, roles) };
  }

  return {
    source: "live",
    sourceLabel: `live read from ${c.rpcUrl}, block ${head.number}`,
    network: c.network,
    networkLabel: NETWORK_LABEL[c.network],
    timeMode: TIME_MODE[c.network],
    timeNote: TIME_NOTE[TIME_MODE[c.network]],
    chainId,
    ledger: c.ledger.toLowerCase() as Hex,
    block: head.number.toString(),
    blockTimestamp: head.timestamp.toString(),
    events,
    pours,
  };
}

/** After a claim, asks the node what a claimSaving by each other party would do now (eth_call, nothing is sent). */
async function probeClaims(client: PublicClient, ledger: Hex, id: Hex, s: PourState, roles: Map<string, string[]>): Promise<Rejected[]> {
  const zero = /^0x0{40}$/i;
  if (zero.test(s.pour.claimant)) return [];
  const parties = [s.pour.supplier, s.pour.contractor].filter((a) => !zero.test(a) && a.toLowerCase() !== s.pour.claimant.toLowerCase());
  const out: Rejected[] = [];
  for (const account of parties) {
    try {
      await client.simulateContract({ address: ledger, abi: LEDGER_ABI, functionName: "claimSaving", args: [id], account: account as Address });
      out.push({ kind: "simulated call", role: whoIs(account, roles as never), account, fn: "claimSaving", revert: null });
    } catch (e) {
      const r = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
      const data = r instanceof ContractFunctionRevertedError ? r.data : undefined;
      out.push({
        kind: "simulated call",
        role: whoIs(account, roles as never),
        account,
        fn: "claimSaving",
        revert: data ? { name: data.errorName, args: plain(data.args ?? []) as unknown[] } : { name: "unknown revert", args: [] },
      });
    }
  }
  return out;
}
