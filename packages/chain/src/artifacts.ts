// The compiled PourLedger (forge build output). Builds the contracts first when the artifact is missing or older
// than a source file.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Abi } from "viem";
import { REPO_ROOT } from "@pourproof/device";
import type { Hex } from "@pourproof/core";
import { foundryBin } from "./foundry.ts";

export const CONTRACTS = join(REPO_ROOT, "contracts");
const ARTIFACT = join(CONTRACTS, "out", "PourLedger.sol", "PourLedger.json");

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

function newestSource(): number {
  const dir = join(CONTRACTS, "src");
  return Math.max(...readdirSync(dir).map((f) => statSync(join(dir, f)).mtimeMs));
}

export function loadLedgerArtifact(): Artifact {
  if (!existsSync(ARTIFACT) || statSync(ARTIFACT).mtimeMs < newestSource()) {
    console.log("building contracts (forge build)");
    execFileSync(foundryBin("forge"), ["build", "--root", CONTRACTS], { stdio: ["ignore", "ignore", "inherit"] });
  }
  const j = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
}
