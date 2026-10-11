// Rebuilds contracts/test/vectors.json (written by the Solidity side, contracts/script/GenVectors.s.sol) from scratch
// in TypeScript and requires every value to match: key, pour id, readings, leaves, roots, digests, r and s.
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";
import {
  BATCH_DOMAIN,
  P256_N,
  batchDigest,
  checkBatch,
  hashPair,
  leafHash,
  merkleProof,
  merkleRoot,
  pourIdOf,
  processProof,
  publicKeyOf,
  signBatch,
  signDigest,
  fromHex,
  toHex,
  verifyDigest,
  verifyProof,
  type DeviceReading,
  type Hex,
} from "../src/index.ts";
import { PROOFS, VECTORS, buildProofsJson } from "../scripts/gen-proofs.ts";

interface VectorFile {
  test_only_key: { seed: string };
  qx: Hex;
  qy: Hex;
  domain: string;
  chainId: number;
  ledger: Hex;
  pourLabel: string;
  pourId: Hex;
  pourStart: number;
  batchCount: number;
  readingsPerBatch: number;
  batches: { counter: number; fromTs: number; toTs: number; readings: (DeviceReading & { leaf: Hex })[]; root: Hex; digest: Hex; r: Hex; s: Hex }[];
}

const vectorsJson = readFileSync(VECTORS, "utf8");
const v = JSON.parse(vectorsJson) as VectorFile;
const ds = JSON.parse(readFileSync(new URL("../../../data/dataset/mendeley-nmr8pjx8d8.json", import.meta.url), "utf8")) as {
  series: { box1: { t_h: number; temp_c: number }[] };
};
const sk = sha256(new TextEncoder().encode(v.test_only_key.seed));
const ctx = { chainId: v.chainId, ledger: v.ledger, pourId: v.pourId };

describe("TypeScript rebuilds contracts/test/vectors.json exactly", () => {
  it("key, domain and pour id", () => {
    expect(publicKeyOf(sk)).toEqual({ qx: v.qx, qy: v.qy });
    expect(v.domain).toBe(BATCH_DOMAIN);
    expect(pourIdOf(v.pourLabel)).toBe(v.pourId);
  });

  it("readings are Box 1 from the dataset, t_unix = pourStart + t_h * 3600, milli-degC", () => {
    const flat = v.batches.flatMap((b) => b.readings);
    expect(flat).toHaveLength(v.batchCount * v.readingsPerBatch);
    flat.forEach((r, k) => {
      const d = ds.series.box1[k];
      expect(r.t_unix).toBe(v.pourStart + Math.round(d.t_h * 3600));
      expect(r.temp_milliC).toBe(Math.round(d.temp_c * 1000));
    });
  });

  it("every batch: leaves, root, digest, r, s", () => {
    const flat = v.batches.flatMap((b) => b.readings);
    const rebuilt = Array.from({ length: v.batchCount }, (_, b) => {
      const readings = flat.slice(b * v.readingsPerBatch, (b + 1) * v.readingsPerBatch).map(({ t_unix, temp_milliC }) => ({ t_unix, temp_milliC }));
      const sb = signBatch(ctx, b, readings, sk);
      return { ...sb, readings: readings.map((r) => ({ ...r, leaf: leafHash(r) })) };
    });
    expect(rebuilt).toEqual(v.batches);
  });

  it("the vector signatures verify, are low-s, and fail for another context", () => {
    for (const b of v.batches) {
      expect(BigInt(b.s) <= P256_N / 2n).toBe(true);
      expect(checkBatch(ctx, b, { qx: v.qx, qy: v.qy })).toEqual({ ok: true });
      expect(checkBatch({ ...ctx, pourId: pourIdOf("P-002") }, b, { qx: v.qx, qy: v.qy })).toEqual({ ok: false, reason: "bad_signature" });
      expect(checkBatch({ ...ctx, chainId: 84532 }, b, { qx: v.qx, qy: v.qy })).toEqual({ ok: false, reason: "bad_signature" });
    }
  });
});

