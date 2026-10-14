// Which chain state the page shows. Defaults to the recorded snapshot of the local Anvil scenario.
//   ?mode=live|snapshot   ?network=anvil|baseSepolia   ?rpc=<url>   ?ledger=<address>
// or at build time VITE_POURPROOF_MODE, VITE_POURPROOF_NETWORK, VITE_POURPROOF_RPC.
// The static site (npm run build:snapshot) is snapshot only: there ?mode, ?rpc and ?ledger are ignored.
import type { NetworkName } from "./chain.ts";

export interface AppConfig {
  mode: "snapshot" | "live";
  network: NetworkName;
  rpcUrl: string;
  ledger: string | null;
}

export const DEFAULT_RPC: Record<NetworkName, string> = { anvil: "http://127.0.0.1:8545", baseSepolia: "https://sepolia.base.org" };

/** Query parameters that pick the data source; kept on every internal link. */
export const STICKY = ["mode", "network", "rpc", "ledger"];

declare const __POURPROOF_STATIC__: boolean | undefined;

/** True in the static snapshot build (vite.config.ts defines it); false in dev, the normal build and tests. */
export const STATIC_SITE: boolean = typeof __POURPROOF_STATIC__ === "boolean" && __POURPROOF_STATIC__;

declare const __POURPROOF_SNAPSHOT_SHA256__: Record<string, string> | undefined;

/** sha256 (hex) of each recorded snapshot file by network, computed at build time from public/snapshot/ (vite.config.ts). */
export const SNAPSHOT_SHA256: Record<string, string> = typeof __POURPROOF_SNAPSHOT_SHA256__ === "object" && __POURPROOF_SNAPSHOT_SHA256__ ? __POURPROOF_SNAPSHOT_SHA256__ : {};

const env = (k: string): string | undefined => (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[k];

export function readConfig(search: string, staticSite = STATIC_SITE): AppConfig {
  const q = new URLSearchParams(search);
  if (staticSite) {
    const network = (q.get("network") ?? "anvil") as NetworkName;
    if (network !== "anvil" && network !== "baseSepolia") throw new Error(`unknown network ${network}`);
    return { mode: "snapshot", network, rpcUrl: DEFAULT_RPC[network], ledger: null };
  }
  const network = (q.get("network") ?? env("VITE_POURPROOF_NETWORK") ?? "anvil") as NetworkName;
  if (network !== "anvil" && network !== "baseSepolia") throw new Error(`unknown network ${network}`);
  const mode = (q.get("mode") ?? env("VITE_POURPROOF_MODE") ?? "snapshot") as AppConfig["mode"];
  if (mode !== "snapshot" && mode !== "live") throw new Error(`unknown mode ${mode}`);
  return { mode, network, rpcUrl: q.get("rpc") ?? env("VITE_POURPROOF_RPC") ?? DEFAULT_RPC[network], ledger: q.get("ledger") };
}

/** Internal link that keeps the data-source parameters (and drops page-specific ones such as tamper). */
export function link(path: string, search: string, extra: Record<string, string> = {}): string {
  const from = new URLSearchParams(search);
  const q = new URLSearchParams();
  for (const k of STICKY) if (from.has(k)) q.set(k, from.get(k)!);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}
