// npm run record -w packages/ai
// Sends every demo request to Claude once and stores each response in recorded_responses/<prompt_sha256>.json,
// replacing any handwritten fixture for the same request. Needs ANTHROPIC_API_KEY; without it, stops with an error.
// Each call is checked against the spending cap (src/budget.ts); at the cap the script stops, and the requests not yet
// sent keep their current recordings.
import { join } from "node:path";
import { BudgetExceeded, spendNow } from "../src/budget.ts";
import { DEMO_EPDS, DEMO_TICKETS, REPO_ROOT, demoAnomalyCases } from "../src/cases.ts";
import { explainAnomaly } from "../src/explain.ts";
import { extractEpd, extractTicket } from "../src/extract.ts";
import type { RunOptions } from "../src/run.ts";

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
try {
  for (const p of DEMO_TICKETS) {
    const r = await extractTicket(join(REPO_ROOT, p), o);
    console.log(`${p}: ${r.model}, prompt_sha256 ${r.prompt_sha256}, ${JSON.stringify(r.counts)}`);
  }
  for (const p of DEMO_EPDS) {
    const r = await extractEpd(join(REPO_ROOT, p), o);
    console.log(`${p}: ${r.model}, prompt_sha256 ${r.prompt_sha256}, ${JSON.stringify(r.counts)}`);
  }
  for (const c of demoAnomalyCases()) {
    const r = await explainAnomaly(c.flags, c.stats, o);
    console.log(`${c.id}: ${r.model}, prompt_sha256 ${r.prompt_sha256}, ${r.status}${r.unknown_numbers.length ? ` (unknown numbers ${r.unknown_numbers.join(", ")})` : ""}`);
  }
} catch (e) {
  if (!(e instanceof BudgetExceeded)) throw e;
  console.error(`stopped: ${e.message}`);
  process.exitCode = 2;
}
show();