describe("message encoding details", () => {
  it("encodes negative temperatures as int32 two's complement", () => {
    // 0x00 || abi.encode(uint64(1), int32(-1)) = 0x00 || 0x..01 || 0xff..ff
    const enc = new Uint8Array(65);
    enc[32] = 1;
    enc.fill(0xff, 33);
    expect(leafHash({ t_unix: 1, temp_milliC: -1 })).toBe(toHex(keccak_256(enc)));
    expect(leafHash({ t_unix: 1, temp_milliC: -1 })).not.toBe(leafHash({ t_unix: 1, temp_milliC: 1 }));
    expect(() => leafHash({ t_unix: 1, temp_milliC: 2 ** 31 })).toThrow();
    expect(() => leafHash({ t_unix: -1, temp_milliC: 0 })).toThrow();
    expect(() => leafHash({ t_unix: 1.5, temp_milliC: 0 })).toThrow();
  });

  it("the digest changes with every field", () => {
    const base = { ...ctx, counter: 0, fromTs: 1, toTs: 2, root: v.batches[0].root };
    const d0 = batchDigest(base);
    const variants = [
      { chainId: 1 },
      { ledger: "0x0000000000000000000000000000000000000001" as Hex },
      { pourId: pourIdOf("P-002") },
      { counter: 1 },
      { fromTs: 0 },
      { toTs: 3 },
      { root: v.batches[1].root },
    ];
    for (const x of variants) expect(batchDigest({ ...base, ...x })).not.toBe(d0);
  });

  it("verifyDigest rejects high-s, zero and out-of-range values, like OpenZeppelin P256.verify", () => {
    const b = v.batches[0];
    const key = { qx: v.qx, qy: v.qy };
    const highS = toHex(fromBig(P256_N - BigInt(b.s)));
    expect(verifyDigest(b.digest, { r: b.r, s: b.s }, key)).toBe(true);
    expect(verifyDigest(b.digest, { r: b.r, s: highS }, key)).toBe(false);
    expect(verifyDigest(b.digest, { r: toHex(new Uint8Array(32)), s: b.s }, key)).toBe(false);
    expect(verifyDigest(b.digest, { r: toHex(fromBig(P256_N)), s: b.s }, key)).toBe(false);
    expect(verifyDigest(b.digest, { r: b.r, s: b.s }, { qx: v.qx, qy: v.qx })).toBe(false);
    expect(signDigest(b.digest, sk)).toEqual({ r: b.r, s: b.s });
  });
});

function fromBig(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

describe("Merkle proofs (OpenZeppelin MerkleProof with the prefixed node hash)", () => {
  const leaves = v.batches[0].readings.map((r) => r.leaf);

  it("contracts/test/proofs.json is current (Solidity checks it with MerkleProof.verify)", () => {
    expect(readFileSync(PROOFS, "utf8")).toBe(buildProofsJson(vectorsJson));
  });

  it("leaf and node hashes are domain separated (0x00 / 0x01 prefix)", () => {
    const [a, b] = [leaves[0], leaves[1]];
    const [lo, hi] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
    const pair = new Uint8Array(64);
    pair.set(fromHex(lo), 0);
    pair.set(fromHex(hi), 32);
    expect(hashPair(a, b)).toBe(toHex(keccak_256(new Uint8Array([0x01, ...pair]))));
    expect(hashPair(a, b)).toBe(hashPair(b, a));
    // Without the prefix a node would be keccak of 64 bytes, the same shape as an unprefixed leaf.
    expect(hashPair(a, b)).not.toBe(toHex(keccak_256(pair)));
    expect(toHex(keccak_256(new Uint8Array([0x00, ...pair])))).not.toBe(hashPair(a, b));
  });

  it("hand-built root for 3 leaves: the odd one is carried up", () => {
    expect(merkleRoot(leaves.slice(0, 3))).toBe(hashPair(hashPair(leaves[0], leaves[1]), leaves[2]));
    expect(merkleRoot(leaves.slice(0, 1))).toBe(leaves[0]);
    expect(() => merkleRoot([])).toThrow();
  });

  it("every leaf of every tree size 1..13 proves into its root, and only into it", () => {
    const pool = v.batches.flatMap((b) => b.readings.map((r) => r.leaf));
    for (let n = 1; n <= 13; n++) {
      const l = pool.slice(0, n);
      const root = merkleRoot(l);
      for (let i = 0; i < n; i++) {
        const p = merkleProof(l, i);
        expect(processProof(p, l[i])).toBe(root);
        expect(verifyProof(p, root, pool[20])).toBe(false);
      }
    }
  });

  it("a changed reading no longer proves into the signed root", () => {
    const readings = v.batches[0].readings;
    const proof = merkleProof(leaves, 4);
    const forged = leafHash({ t_unix: readings[4].t_unix, temp_milliC: readings[4].temp_milliC + 500 });
    expect(verifyProof(proof, v.batches[0].root, leaves[4])).toBe(true);
    expect(verifyProof(proof, v.batches[0].root, forged)).toBe(false);
    const tampered = readings.map(({ t_unix, temp_milliC }, i) => ({ t_unix, temp_milliC: i === 4 ? temp_milliC + 500 : temp_milliC }));
    expect(checkBatch(ctx, { ...v.batches[0], readings: tampered }, { qx: v.qx, qy: v.qy }).ok).toBe(false);
  });
});
