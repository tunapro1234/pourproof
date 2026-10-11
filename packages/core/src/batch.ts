// Device message format: reading leaves, batch Merkle root and proofs, the signed digest, P-256 signatures.
// Byte for byte the same as contracts/src/BatchMessage.sol; contracts/test/vectors.json checks both sides.
//  - leaf:   keccak256(0x00 || abi.encode(uint64 t_unix, int32 temp_milliC))
//  - node:   keccak256(0x01 || min(a, b) || max(a, b))
//  - root:   leaves in reading order, an odd last node is carried up unchanged; proofs verify with
//            OpenZeppelin MerkleProof.verify(proof, root, leaf, BatchMessage.node)
//            The 0x00 / 0x01 prefixes (RFC 6962 style) keep leaf and node preimages apart.
//  - digest: sha256(abi.encode("POURPROOF_BATCH_V1", uint256 chainId, address ledger, bytes32 pourId,
//                              uint64 counter, uint64 fromTs, uint64 toTs, bytes32 root))
//  - signature: P-256 ECDSA over the digest itself (no extra hashing), low-s
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export type Hex = `0x${string}`;

export const BATCH_DOMAIN = "POURPROOF_BATCH_V1";
/** Order of the P-256 group. A signature is accepted on chain only with s <= N / 2. */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** One signed reading: unix seconds and milli-degC, the units the contract hashes. */
export interface DeviceReading {
  t_unix: number;
  temp_milliC: number;
}

/** Where a batch is meant to land; part of the signed digest, so a batch cannot be replayed elsewhere. */
export interface BatchContext {
  chainId: number | bigint;
  ledger: Hex;
  pourId: Hex;
}

export interface Signature {
  r: Hex;
  s: Hex;
}

export interface PublicKey {
  qx: Hex;
  qy: Hex;
}

export interface SignedBatch {
  counter: number;
  fromTs: number;
  toTs: number;
  readings: DeviceReading[];
  root: Hex;
  digest: Hex;
  r: Hex;
  s: Hex;
}

// ---------- bytes and ABI words ----------

export function toHex(b: Uint8Array): Hex {
  return `0x${bytesToHex(b)}`;
}

