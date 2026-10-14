import type { ChainView } from "../chain.ts";
import { link } from "../config.ts";
import type { InputsFile } from "../data.ts";
import { esc, range } from "../format.ts";
import { deviceLabel, HERO_OPEN, HERO_POUR, heroTitle, ROLE_LINE, TRY_TITLE } from "../labels.ts";
import { roleName } from "../roles.ts";
import { eventsOf } from "../chain.ts";
import { TAMPER_DELTA_MILLIC, tamperHref, tamperParam } from "../tamper.ts";
import type { BatchesFile } from "../verify.ts";

const chainPhrase = (v: ChainView): string => (v.network === "anvil" ? "a local test chain" : `the ${v.networkLabel} test network`);

/**
 * First screen of the home page: the pour to open, in two sentences, who opens a passport and when, and the two
 * ways in. Every number is read from the chain view, the scenario inputs or the published batch file.
 */
export function homeHero(v: ChainView, inputs: InputsFile, search: string, file: BatchesFile | null): string {
  const p = v.pours[HERO_POUR];
  const inp = inputs.pours[HERO_POUR];
  if (!p || !inp) return "";
  const readings = file ? file.batches.reduce((n, b) => n + b.readings.length, 0) : null;
  const batches = eventsOf(v, p.pourId, "BatchAppended").length;
  const device =
    p.state.device.kind === "simulated"
      ? `A simulated device replays ${readings === null ? "the" : readings.toLocaleString("en-US")} published curing readings`
      : `A sensor in the pour recorded ${readings === null ? "the" : readings.toLocaleString("en-US")} curing readings`;
  const claim = eventsOf(v, p.pourId, "SavingClaimed")[0];
  const claimed = claim
    ? `The ${roleName(String(claim.args.role)) ?? "unknown role"} claimed the saving, ${range(Number(claim.args.savingLow_kg), Number(claim.args.savingHigh_kg), "kg CO2e")}, once; the record is what that claim rests on.`
    : "No one has claimed the saving yet; the record is what a claim would rest on.";
  const pour = (hash: string) => `${link(`/pour/${HERO_POUR}`, search)}#${hash}`;
  const roles = esc(ROLE_LINE).replace("the site engineer", `<a href="${pour("curing")}" data-nav>the site engineer</a>`)
    .replace("the supplier", `<a href="${pour("claim")}" data-nav>the supplier</a>`)
    .replace("the inspector", `<a href="${pour("strength")}" data-nav>the inspector</a>`);
  return `<section class="hero" data-testid="hero">
    <h1>${esc(heroTitle(HERO_POUR))}</h1>
    <p>${esc(`${inp.volume_m3} m³ of a leaner mix. ${device}, signs them in ${batches.toLocaleString("en-US")} batches, and anchors each batch on ${chainPhrase(v)}. ${claimed}`)}</p>
    <p>${roles}</p>
    <p class="actions">
      <a class="button" href="${link(`/pour/${HERO_POUR}`, search)}" data-nav data-testid="hero-open">${esc(HERO_OPEN(HERO_POUR))}</a>
      <a class="button primary" href="${tamperHref(link(`/pour/${HERO_POUR}`, search), tamperParam({ kind: "night", n: 1 }, TAMPER_DELTA_MILLIC / 1000))}" data-nav data-testid="hero-try">${esc(TRY_TITLE)}</a>
    </p>
  </section>`;
}

export function homeView(v: ChainView, inputs: InputsFile, search: string): string {
  const rows = Object.values(v.pours).map((p) => {
    const inp = inputs.pours[p.label];
    const mix = inp ? inputs.mixes[inp.delivered_mix] : null;
    const claim = eventsOf(v, p.pourId, "SavingClaimed")[0];
    const claimText = claim
      ? `Already claimed by ${roleName(String(claim.args.role)) ?? "unknown role"}`
      : p.state.pour.strengthApproved
        ? "not claimed"
        : "not claimable: strength not approved";
    return `<tr data-testid="pour-row-${esc(p.label)}">
      <td><a href="${link(`/pour/${p.label}`, search)}" data-nav><strong>${esc(p.label)}</strong></a><div class="small">${esc(inp?.story ?? "")}</div></td>
      <td>${esc(mix ? `${mix.mix_code}, ${mix.label}` : "")}<div class="small">${esc(p.state.pour.volumeDm3 / 1000)} m³ on chain</div></td>
      <td>${esc(p.state.nextCounter)} signed batches<div class="small device">${esc(deviceLabel(p.state.device.kind))}</div></td>
      <td>${p.state.pour.strengthApproved ? "approved by inspector" : "not approved"}</td>
      <td>${esc(claimText)}${claim ? `<div class="small">${esc(range(Number(claim.args.savingLow_kg), Number(claim.args.savingHigh_kg), "kg CO2e"))}</div>` : ""}</td>
      <td><a href="${link(`/verify/${p.label}`, search)}" data-nav>verify in browser</a></td>
    </tr>`;
  });
  return `<h2>Pours</h2>
  <p>Each pour has a passport that the supplier, contractor, inspector and owner read from the same ledger. Open one, or check its curing record yourself in this browser.</p>
  <div class="table-wrap"><table class="list"><thead><tr><th>Pour</th><th>Mix</th><th>Curing record</th><th>Strength</th><th>Saving claim</th><th></th></tr></thead>
  <tbody>${rows.join("")}</tbody></table></div>`;
}
