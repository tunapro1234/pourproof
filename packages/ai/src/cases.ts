// The inputs the demo runs through the AI layer: the four sample documents and two curing records with flags, both
// computed by packages/core anomaly() from signed readings. P-002 is the scenario's tamper pour (its device logged the
// dataset's air temperature, not concrete); its flags are the ones stored in data/pours/P-002/batches.json. The
// second case is P-001's signed readings with one batch left out (a device that lost six hours), labelled as a
// constructed case wherever it appears.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anomaly, type AnomalyFlag, type Reading } from "@pourproof/core";
import { toReadings, type BatchesFile } from "@pourproof/device";
import { displayStats, type ExplainStats } from "./explain.ts";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const DEMO_TICKETS = ["data/sample-docs/delivery-ticket-P-001.png", "data/sample-docs/delivery-ticket-P-002.png"];
export const DEMO_EPDS = ["data/sample-docs/sample-epd-mix-a.pdf", "data/sample-docs/sample-epd-mix-b.pdf"];

export interface AnomalyCase {
  id: string;
  label: string;
  flags: AnomalyFlag[];
  stats: ExplainStats;
}

/** Index of the P-001 batch left out in the "missing batch" case (readings 18.5 h to 24 h after the pour start). */
export const MISSING_BATCH = 3;

export function demoAnomalyCases(root = REPO_ROOT): AnomalyCase[] {
  const dataset = JSON.parse(readFileSync(join(root, "data/dataset/mendeley-nmr8pjx8d8.json"), "utf8")) as { series: Record<string, Reading[]> };
  const ambient = dataset.series.ambient;
  const pour = (label: string) => JSON.parse(readFileSync(join(root, `data/pours/${label}/batches.json`), "utf8")) as BatchesFile;

  const p2 = pour("P-002").anomaly;
  const p1 = pour("P-001");
  const kept = p1.batches.filter((_, i) => i !== MISSING_BATCH).flatMap((b) => b.readings);
  const gap = anomaly(toReadings(kept, p1.pourStart), ambient);

  return [
    {
      id: "P-002",
      label: "pour P-002 (tamper case): flags from data/pours/P-002/batches.json",
      flags: p2.flags,
      stats: displayStats(p2.stats),
    },
    {
      id: "missing-batch",
      label: `constructed case: pour P-001's signed readings with batch ${MISSING_BATCH} left out`,
      flags: gap.flags,
      stats: displayStats(gap.stats),
    },
  ];
}
