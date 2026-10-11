// In-browser verification of a pour's curing record. Nothing here trusts the published batch file on its own:
//  1. every reading's leaf is recomputed from (t_unix, temp_milliC) and the batch root rebuilt with packages/core;
//  2. that root is compared with the root in the ledger's BatchAppended event for the same counter;
//  3. each reading is checked on its own against the on-chain root with its published Merkle proof, which pinpoints
//     a changed reading (its leaf no longer leads to the signed root);
//  4. the signed digest is rebuilt from the on-chain values (chainId, ledger, pourId, counter, window, root) and the
//     P-256 signature checked against the device key registered on chain.
// The ledger already checked each signature when the batch was appended; this repeats it where anyone can watch.
import { batchDigest, leafHash, merkleRoot, verifyDigest, verifyProof, type Hex, type PublicKey } from "@pourproof/core";
import { fmtTime } from "./format.ts";

export interface PublishedReading {
  t_unix: number;
  temp_milliC: number;
  proof?: Hex[];
}

export interface PublishedBatch {
  counter: number;
  fromTs: number;
  toTs: number;
  root: Hex;
  r: Hex;
  s: Hex;
  readings: PublishedReading[];
}

/** The published device output (data/pours/<label>/batches.json); only the fields verification needs. */
export interface BatchesFile {
  format: "pourproof.batches/1";
  pourLabel: string;
  pourId: Hex;
  deviceKind: string;
  source: string;
  context: { chainId: number; ledger: Hex };
  pourStart: number;
  device: PublicKey;
  anomaly?: { flags: string[]; stats: Record<string, unknown> };
  batches: PublishedBatch[];
}

/** What the ledger holds for one batch (from its BatchAppended event). */
export interface OnChainBatch {
  counter: number;
  fromTs: number;
  toTs: number;
  root: Hex;
  block?: string;
  txHash?: Hex;
}

export interface BadReading {
  /** index over all readings of the pour, as used by ?tamper=reading:<i> */
  index: number;
  counter: number;
  t_unix: number;
  temp_milliC: number;
}

export interface BatchResult {
  counter: number;
  fromTs: number;
  toTs: number;
  readings: number;
  onChainRoot: Hex | null;
  computedRoot: Hex;
  rootMatches: boolean;
  windowMatches: boolean;
  signatureValid: boolean;
  badReadings: BadReading[];
  ok: boolean;
}

export interface VerifyResult {
  ok: boolean;
  batches: BatchResult[];
  readings: number;
  /** human-readable problems, worst first; empty when ok */
  problems: string[];
}

export interface VerifyInput {
  chainId: number;
  ledger: Hex;
  pourId: Hex;
  /** device key registered on chain for this pour */
  deviceKey: PublicKey;
  onChain: OnChainBatch[];
  published: PublishedBatch[];
}

export const readingMismatch = (t_unix: number): string => `Reading ${fmtTime(t_unix)} does not match the signed root`;

export function verifyBatches(v: VerifyInput): VerifyResult {
  const chainBy = new Map(v.onChain.map((b) => [b.counter, b]));
  const problems: string[] = [];
  const results: BatchResult[] = [];
  let index = 0;

  const counters = v.onChain.map((b) => b.counter).sort((a, b) => a - b);
  counters.forEach((c, i) => {
    if (c !== i) problems.push(`On-chain batch counters are not 0, 1, 2, ...: found ${c} at position ${i}`);
  });

  for (const b of v.published) {
    const chain = chainBy.get(b.counter) ?? null;
    const leaves = b.readings.map(leafHash);
    const computedRoot = merkleRoot(leaves);
    const onChainRoot = chain?.root ?? null;
    const rootMatches = !!onChainRoot && computedRoot.toLowerCase() === onChainRoot.toLowerCase();
    const first = b.readings[0]?.t_unix;
    const last = b.readings[b.readings.length - 1]?.t_unix;
    const windowMatches = !!chain && first === chain.fromTs && last === chain.toTs;

    const badReadings: BadReading[] = [];
    // Without per-reading proofs only the batch can be named, not the reading.
    const hasProofs = b.readings.every((r) => Array.isArray(r.proof));
    if (onChainRoot && !rootMatches && hasProofs) {
      b.readings.forEach((r, i) => {
        if (!verifyProof(r.proof!, onChainRoot, leaves[i])) badReadings.push({ index: index + i, counter: b.counter, t_unix: r.t_unix, temp_milliC: r.temp_milliC });
      });
    }

    let signatureValid = false;
    if (chain) {
      const digest = batchDigest({ chainId: v.chainId, ledger: v.ledger, pourId: v.pourId, counter: chain.counter, fromTs: chain.fromTs, toTs: chain.toTs, root: chain.root });
      signatureValid = verifyDigest(digest, { r: b.r, s: b.s }, v.deviceKey);
    }

    if (!chain) problems.push(`Batch ${b.counter} is in the published file but not on chain`);
    else {
      for (const r of badReadings) problems.push(readingMismatch(r.t_unix));
      if (!rootMatches && badReadings.length === 0)
        problems.push(`Batch ${b.counter} does not match the signed root${hasProofs ? "" : " (no per-reading proofs published, so the changed reading cannot be named)"}`);
      if (!windowMatches) problems.push(`Batch ${b.counter}: reading times do not match the window signed on chain`);
      if (!signatureValid) problems.push(`Batch ${b.counter}: the signature does not verify with the device key registered on chain`);
    }
    results.push({
      counter: b.counter,
      fromTs: b.fromTs,
      toTs: b.toTs,
      readings: b.readings.length,
      onChainRoot,
      computedRoot,
      rootMatches,
      windowMatches,
      signatureValid,
      badReadings,
      ok: !!chain && rootMatches && windowMatches && signatureValid,
    });
    index += b.readings.length;
  }

  const published = new Set(v.published.map((b) => b.counter));
  for (const c of counters) if (!published.has(c)) problems.push(`Batch ${c} is on chain but missing from the published file`);

  return { ok: problems.length === 0 && results.length > 0, batches: results, readings: index, problems };
}
