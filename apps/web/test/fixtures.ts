// The committed files the web app reads, loaded from disk for tests.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fromSnapshot, type SnapshotFile } from "../src/chain.ts";
import type { EvidencePackage } from "../src/compute.ts";
import type { InputsFile } from "../src/data.ts";
import type { BatchesFile } from "../src/verify.ts";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const readJson = <T>(rel: string): T => JSON.parse(readFileSync(join(REPO, rel), "utf8")) as T;

export const snapshot = readJson<SnapshotFile>("apps/web/public/snapshot/anvil.json");
export const view = fromSnapshot(snapshot);
export const inputs = readJson<InputsFile>("data/scenario/inputs.json");
export const batchesOf = (label: string) => readJson<BatchesFile>(`data/pours/${label}/batches.json`);
export const evidence = readJson<EvidencePackage>("scenario/anvil-evidence-P-001.json");
