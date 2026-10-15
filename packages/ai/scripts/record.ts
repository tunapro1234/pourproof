// npm run record -w packages/ai [-- --missing]
// Sends every demo request to Claude once and stores each response in recorded_responses/<prompt_sha256>.json,
// replacing any handwritten fixture for the same request. Needs ANTHROPIC_API_KEY; without it, stops with an error.
// With --missing, a request that already has a recording is not sent (e.g. after a sample document changed, only the
// requests for the changed file go out).
// Each call is checked against the spending cap (src/budget.ts); at the cap the script stops, and the requests not yet
// sent keep their current recordings.
import { join } from "node:path";
import { BudgetExceeded, spendNow } from "../src/budget.ts";
import { DEMO_EPDS, DEMO_TICKETS, REPO_ROOT, demoAnomalyCases } from "../src/cases.ts";
import { explainAnomaly } from "../src/explain.ts";
import { extractEpd, extractTicket } from "../src/extract.ts";
import type { RunOptions } from "../src/run.ts";
import { NoRecording } from "../src/store.ts";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set; nothing recorded. The package keeps answering from recorded_responses/.");
  process.exit(1);
}

const show = () => {
  const s = spendNow();
  console.log(`AI spend: ${s.month} ${s.month_usd.toFixed(4)} of ${s.caps.month_usd} USD, ${s.day} ${s.day_usd.toFixed(4)} of ${s.caps.day_usd} USD (${s.file})`);
};
show();

const o: RunOptions = { mode: "live", record: true, root: REPO_ROOT };
const missingOnly = process.argv.includes("--missing");

/** with --missing, true when the request already has a recording (it is then not sent) */
async function recorded(ask: (o: RunOptions) => Promise<{ prompt_sha256: string }>, name: string): Promise<boolean> {
  if (!missingOnly) return false;
  try {
    const r = await ask({ mode: "recorded", root: REPO_ROOT });
    console.log(`${name}: already recorded (${r.prompt_sha256}), not sent`);
    return true;
  } catch (e) {
    if (e instanceof NoRecording) return false;
    throw e;
  }
}

try {
  for (const p of DEMO_TICKETS) {
    if (await recorded((x) => extractTicket(join(REPO_ROOT, p), x), p)) continue;
    const r = await extractTicket(join(REPO_ROOT, p), o);
    console.log(`${p}: ${r.model}, prompt_sha256 ${r.prompt_sha256}, ${JSON.stringify(r.counts)}`);
  }
  for (const p of DEMO_EPDS) {
    if (await recorded((x) => extractEpd(join(REPO_ROOT, p), x), p)) continue;
    const r = await extractEpd(join(REPO_ROOT, p), o);
    console.log(`${p}: ${r.model}, prompt_sha256 ${r.prompt_sha256}, ${JSON.stringify(r.counts)}`);
  }
  for (const c of demoAnomalyCases()) {
    if (await recorded((x) => explainAnomaly(c.flags, c.stats, x), c.id)) continue;
    const r = await explainAnomaly(c.flags, c.stats, o);
    console.log(`${c.id}: ${r.model}, prompt_sha256 ${r.prompt_sha256}, ${r.status}${r.unknown_numbers.length ? ` (unknown numbers ${r.unknown_numbers.join(", ")})` : ""}`);
  }
} catch (e) {
  if (!(e instanceof BudgetExceeded)) throw e;
  console.error(`stopped: ${e.message}`);
  process.exitCode = 2;
}
show();