export function fromHex(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error(`not hex: ${h}`);
  return hexToBytes(s);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 32-byte big-endian word; negative values in two's complement (abi.encode of a signed int). */
function word(v: bigint, bits: number, signed: boolean): Uint8Array {
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
  if (v < min || v > max) throw new Error(`${v} does not fit ${signed ? "int" : "uint"}${bits}`);
  const u = v < 0n ? (1n << 256n) + v : v;
  return fromHex(u.toString(16).padStart(64, "0"));
}

function bytes32(h: string): Uint8Array {
  const b = fromHex(h);
  if (b.length !== 32) throw new Error(`expected 32 bytes, got ${b.length}: ${h}`);
  return b;
}

function addressWord(a: string): Uint8Array {
  const b = fromHex(a);
  if (b.length !== 20) throw new Error(`expected a 20-byte address: ${a}`);
  return concat(new Uint8Array(12), b);
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// ---------- leaves, root, proofs ----------

const LEAF_PREFIX = new Uint8Array([0x00]);
const NODE_PREFIX = new Uint8Array([0x01]);

/** keccak256(0x00 || abi.encode(uint64 t_unix, int32 temp_milliC)) */
export function leafHash(r: DeviceReading): Hex {
  if (!Number.isInteger(r.t_unix) || !Number.isInteger(r.temp_milliC)) throw new Error("reading fields must be integers");
  return toHex(keccak_256(concat(LEAF_PREFIX, word(BigInt(r.t_unix), 64, false), word(BigInt(r.temp_milliC), 32, true))));
}

/** BatchMessage.node: keccak256(0x01 || the two hashes in ascending order). */
export function hashPair(a: Hex, b: Hex): Hex {
  const x = bytes32(a);
  const y = bytes32(b);
  return toHex(keccak_256(compare(x, y) <= 0 ? concat(NODE_PREFIX, x, y) : concat(NODE_PREFIX, y, x)));
}

/** Every level of the tree, leaves first, root last. */
function levels(leaves: readonly Hex[]): Hex[][] {
  if (leaves.length === 0) throw new Error("empty batch");
  const out: Hex[][] = [[...leaves]];
  while (out[out.length - 1].length > 1) {
    const cur = out[out.length - 1];
    const next: Hex[] = [];
    for (let i = 0; i + 1 < cur.length; i += 2) next.push(hashPair(cur[i], cur[i + 1]));
    if (cur.length % 2 === 1) next.push(cur[cur.length - 1]);
    out.push(next);
  }
  return out;
}

export function merkleRoot(leaves: readonly Hex[]): Hex {
  const l = levels(leaves);
  return l[l.length - 1][0];
}

/** Sibling path for leaves[index]; verifies with OpenZeppelin MerkleProof.verify(proof, root, leaf, BatchMessage.node). */
export function merkleProof(leaves: readonly Hex[], index: number): Hex[] {
  const l = levels(leaves);
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) throw new Error(`index ${index} out of range`);
  const proof: Hex[] = [];
  let i = index;
  for (let d = 0; d < l.length - 1; d++) {
    const sib = i ^ 1;
    // A carried-up odd node has no sibling on this level.
    if (sib < l[d].length) proof.push(l[d][sib]);
    i >>= 1;
  }
  return proof;
}

/** OpenZeppelin MerkleProof.processProof with hashPair as the hasher. */
export function processProof(proof: readonly Hex[], leaf: Hex): Hex {
  return proof.reduce<Hex>((h, p) => hashPair(h, p), leaf);
}

export function verifyProof(proof: readonly Hex[], root: Hex, leaf: Hex): boolean {
  return processProof(proof, leaf).toLowerCase() === root.toLowerCase();
}

// ---------- signed digest ----------

export interface DigestInput extends BatchContext {
  counter: number | bigint;
  fromTs: number | bigint;
  toTs: number | bigint;
  root: Hex;
}

/** sha256(abi.encode(string domain, uint256 chainId, address ledger, bytes32 pourId, uint64 counter, uint64 fromTs, uint64 toTs, bytes32 root)) */
export function batchDigest(m: DigestInput): Hex {
  const domain = new TextEncoder().encode(BATCH_DOMAIN);
  const padded = new Uint8Array(Math.ceil(domain.length / 32) * 32);
  padded.set(domain);
  const head = concat(
    word(8n * 32n, 256, false), // offset of the string, after 8 head words
    word(BigInt(m.chainId), 256, false),
    addressWord(m.ledger),
    bytes32(m.pourId),
    word(BigInt(m.counter), 64, false),
    word(BigInt(m.fromTs), 64, false),
    word(BigInt(m.toTs), 64, false),
    bytes32(m.root),
  );
  return toHex(sha256(concat(head, word(BigInt(domain.length), 256, false), padded)));
}

/** Pour ids on chain are keccak256 of the human label, e.g. "P-001". */
export function pourIdOf(label: string): Hex {
  return toHex(keccak_256(new TextEncoder().encode(label)));
}

// ---------- P-256 ----------

export function publicKeyOf(secretKey: Uint8Array): PublicKey {
  const pub = p256.getPublicKey(secretKey, false); // 0x04 || x || y
  return { qx: toHex(pub.slice(1, 33)), qy: toHex(pub.slice(33, 65)) };
}

/** Deterministic (RFC 6979) P-256 signature over a 32-byte digest, normalised to low-s. */
export function signDigest(digest: Hex, secretKey: Uint8Array): Signature {
  const sig = p256.sign(bytes32(digest), secretKey, { prehash: false, lowS: true });
  return { r: toHex(sig.slice(0, 32)), s: toHex(sig.slice(32, 64)) };
}

/** Same rule as OpenZeppelin P256.verify: valid point, 0 < r < N, 0 < s <= N / 2. */
export function verifyDigest(digest: Hex, sig: Signature, key: PublicKey): boolean {
  const r = BigInt(sig.r);
  const s = BigInt(sig.s);
  if (r === 0n || r >= P256_N || s === 0n || s > P256_N / 2n) return false;
  try {
    const pub = concat(new Uint8Array([4]), bytes32(key.qx), bytes32(key.qy));
    return p256.verify(concat(bytes32(sig.r), bytes32(sig.s)), bytes32(digest), pub, { prehash: false, lowS: true });
  } catch {
    return false;
  }
}

// ---------- whole batches ----------

/** Hashes, roots and signs one batch of readings. `counter` starts at 0 per pour and goes up by 1. */
export function signBatch(ctx: BatchContext, counter: number, readings: readonly DeviceReading[], secretKey: Uint8Array): SignedBatch {
  if (readings.length === 0) throw new Error("empty batch");
  for (let i = 1; i < readings.length; i++) {
    if (readings[i].t_unix < readings[i - 1].t_unix) throw new Error(`readings out of order at index ${i}`);
  }
  const root = merkleRoot(readings.map(leafHash));
  const fromTs = readings[0].t_unix;
  const toTs = readings[readings.length - 1].t_unix;
  const digest = batchDigest({ ...ctx, counter, fromTs, toTs, root });
  return { counter, fromTs, toTs, readings: readings.map((r) => ({ t_unix: r.t_unix, temp_milliC: r.temp_milliC })), root, digest, ...signDigest(digest, secretKey) };
}

export type BatchCheck =
  | { ok: true }
  | { ok: false; reason: "root_mismatch"; root: Hex }
  | { ok: false; reason: "window_mismatch" }
  | { ok: false; reason: "bad_signature" };

/**
 * Recomputes a batch from its readings and checks it against the signed root and the device key,
 * as the ledger would (the ledger never sees the readings, only the root).
 */
export function checkBatch(ctx: BatchContext, b: Omit<SignedBatch, "digest"> & { digest?: Hex }, key: PublicKey): BatchCheck {
  const root = merkleRoot(b.readings.map(leafHash));
  if (root.toLowerCase() !== b.root.toLowerCase()) return { ok: false, reason: "root_mismatch", root };
  if (b.readings[0].t_unix !== b.fromTs || b.readings[b.readings.length - 1].t_unix !== b.toTs) return { ok: false, reason: "window_mismatch" };
  const digest = batchDigest({ ...ctx, counter: b.counter, fromTs: b.fromTs, toTs: b.toTs, root: b.root });
  return verifyDigest(digest, b, key) ? { ok: true } : { ok: false, reason: "bad_signature" };
}
