import type { ChainView } from "../chain.ts";
import { link } from "../config.ts";
import type { InputsFile } from "../data.ts";
import { esc, range } from "../format.ts";
import { deviceLabel } from "../labels.ts";
import { roleName } from "../roles.ts";
import { eventsOf } from "../chain.ts";

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
  return `<h1>Pours</h1>
  <p>Each pour has a passport that the supplier, contractor, inspector and owner read from the same ledger. Open one, or check its curing record yourself in this browser.</p>
  <div class="table-wrap"><table class="list"><thead><tr><th>Pour</th><th>Mix</th><th>Curing record</th><th>Strength</th><th>Saving claim</th><th></th></tr></thead>
  <tbody>${rows.join("")}</tbody></table></div>
  <p class="small">Tamper demo: <a href="${link("/verify/P-001", search, { tamper: "reading:40" })}" data-nav>change reading 40 of P-001 and verify again</a>.</p>`;
}
