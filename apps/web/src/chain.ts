// What the app knows about the chain, in one shape for both modes:
//  - snapshot: apps/web/public/snapshot/<network>.json, written by `npm run scenario` (recorded on-chain state)
//  - live:     read from a JSON-RPC node (see live.ts); no wallet, read calls only
// Values are kept as the snapshot stores them: uint64/uint256 as decimal strings, uint32 as numbers.
import type { Hex } from "@pourproof/core";

export type NetworkName = "anvil" | "baseSepolia";
export type TimeMode = "advanced" | "backdated";

export const NETWORK_LABEL: Record<NetworkName, string> = { anvil: "local Anvil", baseSepolia: "Base Sepolia" };
export const TIME_MODE: Record<NetworkName, TimeMode> = { anvil: "advanced", baseSepolia: "backdated" };
export const TIME_NOTE: Record<TimeMode, string> = {
  advanced: "chain clock advanced by the scenario: each batch is mined shortly after its last reading",
  backdated: "readings time-shifted into the past from the published dataset",
};

export interface ChainEvent {
  name: string;
  args: Record<string, unknown>;
  block: string;
  timestamp: string;
  txHash: Hex;
  logIndex: number;
}

export interface PourStruct {
  supplier: string;
  pourStart: string;
  volumeDm3: number;
  gwpLow: number;
  gwpHigh: number;
  contractor: string;
  nextCounter: string;
  strengthApproved: boolean;
  claimant: string;
  ticketHash: Hex;
  epdHash: Hex;
  evidenceHash: Hex;
}

export interface PourState {
  pour: PourStruct;
  baseline: { contractor: string; gwpLow: number; gwpHigh: number; mixHash: Hex };
  device: { qx: Hex; qy: Hex; kind: string };
  nextCounter: string;
  savingRange: [string, string];
}

/** A call the ledger refused. Snapshot: a mined transaction that reverted. Live: an eth_call made by this page. */
export interface Rejected {
  kind: "transaction" | "simulated call";
  role: string;
  account: string;
  fn: string;
  revert: { name: string; args: unknown[] } | null;
  txHash?: Hex;
  block?: string;
  timestamp?: string;
}

export interface ChainPour {
  label: string;
  pourId: Hex;
  state: PourState;
  rejected: Rejected[];
}

export interface ChainView {
  source: "snapshot" | "live";
  /** shown on every screen: "recorded on-chain state, block N" or "live read from <rpc>, block N" */
  sourceLabel: string;
  network: NetworkName;
  networkLabel: string;
  timeMode: TimeMode;
  timeNote: string;
  chainId: number;
  ledger: Hex;
  block: string;
  blockTimestamp: string;
  events: ChainEvent[];
  pours: Record<string, ChainPour>;
}

/** The parts of the snapshot file this app reads (the file also embeds the off-chain batches and inputs). */
export interface SnapshotFile {
  format: "pourproof.snapshot/1";
  label: string;
  network: NetworkName;
  networkLabel: string;
  timeMode: TimeMode;
  timeNote: string;
  chainId: number;
  ledger: Hex;
  block: string;
  blockTimestamp: string;
  events: ChainEvent[];
  pours: Record<string, { pourId: Hex; chain: PourState; reverted?: { role: string; account: string; fn: string; txHash: Hex; block: string; timestamp: string; revert: Rejected["revert"] }[] }>;
}

export function fromSnapshot(s: SnapshotFile): ChainView {
  if (s.format !== "pourproof.snapshot/1") throw new Error(`unknown snapshot format ${String(s.format)}`);
  const pours: Record<string, ChainPour> = {};
  for (const [label, p] of Object.entries(s.pours)) {
    pours[label] = {
      label,
      pourId: p.pourId,
      state: p.chain,
      rejected: (p.reverted ?? []).map((r) => ({ kind: "transaction", role: r.role, account: r.account, fn: r.fn, revert: r.revert, txHash: r.txHash, block: r.block, timestamp: r.timestamp })),
    };
  }
  return {
    source: "snapshot",
    sourceLabel: s.label,
    network: s.network,
    networkLabel: s.networkLabel,
    timeMode: s.timeMode,
    timeNote: s.timeNote,
    chainId: s.chainId,
    ledger: s.ledger,
    block: s.block,
    blockTimestamp: s.blockTimestamp,
    events: s.events,
    pours,
  };
}

/** bigint -> decimal string, recursively; viem results then compare equal to the snapshot's JSON. */
export function plain<T>(v: T): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

export const eventsOf = (v: ChainView, pourId: Hex, name?: string): ChainEvent[] =>
  v.events.filter((e) => String(e.args.pourId ?? "").toLowerCase() === pourId.toLowerCase() && (!name || e.name === name));
