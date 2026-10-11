// Role accounts. On Anvil they are the node's unlocked dev accounts (no keys handled here). On Base Sepolia they come
// from $POURPROOF_SECRETS/roles.json (mode 600, outside the repo):
//   { "network": "baseSepolia", "chainId": 84532,
//     "funder": {"address", "privateKey"}, "supplier": {...}, "contractor": {...}, "inspector": {...}, "owner": {...} }
// "funder" deploys the ledger, holds the admin role and relays device batches (a "relay" entry overrides the relay).
// `npm run roles-keygen -w packages/chain` creates the file when none exists.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { secretsDir } from "@pourproof/device";
import type { Hex } from "@pourproof/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const ROLE_NAMES = ["admin", "supplier", "contractor", "inspector", "owner", "relay"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

const FILE_ROLES = ["funder", "supplier", "contractor", "inspector", "owner"] as const;

interface RoleEntry {
  address: string;
  privateKey: string;
}

export function rolesPath(dir = secretsDir()): string {
  return join(dir, "roles.json");
}

function keyOf(path: string, name: string, e: RoleEntry | undefined): Hex {
  if (!e) throw new Error(`${path}: no entry for ${name}`);
  const k = (e.privateKey?.startsWith("0x") ? e.privateKey : `0x${e.privateKey}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${path}: malformed key for ${name}`);
  if (privateKeyToAccount(k).address.toLowerCase() !== e.address?.toLowerCase()) throw new Error(`${path}: ${name} address does not match its key`);
  return k;
}

/** Reads role keys; refuses files readable by group or others, wrong chains and shared keys. */
export function loadRoleKeys(path = rolesPath()): Record<RoleName, Hex> {
  if (!existsSync(path)) throw new Error(`no role keys at ${path}; run: npm run roles-keygen -w packages/chain`);
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} has mode ${mode.toString(8)}; role keys must be 600`);
  const f = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (f.chainId !== undefined && f.chainId !== 84532) throw new Error(`${path}: chainId ${f.chainId}, expected Base Sepolia (84532)`);
  const entry = (n: string) => f[n] as RoleEntry | undefined;
  const funder = keyOf(path, "funder", entry("funder"));
  const out: Record<RoleName, Hex> = {
    admin: funder,
    supplier: keyOf(path, "supplier", entry("supplier")),
    contractor: keyOf(path, "contractor", entry("contractor")),
    inspector: keyOf(path, "inspector", entry("inspector")),
    owner: keyOf(path, "owner", entry("owner")),
    relay: entry("relay") ? keyOf(path, "relay", entry("relay")) : funder,
  };
  const distinct = new Set(["admin", "supplier", "contractor", "inspector", "owner"].map((r) => out[r as RoleName].toLowerCase()));
  if (distinct.size !== 5) throw new Error(`${path}: funder, supplier, contractor, inspector and owner need distinct keys`);
  return out;
}

/** Writes fresh role keys (testnet only). Refuses to overwrite unless forced. Returns the public addresses. */
export function rolesKeygen(opts: { path?: string; force?: boolean } = {}): { path: string; addresses: Record<string, string> } {
  const path = opts.path ?? rolesPath();
  if (existsSync(path) && !opts.force) throw new Error(`${path} exists; pass --force to replace the role keys`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const doc: Record<string, unknown> = { _note: "Base Sepolia testnet only. Never mainnet. Not in any repo.", network: "baseSepolia", chainId: 84532 };
  const addresses: Record<string, string> = {};
  for (const r of FILE_ROLES) {
    const k = generatePrivateKey();
    addresses[r] = privateKeyToAccount(k).address;
    doc[r] = { address: addresses[r], privateKey: k.slice(2) };
  }
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, addresses };
}
