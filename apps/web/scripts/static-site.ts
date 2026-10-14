// The static snapshot site: `npm run build:snapshot -w apps/web` writes apps/web/dist-snapshot/, a plain folder of files
// any static host can serve at '/'. It runs only from the recorded snapshots (public/snapshot/<network>.json) and the
// recorded AI outputs; the app ignores ?mode=live and ?rpc there. This module is the build-time part, used by the Vite
// plugin in vite.config.ts:
//  - every HTML file carries the "recorded on-chain state, block N" label in its markup, before any script runs
//  - each route has its own index.html (pour/<id>/, verify/<id>/) and 404.html is the app shell for anything else
//  - the build fails if an AI output is not recorded or if any file looks like it holds a secret
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface SnapshotInfo {
  network: string;
  networkLabel: string;
  label: string;
  block: string;
  pours: string[];
}

/** What each recorded snapshot in public/snapshot/ says about itself. */
export function readSnapshots(dir: string): SnapshotInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (s.format !== "pourproof.snapshot/1") throw new Error(`${f}: not a pourproof snapshot`);
      if (!/^recorded on-chain state, block \d+$/.test(s.label)) throw new Error(`${f}: unexpected label "${s.label}"`);
      return { network: s.network, networkLabel: s.networkLabel, label: s.label, block: s.block, pours: Object.keys(s.pours) };
    });
}

/** sha256 (hex) of each recorded snapshot file by network, computed when the app is built; the trust note shows it. */
export function snapshotSha256(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => [f.slice(0, -".json".length), createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")]),
  );
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Markup shown until the app renders (and without JavaScript): which recorded state this site shows. */
export function staticNotice(snaps: SnapshotInfo[]): string {
  if (snaps.length === 0) throw new Error("no recorded snapshot in public/snapshot/: run the chain scenario first");
  const items = snaps.map((s) => `${esc(s.networkLabel)}: ${esc(s.label)}`).join("; ");
  return `<p class="loading" data-testid="static-label">Static site: ${items}. Testnet demo, no real claim. Loading the passport and checking signatures in your browser...</p>`;
}

/** Puts the notice inside <div id="app"> and the noscript text of index.html. */
export function injectNotice(html: string, notice: string): string {
  const app = '<div id="app"></div>';
  if (!html.includes(app)) throw new Error(`index.html has no ${app}`);
  return html.replace(app, `<div id="app">${notice}</div>`).replace(/<noscript>([^<]*)<\/noscript>/, (_, t: string) => `<noscript>${t} ${notice.replace(/<[^>]+>/g, "")}</noscript>`);
}

/** Every page of the site as a file path, so deep links work on hosts without a rewrite rule. */
export function routeFiles(pours: string[]): string[] {
  for (const p of pours) if (!/^[\w-]+$/.test(p)) throw new Error(`pour label "${p}" is not usable in a path`);
  return [...new Set(pours)].sort().flatMap((p) => [`pour/${p}/index.html`, `verify/${p}/index.html`]).concat("404.html");
}

/** Throws unless every AI output in the file is a recorded one. */
export function assertRecordedAi(file: { pours: Record<string, { ticket: { mode: string }; epds: { mode: string }[]; explanation: { mode: string } | null }> }): void {
  for (const [pour, p] of Object.entries(file.pours)) {
    for (const o of [p.ticket, ...p.epds, ...(p.explanation ? [p.explanation] : [])]) {
      if (o.mode !== "recorded") throw new Error(`${pour}: AI output in mode "${o.mode}"; the static site shows recorded responses only`);
    }
  }
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ["Anthropic API key", /sk-ant-/],
  ["API key assignment", /ANTHROPIC_API_KEY=/],
  ["private key field", /"?private_?key"?\s*[:=]\s*"?(0x)?[0-9a-fA-F]{64}/i],
  ["PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/** Files under dir (relative paths) that match a secret pattern, with the pattern's name. */
export function findSecrets(dir: string): string[] {
  const walk = (d: string): string[] => readdirSync(d).sort().flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  const hits: string[] = [];
  for (const f of walk(dir)) {
    if (/\.(png|pdf|ico|woff2?)$/i.test(f)) continue;
    const text = readFileSync(f, "utf8");
    for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) hits.push(`${relative(dir, f)}: ${name}`);
  }
  return hits;
}
