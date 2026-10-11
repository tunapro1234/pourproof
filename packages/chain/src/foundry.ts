// Finds a Foundry binary on PATH, else in the default foundryup location (~/.foundry/bin).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export function foundryBin(name: "anvil" | "forge"): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  const fallback = join(homedir(), ".foundry", "bin", name);
  if (existsSync(fallback)) return fallback;
  throw new Error(`${name} not found on PATH or in ~/.foundry/bin; install Foundry (foundryup)`);
}
