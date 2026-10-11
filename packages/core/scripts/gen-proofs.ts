// Writes contracts/test/proofs.json: Merkle proofs built by packages/core for the trees in contracts/test/vectors.json,
// so the Solidity side can check them with OpenZeppelin MerkleProof.verify.
//   node scripts/gen-proofs.ts
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { merkleProof, merkleRoot, type Hex } from "../src/batch.ts";

export const VECTORS = fileURLToPath(new URL("../../../contracts/test/vectors.json", import.meta.url));
export const PROOFS = fileURLToPath(new URL("../../../contracts/test/proofs.json", import.meta.url));

export function buildProofsJson(vectorsJson: string): string {
  const v = JSON.parse(vectorsJson) as { batches: { readings: { leaf: Hex }[] }[] };
  const trees: { source: string; leaves: Hex[] }[] = v.batches.map((b, i) => ({
    source: `vectors.json batches[${i}]`,
    leaves: b.readings.map((r) => r.leaf),
  }));
  // 5 leaves: the last leaf is carried up twice, so its proof skips two levels.
  trees.push({ source: "vectors.json batches[0], first 5 leaves", leaves: v.batches[0].readings.slice(0, 5).map((r) => r.leaf) });
  const doc = {
    description: "Merkle proofs from packages/core (merkleProof) for OpenZeppelin MerkleProof.verify. Generated, do not edit.",
    generator: "packages/core/scripts/gen-proofs.ts",
    trees: trees.map((t) => ({
      source: t.source,
      root: merkleRoot(t.leaves),
      leaves: t.leaves,
      proofs: t.leaves.map((_, i) => merkleProof(t.leaves, i)),
    })),
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(PROOFS, buildProofsJson(readFileSync(VECTORS, "utf8")));
  console.log(`wrote ${PROOFS}`);
}
