import { link } from "../config.ts";
import { esc, fmtTime, short } from "../format.ts";
import { deviceLabel } from "../labels.ts";
import type { PourModel } from "../model.ts";
import { ok } from "./layout.ts";
import { verifyBanner } from "./pour.ts";

export function verifyPage(m: PourModel, search: string): string {
  const s = m.chain.state;
  const rows = m.verify.batches
    .map(
      (b) => `<tr class="${b.ok ? "" : "bad-row"}" data-testid="batch-row"><td>${b.counter}</td><td>${esc(fmtTime(b.fromTs))} to ${esc(fmtTime(b.toTs))}</td><td>${b.readings}</td>
      <td class="mono">${esc(short(b.onChainRoot ?? "not on chain", 6))}</td><td class="mono">${esc(short(b.computedRoot, 6))}</td>
      <td>${ok(b.rootMatches)}</td><td>${ok(b.signatureValid)}</td>
      <td>${b.badReadings.map((r) => `<span class="no">reading ${r.index} at ${esc(fmtTime(r.t_unix))}</span>`).join(", ")}</td></tr>`,
    )
    .join("");
  const n = m.file.batches[0]?.readings.length ?? 12;
  return `<h1>Verify pour ${esc(m.label)} in this browser</h1>
  <p><span class="pill device">${esc(deviceLabel(s.device.kind))}</span></p>
  <ol class="steps">
    <li>Downloaded the published device batches: <a href="/published/data/pours/${esc(m.label)}/batches.json" target="_blank" rel="noopener">batches.json</a> (${m.file.batches.length} batches, ${m.verify.readings} readings).</li>
    <li>Read ${m.onChain.length} BatchAppended events for pour id <span class="mono">${esc(short(m.chain.pourId, 8))}</span> from ${esc(m.view.source === "snapshot" ? m.view.sourceLabel : "the ledger over RPC")} on ${esc(m.view.networkLabel)}, ledger <span class="mono">${esc(m.view.ledger)}</span>.</li>
    <li>For each batch: recomputed every reading's leaf, rebuilt the Merkle root and compared it with the root on chain; checked each reading on its own with its Merkle proof against the on-chain root.</li>
    <li>Rebuilt the signed digest from the on-chain values (chainId ${m.view.chainId}, ledger, pour id, counter, window, root) and checked the P-256 signature against the device key registered on chain (<span class="mono">${esc(short(s.device.qx, 8))}</span>).</li>
  </ol>
  ${verifyBanner(m, search)}
  <p class="small">No wallet: this page only reads. Try the tamper demo: <a href="${link(`/verify/${m.label}`, search, { tamper: `reading:${3 * n + 4}` })}" data-nav>change reading ${3 * n + 4}</a>, or <a href="${link(`/pour/${m.label}`, search)}" data-nav>back to the passport</a>.</p>
  <div class="table-wrap"><table class="batches"><thead><tr><th>#</th><th>Window</th><th>Readings</th><th>Root on chain</th><th>Root from readings</th><th>Root</th><th>Signature</th><th>Changed readings</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
