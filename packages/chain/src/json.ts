// JSON helpers: bigint-safe output for chain data, and a canonical form (sorted keys) for hashing records.
import { sha256 } from "@noble/hashes/sha2.js";
import { toHex, type Hex } from "@pourproof/core";

/** Turns bigints into decimal strings, recursively, so chain values survive JSON. */
export function plain(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

export function pretty(v: unknown): string {
  return JSON.stringify(plain(v), null, 1) + "\n";
}

/** Canonical JSON: keys sorted at every level, no whitespace. */
export function canonical(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") {
      return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]));
    }
    return x;
  };
  return JSON.stringify(sort(plain(v)));
}

export function sha256Hex(data: string | Uint8Array): Hex {
  return toHex(sha256(typeof data === "string" ? new TextEncoder().encode(data) : data));
}
