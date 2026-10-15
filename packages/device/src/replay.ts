// Simulated device: replays a published temperature series as if a sensor in the pour had logged it, and signs it in
// 6-hour batches exactly as the on-chain ledger expects. Nothing here is measured by us; every output says so.
import {
  anomaly,
  batchDigest,
  leafHash,
  merkleProof,
  pourIdOf,
  signBatch,
  verifyDigest,
  type AnomalyResult,
  type BatchContext,
  type DeviceReading,
  type Hex,
  type PublicKey,
  type Reading,
  type SignedBatch,
} from "@pourproof/core";

export const DEVICE_KIND = "simulated" as const;
export const SOURCE = "replayed from published dataset (Mendeley nmr8pjx8d8, CC BY 4.0)";
export const READINGS_PER_BATCH = 12; // 0.5 h readings -> 6 h batches

/** The ledger a fresh local Anvil gets on its first deployment (default account 0, nonce 0). */
export const ANVIL_FIRST_DEPLOY = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Hex;
export const ANVIL_CHAIN_ID = 31337;
/** Margin between the last replayed reading and the chain clock at replay time. */
export const REPLAY_MARGIN_S = 3600;

export const SCENARIO_TEXT = {
  "P-001": "Leaner-mix pour. The device replays Box 1 (a 50 x 50 x 50 cm block) from the dataset; readings are signed as logged.",
  "P-002": "Tamper case. The device sat in open air: the dataset's ambient series is replayed as if it were concrete. Signatures are valid; the rule-based curing check flags it, the inspector does not approve, and without approval the ledger refuses the saving claim.",
};

export const MESSAGE_FORMAT = {
  leaf: "keccak256(bytes.concat(0x00, abi.encode(uint64 t_unix, int32 temp_milliC)))",
  node: "keccak256(bytes.concat(0x01, min(a, b), max(a, b)))",
  root: "leaves in reading order, pairs hashed with node, odd last node carried up",
  digest: "sha256(abi.encode(\"POURPROOF_BATCH_V1\", uint256 chainId, address ledger, bytes32 pourId, uint64 counter, uint64 fromTs, uint64 toTs, bytes32 root))",
  signature: "P-256 ECDSA over digest, RFC 6979 nonce, low-s",
  proof: "per reading: sibling hashes from its leaf to the batch root (OpenZeppelin MerkleProof.verify with BatchMessage.node)",
};

export interface PublishedReading extends DeviceReading {
  leaf: Hex;
  proof: Hex[];
}

export interface PublishedBatch extends Omit<SignedBatch, "readings"> {
  readings: PublishedReading[];
}

export interface BatchesFile {
  format: "pourproof.batches/1";
  pourLabel: string;
  pourId: Hex;
  deviceKind: typeof DEVICE_KIND;
  source: string;
  scenario: string;
  dataset: { series: string; doi: string; license: string; attribution: string };
  context: { chainId: number; ledger: Hex; note: string };
  pourStart: number;
  /** How pourStart was chosen; in replay mode every reading lies before the chain clock (FutureBatch). */
  pourStartRule: string;
  /** the block time pourStart was derived from (replay mode), else null */
  replayBlockTime: number | null;
  readingsPerBatch: number;
  device: PublicKey;
  message: typeof MESSAGE_FORMAT;
  anomaly: AnomalyResult & { reference: string };
  batches: PublishedBatch[];
}

export interface Dataset {
  doi: string;
  license: string;
  attribution: string;
  series: Record<string, Reading[]>;
}

export interface ReplayOptions {
  pourLabel: string;
  seriesName: string;
  scenario: string;
  dataset: Dataset;
  pourStart: number;
  pourStartRule?: string;
  replayBlockTime?: number;
  chainId: number;
  ledger: Hex;
  key: PublicKey & { secretKey: Uint8Array };
  readingsPerBatch?: number;
}

/** Length of the replayed record in seconds: the last reading's dataset hour. */
export function seriesDurationS(...series: readonly (readonly Reading[])[]): number {
  return Math.max(...series.map((s) => (s.length ? Math.ceil(s[s.length - 1].t_h * 3600) : 0)));
}

/**
 * Replay mode: the ledger refuses batches whose last reading is after the block time (FutureBatch), so the pour is
 * placed in the past: pourStart = block time at replay - dataset duration - 1 h. Every reading then lies at least
 * one hour before that block time.
 */
export function replayPourStart(blockTime: number, ...series: readonly (readonly Reading[])[]): { pourStart: number; rule: string } {
  if (!Number.isInteger(blockTime) || blockTime <= 0) throw new Error(`bad block time ${blockTime}`);
  const dur = seriesDurationS(...series);
  return {
    pourStart: blockTime - dur - REPLAY_MARGIN_S,
    rule: `replay: block time ${blockTime} - dataset duration ${dur} s - ${REPLAY_MARGIN_S} s, so all readings are in the past`,
  };
}

/** Dataset hours -> device readings: t_unix = pourStart + t_h * 3600, temperature in milli-degC. */
export function toDeviceReadings(series: readonly Reading[], pourStart: number): DeviceReading[] {
  return series.map((r) => ({ t_unix: pourStart + Math.round(r.t_h * 3600), temp_milliC: Math.round(r.temp_c * 1000) }));
}

/** Back to hours and degC, for the core maturity and anomaly maths on exactly what was signed. */
export function toReadings(readings: readonly DeviceReading[], pourStart: number): Reading[] {
  return readings.map((r) => ({ t_h: (r.t_unix - pourStart) / 3600, temp_c: r.temp_milliC / 1000 }));
}

