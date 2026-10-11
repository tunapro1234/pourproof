// Role ids as the contracts define them (DeviceRegistry.sol): keccak256("SUPPLIER") and so on; 0x00 is the admin role.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { toHex, type Hex } from "@pourproof/core";
import type { ChainEvent } from "./chain.ts";

export const ROLES = ["supplier", "contractor", "inspector", "owner"] as const;
export type Role = (typeof ROLES)[number] | "admin";

const id = (name: string): Hex => toHex(keccak_256(new TextEncoder().encode(name)));
export const ROLE_ID: Record<Role, Hex> = {
  admin: `0x${"00".repeat(32)}`,
  supplier: id("SUPPLIER"),
  contractor: id("CONTRACTOR"),
  inspector: id("INSPECTOR"),
  owner: id("OWNER"),
};

export function roleName(roleId: string): Role | null {
  const r = (Object.keys(ROLE_ID) as Role[]).find((k) => ROLE_ID[k].toLowerCase() === roleId.toLowerCase());
  return r ?? null;
}

/** account (lower case) -> roles granted to it, from RoleGranted minus RoleRevoked events */
export function accountRoles(events: readonly ChainEvent[]): Map<string, Role[]> {
  const m = new Map<string, Set<Role>>();
  for (const e of events) {
    if (e.name !== "RoleGranted" && e.name !== "RoleRevoked") continue;
    const r = roleName(String(e.args.role));
    if (!r) continue;
    const a = String(e.args.account).toLowerCase();
    const s = m.get(a) ?? new Set<Role>();
    if (e.name === "RoleGranted") s.add(r);
    else s.delete(r);
    m.set(a, s);
  }
  return new Map([...m].map(([a, s]) => [a, [...s]]));
}

export function whoIs(account: string, roles: Map<string, Role[]>): string {
  const r = roles.get(account.toLowerCase())?.filter((x) => x !== "admin");
  return r && r.length ? r.join(", ") : roles.get(account.toLowerCase())?.includes("admin") ? "admin" : "no role";
}
