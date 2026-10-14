// Loads everything a page shows: chain state (snapshot file or live RPC) plus the published off-chain files the
// chain commits to (device batches, scenario inputs, evidence package, sample documents, AI outputs). Published
// files are served under /published/<repo path> by the Vite plugin in vite.config.ts.
import { sha256 } from "@noble/hashes/sha2.js";
import { toHex, type Hex } from "@pourproof/core";
import type { AiFile } from "./ai.ts";
import { fromSnapshot, type ChainView, type SnapshotFile } from "./chain.ts";
import type { AppConfig } from "./config.ts";
import { readLive } from "./live.ts";
import type { BatchesFile } from "./verify.ts";

export const publishedUrl = (repoPath: string): string => `/published/${repoPath}`;

export interface Mix {
  label: string;
  mix_code: string;
  cement_type: string;
  cement_kg_per_m3: number;
  cement_basis: string;
  cement_gwp_kg_per_m3: [number, number];
  cement_gwp_basis: string;
  other_constituents_kg_per_m3: [number, number];
  other_basis: string;
  gwp_total_kg_per_m3: [number, number];
  epd_doc: string;
}

export interface PourInputs {
  story: string;
  baseline_mix: string | null;
  delivered_mix: string;
  volume_m3: number;
  volume_basis?: string;
  ticket: Record<string, string>;
  ticket_doc: string;
  device_series: string;
  curing_curve?: string;
  strength_reference?: { standard_28d_mpa: number; paper_70pct_threshold_mpa: number; source: string; ui_rule: string };
}

export interface InputsFile {
  note: string;
  sources: Record<string, unknown>;
  mixes: Record<string, Mix>;
  pours: Record<string, PourInputs>;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

// Published files do not change while the page is open: each is downloaded once, so trying a tamper (a new query
// string, rendered again) sends no new request. Every render still parses and checks the bytes from scratch.
const fileCache = new Map<string, Promise<Uint8Array>>();

function fileBytes(url: string): Promise<Uint8Array> {
  let p = fileCache.get(url);
  if (!p) {
    p = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    });
    fileCache.set(url, p);
    p.catch(() => fileCache.delete(url));
  }
  return p;
}

const fileJson = async <T>(url: string): Promise<T> => JSON.parse(new TextDecoder().decode(await fileBytes(url))) as T;

/** sha256 of a published file's bytes, as 0x-hex (the form the ledger stores). */
export async function fileHash(url: string): Promise<Hex> {
  return toHex(sha256(await fileBytes(url)));
}

let chainCache: Promise<ChainView> | null = null;
let chainKey = "";

export function loadChain(c: AppConfig, labels: string[]): Promise<ChainView> {
  const key = JSON.stringify(c);
  if (chainCache && key === chainKey) return chainCache;
  chainKey = key;
  chainCache = (async () => {
    if (c.mode === "snapshot") return fromSnapshot(await getJson<SnapshotFile>(`/snapshot/${c.network}.json`));
    const dep = await getJson<{ ledger: { address: Hex; block: string } }>(publishedUrl(`deployments/${c.network}.json`)).catch(() => null);
    const ledger = (c.ledger ?? dep?.ledger.address) as Hex | undefined;
    if (!ledger) throw new Error(`live mode: no ledger address for ${c.network} (add ?ledger=0x...)`);
    return readLive({ network: c.network, rpcUrl: c.rpcUrl, ledger, fromBlock: BigInt(c.ledger ? 0 : (dep?.ledger.block ?? 0)), labels });
  })();
  chainCache.catch(() => (chainCache = null));
  return chainCache;
}

let inputsCache: Promise<InputsFile> | null = null;
export const loadInputs = (): Promise<InputsFile> => (inputsCache ??= getJson<InputsFile>(publishedUrl("data/scenario/inputs.json")));

export const loadBatches = (label: string): Promise<BatchesFile> => fileJson<BatchesFile>(publishedUrl(`data/pours/${label}/batches.json`));

export const evidencePath = (network: string, label: string): string => `scenario/${network}-evidence-${label}.json`;

let aiCache: Promise<AiFile> | null = null;
export const loadAi = (): Promise<AiFile> => (aiCache ??= getJson<AiFile>("/ai/outputs.json"));

/** A published JSON file (cached like the other published files). */
export const loadJson = fileJson;