/** Splits readings into consecutive batches and signs each one; counters run 0, 1, 2, ... */
export function signAll(ctx: BatchContext, readings: readonly DeviceReading[], secretKey: Uint8Array, perBatch = READINGS_PER_BATCH): SignedBatch[] {
  const out: SignedBatch[] = [];
  for (let i = 0, c = 0; i < readings.length; i += perBatch, c++) out.push(signBatch(ctx, c, readings.slice(i, i + perBatch), secretKey));
  return out;
}

export function publish(b: SignedBatch): PublishedBatch {
  const leaves = b.readings.map(leafHash);
  return { ...b, readings: b.readings.map((r, i) => ({ ...r, leaf: leaves[i], proof: merkleProof(leaves, i) })) };
}

export function replay(o: ReplayOptions): BatchesFile {
  const series = o.dataset.series[o.seriesName];
  const ambient = o.dataset.series.ambient;
  if (!series?.length) throw new Error(`series ${o.seriesName} not in dataset`);
  if (!ambient?.length) throw new Error("dataset has no ambient series");
  const pourId = pourIdOf(o.pourLabel);
  const ctx: BatchContext = { chainId: o.chainId, ledger: o.ledger, pourId };
  const readings = toDeviceReadings(series, o.pourStart);
  const batches = signAll(ctx, readings, o.key.secretKey, o.readingsPerBatch).map(publish);
  return {
    format: "pourproof.batches/1",
    pourLabel: o.pourLabel,
    pourId,
    deviceKind: DEVICE_KIND,
    source: SOURCE,
    scenario: o.scenario,
    dataset: { series: o.seriesName, doi: o.dataset.doi, license: o.dataset.license, attribution: o.dataset.attribution },
    context: {
      chainId: o.chainId,
      ledger: o.ledger,
      note: "chainId and ledger are part of every signed digest; re-run the replay against the deployed ledger before appending elsewhere",
    },
    pourStart: o.pourStart,
    pourStartRule: o.pourStartRule ?? "given explicitly",
    replayBlockTime: o.replayBlockTime ?? null,
    readingsPerBatch: o.readingsPerBatch ?? READINGS_PER_BATCH,
    device: { qx: o.key.qx, qy: o.key.qy },
    message: MESSAGE_FORMAT,
    anomaly: { ...anomaly(toReadings(readings, o.pourStart), ambient), reference: "packages/core anomaly() on the signed readings vs the dataset's ambient series" },
    batches,
  };
}

export type AppendError = "NoDevice" | "CounterGap" | "BadBatchWindow" | "FutureBatch" | "BadSignature";

export interface LedgerView {
  nextCounter: number;
  pourStart: number;
  device: PublicKey | null;
  /** block.timestamp of the block the batch would land in */
  blockTime: number;
}

/**
 * Offline mirror of PourLedger.appendBatch's checks, in the contract's order. Returns the revert the ledger
 * would give, or null if it would accept. The chain is still the judge; this only predicts.
 */
export function predictAppend(ctx: BatchContext, view: LedgerView, b: Pick<SignedBatch, "counter" | "fromTs" | "toTs" | "root" | "r" | "s">): AppendError | null {
  if (!view.device) return "NoDevice";
  if (b.counter !== view.nextCounter) return "CounterGap";
  if (b.fromTs > b.toTs || b.fromTs < view.pourStart) return "BadBatchWindow";
  if (b.toTs > view.blockTime) return "FutureBatch";
  const digest = batchDigest({ ...ctx, counter: b.counter, fromTs: b.fromTs, toTs: b.toTs, root: b.root });
  return verifyDigest(digest, b, view.device) ? null : "BadSignature";
}

export interface TamperAttempt {
  id: "skipped_batch" | "other_device_key";
  description: string;
  /** submit after the honest batches 0..afterCounter are on chain */
  afterCounter: number;
  expectRevert: AppendError;
  signer: PublicKey & { pourLabel: string };
  batch: PublishedBatch;
}

export interface TamperFile {
  format: "pourproof.tamper/1";
  pourLabel: string;
  pourId: Hex;
  deviceKind: typeof DEVICE_KIND;
  source: string;
  context: BatchesFile["context"];
  attempts: TamperAttempt[];
}

/**
 * Tamper attempts against a pour, built from its honest replay:
 *  - skipped_batch: batch 1 is withheld and batch 2 sent right after batch 0 -> CounterGap
 *  - other_device_key: batch 1 signed by another pour's device instead of the registered one -> BadSignature
 */
export function tamperAttempts(honest: BatchesFile, other: { pourLabel: string } & PublicKey & { secretKey: Uint8Array }): TamperFile {
  if (honest.batches.length < 3) throw new Error("need at least 3 honest batches");
  const ctx: BatchContext = { chainId: honest.context.chainId, ledger: honest.context.ledger, pourId: honest.pourId };
  const b1 = honest.batches[1];
  const forged = publish(signBatch(ctx, b1.counter, b1.readings.map(({ t_unix, temp_milliC }) => ({ t_unix, temp_milliC })), other.secretKey));
  return {
    format: "pourproof.tamper/1",
    pourLabel: honest.pourLabel,
    pourId: honest.pourId,
    deviceKind: DEVICE_KIND,
    source: SOURCE,
    context: honest.context,
    attempts: [
      {
        id: "skipped_batch",
        description: "Batch 1 is withheld and the device's batch 2 is sent right after batch 0.",
        afterCounter: 0,
        expectRevert: "CounterGap",
        signer: { pourLabel: honest.pourLabel, ...honest.device },
        batch: honest.batches[2],
      },
      {
        id: "other_device_key",
        description: `Batch 1 with the same readings, signed by the ${other.pourLabel} device instead of the device registered for ${honest.pourLabel}.`,
        afterCounter: 0,
        expectRevert: "BadSignature",
        signer: { pourLabel: other.pourLabel, qx: other.qx, qy: other.qy },
        batch: forged,
      },
    ],
  };
}
