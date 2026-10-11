// Simulated device CLI.
//   node src/cli.ts keygen <pour-label> [--force]
//   node src/cli.ts replay [--chain-id 31337] [--ledger 0x...] [--pour-start <unix s>] [--out <dir>]
// replay writes data/pours/P-001/batches.json (Box 1, honest) and data/pours/P-002/{batches,tamper}.json
// (ambient air passed off as concrete, plus a skipped batch and a batch signed by another device's key).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Hex } from "@pourproof/core";
import { keygen, loadDeviceKey, REPO_ROOT, secretsDir } from "./keys.ts";
import { ANVIL_CHAIN_ID, ANVIL_FIRST_DEPLOY, DEFAULT_POUR_START, replay, tamperAttempts, type Dataset } from "./replay.ts";

const [cmd, ...args] = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

function write(path: string, doc: unknown) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 1) + "\n");
  console.log(`wrote ${path}`);
}

if (cmd === "keygen") {
  const label = args.find((a) => !a.startsWith("--"));
  if (!label) throw new Error("usage: keygen <pour-label> [--force]");
  const { path, key } = keygen(label, { force: args.includes("--force") });
  console.log(`device key for ${label}: ${path} (mode 600)\n  qx ${key.qx}\n  qy ${key.qy}`);
} else if (cmd === "replay") {
  const chainId = Number(opt("--chain-id", String(ANVIL_CHAIN_ID)));
  const ledger = opt("--ledger", ANVIL_FIRST_DEPLOY) as Hex;
  const pourStart = Number(opt("--pour-start", String(DEFAULT_POUR_START)));
  const out = resolve(opt("--out", join(REPO_ROOT, "data", "pours")));
  const dataset = JSON.parse(readFileSync(join(REPO_ROOT, "data", "dataset", "mendeley-nmr8pjx8d8.json"), "utf8")) as Dataset;
  const dir = secretsDir();
  const k1 = loadDeviceKey("P-001", { dir });
  const k2 = loadDeviceKey("P-002", { dir });
  const common = { dataset, pourStart, chainId, ledger };
  const p1 = replay({
    ...common,
    pourLabel: "P-001",
    seriesName: "box1",
    scenario: "Low-clinker pour. The device replays Box 1 (a 50 x 50 x 50 cm block) from the dataset; readings are signed as logged.",
    key: k1,
  });
  const p2 = replay({
    ...common,
    pourLabel: "P-002",
    seriesName: "ambient",
    scenario: "Tamper case. The device sat in open air: the dataset's ambient series is replayed as if it were concrete. Signatures are valid; the curing check flags it.",
    key: k2,
  });
  write(join(out, "P-001", "batches.json"), p1);
  write(join(out, "P-002", "batches.json"), p2);
  write(join(out, "P-002", "tamper.json"), tamperAttempts(p2, k1));
  console.log(`P-001 flags [${p1.anomaly.flags}], P-002 flags [${p2.anomaly.flags}], ${p1.batches.length} + ${p2.batches.length} batches`);
} else {
  console.error("usage: node src/cli.ts keygen <pour-label> [--force] | replay [--chain-id N] [--ledger 0x...] [--pour-start s] [--out dir]");
  process.exit(2);
}
