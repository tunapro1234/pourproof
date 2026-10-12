import { aiLabel, STATUS_TEXT, type AiExplanation, type AiExtraction } from "../ai.ts";
import { eventsOf, type ChainEvent } from "../chain.ts";
import { curingChart } from "../chart.ts";
import { carbonView, readingsOf, strengthView, STRENGTH_LABEL } from "../compute.ts";
import { link } from "../config.ts";
import { publishedUrl } from "../data.ts";
import { esc, fmtTime, range, short } from "../format.ts";
import { deviceLabel, FLAG_TEXT, SERIES_NOTE } from "../labels.ts";
import type { DocCheck, PourModel } from "../model.ts";
import { qrSvg } from "../qr.ts";
import { accountRoles, roleName, whoIs } from "../roles.ts";
import { ok } from "./layout.ts";

export function verifyBanner(m: PourModel, search: string): string {
  const v = m.verify;
  const bad = [...m.contextProblems, ...v.problems];
  const head = v.ok
    ? `Curing record verified in this browser: ${v.batches.length} batches, ${v.readings} readings match the roots on chain; every P-256 signature is valid for the device key registered on chain.`
    : `Curing record does not verify: ${bad.length} problem${bad.length === 1 ? "" : "s"}.`;
  return `<section class="banner ${v.ok ? "good" : "bad"}" data-testid="verify-status" data-ok="${v.ok}">
    <strong>${esc(head)}</strong>
    ${bad.length ? `<ul>${bad.slice(0, 5).map((p) => `<li>${esc(p)}</li>`).join("")}${bad.length > 5 ? `<li>and ${bad.length - 5} more</li>` : ""}</ul>` : ""}
    ${m.applied ? `<div class="small">Tamper demo: reading ${m.applied.index} (${esc(fmtTime(m.applied.t_unix))}) was changed in this browser from ${m.applied.before_milliC / 1000} °C to ${m.applied.after_milliC / 1000} °C before checking. <a href="${link(`/${location.pathname.split("/")[1]}/${m.label}`, search)}" data-nav>Undo</a></div>` : ""}
    <div class="small"><a href="${link(`/verify/${m.label}`, search, m.tamper ? { tamper: `reading:${m.tamper.index}` } : {})}" data-nav>See every batch</a></div>
  </section>`;
}

/** Amber band under the verification banner when the rule-based curing check flagged the record (packages/core, not AI). */
export function curingFlag(flags: string[], approved: boolean): string {
  if (flags.length === 0) return "";
  const what = flags.includes("no_hydration_signature")
    ? "Signatures are valid, but this record does not look like curing concrete: no hydration heat rise in the first 24 h (no_hydration_signature)."
    : `Signatures are valid, but the curing check flagged this record: ${flags.join(", ")}.`;
  const then = approved ? "The inspector approved it anyway; read the curing check below." : "No strength approval, no saving claim.";
  return `<section class="banner warn" data-testid="curing-flag" role="alert"><strong>${esc(what)}</strong> ${esc(then)}
    <div class="small">Rule-based curing check in packages/core, run on the signed readings; the AI only explains it.</div></section>`;
}

function claimStatus(m: PourModel): string {
  const claim = eventsOf(m.view, m.chain.pourId, "SavingClaimed")[0];
  const roles = accountRoles(m.view.events);
  const rejected = m.chain.rejected.filter((r) => r.fn === "claimSaving");
  let head: string;
  let body = "";
  if (claim) {
    const role = roleName(String(claim.args.role)) ?? "unknown role";
    head = `Already claimed by ${role}`;
    body = `<p>${esc(role)} (${esc(short(String(claim.args.claimant)))}) claimed the saving of ${esc(range(Number(claim.args.savingLow_kg), Number(claim.args.savingHigh_kg), "kg CO2e"))} at ${esc(fmtTime(claim.timestamp))}, block ${esc(claim.block)}. The ledger accepts one claim per pour, from one role; any later claim reverts with AlreadyClaimed.</p>`;
  } else if (!m.chain.state.pour.strengthApproved) head = "Not claimable yet: the inspector has not approved strength";
  else if (/^0x0+$/.test(m.chain.state.baseline.mixHash)) head = "Not claimable: no baseline mix was declared before the pour";
  else head = "Not claimed yet";
  const rows = rejected.map(
    (r) =>
      `<li class="rejected" data-testid="rejected-claim">${esc(r.role || whoIs(r.account, roles))} tried claimSaving: ${r.revert ? `rejected, ${esc(r.revert.name)}${r.revert.name === "AlreadyClaimed" ? ` (first claimant ${esc(whoIs(String(r.revert.args[1]), roles))})` : ""}` : "would succeed"}${r.kind === "transaction" ? `, reverted transaction ${esc(short(r.txHash ?? ""))} in block ${esc(r.block ?? "")}` : ", simulated call (eth_call), nothing sent"}</li>`,
  );
  return `<section class="card" data-testid="claim-status"><h2>Saving claim</h2><p class="status-line"><strong>${esc(head)}</strong></p>${body}${rows.length ? `<ul>${rows.join("")}</ul>` : ""}</section>`;
}

function describe(e: ChainEvent, roles: Map<string, string[]>): [string, string] {
  const a = e.args;
  switch (e.name) {
    case "BaselineDeclared":
      return ["contractor", `declared the baseline mix it would have used: GWP ${range(Number(a.baselineGwpLow), Number(a.baselineGwpHigh), "kg CO2e/m³")}, EPD sha256 ${short(String(a.baselineMixHash))}`];
    case "PourCreated":
      return ["supplier", `created the pour: ${Number(a.volumeDm3) / 1000} m³, GWP ${range(Number(a.gwpLow), Number(a.gwpHigh), "kg CO2e/m³")}, pour start ${fmtTime(String(a.pourStart))}, ticket ${short(String(a.ticketHash))}, EPD ${short(String(a.epdHash))}`];
    case "DeviceRegistered":
      return ["inspector", `registered the device (${a.deviceKind}), P-256 key ${short(String(a.qx))}`];
    case "DeviceReplaced":
      return ["inspector", `replaced the device (${a.deviceKind}), new key ${short(String(a.qx))}`];
    case "PourAccepted":
      return [whoIs(String(a.contractor), roles as never), "accepted the delivery"];
    case "StrengthApproved":
      return ["inspector", `approved strength; evidence package sha256 ${short(String(a.evidenceHash))}`];
    case "SavingClaimed":
      return [roleName(String(a.role)) ?? "?", `claimed the saving: ${range(Number(a.savingLow_kg), Number(a.savingHigh_kg), "kg CO2e")}`];
    default:
      return ["", e.name];
  }
}

function timeline(m: PourModel): string {
  const roles = accountRoles(m.view.events);
  const ev = eventsOf(m.view, m.chain.pourId);
  const rows: { block: number; idx: number; html: string; cls?: string }[] = [];
  const batches = ev.filter((e) => e.name === "BatchAppended");
  for (const e of ev.filter((x) => x.name !== "BatchAppended")) {
    const [who, what] = describe(e, roles as never);
    rows.push({ block: Number(e.block), idx: e.logIndex, html: `<td>${esc(fmtTime(e.timestamp))}</td><td><strong>${esc(who)}</strong></td><td>${esc(what)}</td><td class="mono">${esc(e.block)} · ${esc(short(e.txHash))}</td>` });
  }
  if (batches.length) {
    const f = batches[0];
    const l = batches[batches.length - 1];
    rows.push({
      block: Number(f.block),
      idx: f.logIndex,
      html: `<td>${esc(fmtTime(f.timestamp))} to ${esc(fmtTime(l.timestamp))}</td><td><strong>device</strong></td><td>${batches.length} signed batches appended (counter ${esc(f.args.counter)} to ${esc(l.args.counter)}); the ledger checked each P-256 signature and counter</td><td class="mono">${esc(f.block)} to ${esc(l.block)}</td>`,
    });
  }
  for (const r of m.chain.rejected) {
    if (r.kind !== "transaction") continue;
    rows.push({
      block: Number(r.block),
      idx: 0,
      cls: "bad-row",
      html: `<td>${esc(fmtTime(r.timestamp ?? 0))}</td><td><strong>${esc(r.role)}</strong></td><td class="no">${esc(r.fn)} rejected on chain: ${esc(r.revert?.name ?? "reverted")}</td><td class="mono">${esc(r.block ?? "")} · ${esc(short(r.txHash ?? ""))}</td>`,
    });
  }
  rows.sort((a, b) => a.block - b.block || a.idx - b.idx);
  return `<section class="card"><h2>Roles and signatures</h2>
  <div class="table-wrap"><table class="timeline" data-testid="timeline"><thead><tr><th>Time</th><th>Who</th><th>What</th><th>Block · tx</th></tr></thead><tbody>${rows.map((r) => (r.cls ? `<tr class="${r.cls}" data-testid="rejected-tx">${r.html}</tr>` : `<tr>${r.html}</tr>`)).join("")}</tbody></table></div>
  <p class="small">Who is who: ${[...roles].map(([a, r]) => `${esc(r.join(", "))} ${esc(short(a))}`).join("; ")}. Times in UTC+3.</p></section>`;
}

const docRow = (d: DocCheck) =>
  `<tr><td>${esc(d.what)}</td><td><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.path.split("/").pop())}</a></td><td class="mono">${esc(short(d.onChain, 8))}</td><td>${ok(d.matches)} ${d.computed ? (d.matches ? "file sha256 matches" : `file sha256 ${esc(short(d.computed, 8))}`) : esc(d.error ?? "")}</td></tr>`;

function fieldRows(x: AiExtraction): string {
  return Object.entries(x.fields)
    .map(([k, f]) => {
      const locked = f.status === "unverified";
      return `<tr class="st-${f.status}" data-testid="ai-field"><td>${esc(k)}</td><td><strong>${esc(f.value ?? "(none)")}</strong>${f.unit ? ` ${esc(f.unit)}` : ""}</td>
      <td class="quote">page ${f.source.page}: "${esc(f.source.quote)}"</td>
      <td>${esc(STATUS_TEXT[f.status])}${f.status === "unverified" ? `<div class="small">${esc(f.reason)}</div>` : ""}</td>
      <td><button type="button" class="approve" ${locked ? `disabled title="approval locked: ${esc(f.reason)}"` : ""}>${locked ? "locked" : "confirm"}</button></td></tr>`;
    })
    .join("");
}

function aiBlock(title: string, x: AiExtraction, docUrl: string): string {
  return `<div class="ai-out" data-testid="ai-output">
    <h3>${esc(title)}</h3>
    <p><span class="pill ai" data-testid="ai-label">AI: ${esc(aiLabel(x))}</span> model ${esc(x.model)} · prompt_sha256 <span class="mono">${esc(short(x.prompt_sha256, 8))}</span> · <a href="${esc(docUrl)}" target="_blank" rel="noopener">open document</a> · ${x.counts.verified} verified, ${x.counts.needs_review} need review, ${x.counts.unverified} unverified</p>
    <div class="table-wrap"><table class="fields"><thead><tr><th>Field</th><th>Value</th><th>Source quote</th><th>Check</th><th>Person</th></tr></thead><tbody>${fieldRows(x)}</tbody></table></div>
  </div>`;
}

function explanation(x: AiExplanation): string {
  return `<div class="ai-out" data-testid="ai-explanation"><p><span class="pill ai">AI: ${esc(aiLabel(x))}</span> model ${esc(x.model)} · prompt_sha256 <span class="mono">${esc(short(x.prompt_sha256, 8))}</span></p>
  ${x.status === "accepted" ? `<blockquote>${esc(x.text)}</blockquote><p class="small">Every number in this text appears in the stats computed by code; a text with any other number is rejected and not shown.</p>` : `<p class="no">The AI explanation was rejected: it contains numbers not computed by code (${esc(x.unknown_numbers.join(", "))}).</p>`}</div>`;
}

export function pourView(m: PourModel, search: string): string {
  const s = m.chain.state;
  const pourStart = Number(s.pour.pourStart);
  const readings = readingsOf(m.batches, pourStart);
  const vol = s.pour.volumeDm3 / 1000;
  const carbon = carbonView(vol, m.delivered, m.baseline);
  const onChainSaving = s.savingRange.map(Number);
  const fit = m.evidence?.pkg?.strength.fit ?? null;
  const sv = fit && m.verify.ok ? strengthView(readings, fit) : null;
  const ref = m.evidence?.pkg?.strength.reference ?? m.inputs.strength_reference ?? null;
  const url = `${location.origin}${link(`/pour/${m.label}`, search)}`;
  const anomalyFlags = m.file.anomaly?.flags ?? [];

  const strength = sv
    ? `<div class="table-wrap"><table class="ranges" data-testid="strength"><thead><tr><th>Age</th><th>Maturity</th><th>Strength (${STRENGTH_LABEL})</th></tr></thead><tbody>
      ${sv.checkpoints.map((c) => `<tr><td>day ${c.age_d}</td><td>${esc(Math.round(c.maturity_ch).toLocaleString("en-US"))} °C·h</td><td><strong>${esc(range(c.strength.low_mpa, c.strength.high_mpa, "MPa", 1))}</strong>${c.strength.extrapolated ? ' <span class="small">(outside the calibrated maturity span)</span>' : ""}</td></tr>`).join("")}
      </tbody></table></div>
      <p class="small">Maturity: Nurse-Saul (ASTM C1074, datum -10 °C), computed in this browser from the ${readings.length} verified readings: ${esc(Math.round(sv.lastM).toLocaleString("en-US"))} °C·h at day ${(sv.lastH / 24).toFixed(0)}. Strength: S = a + b ln(M) from the evidence package calibration, shown as prediction ± 2σ. ${ref ? `Reference only: class B25 standard strength ${ref.standard_28d_mpa} MPa at 28 days (paper p.8).` : ""}</p>`
    : m.verify.ok
      ? `<p>No strength estimate: the inspector has not approved this pour, so there is no evidence package with a calibration on chain.</p>`
      : `<p class="no">No strength estimate: the curing record does not verify, so nothing is computed from it.</p>`;

  return `<div class="pour-head">
    <div>
      <h1>Pour ${esc(m.label)}</h1>
      <p>${esc(m.inputs.story)}</p>
      <p><span class="pill device" data-testid="device-label">${esc(deviceLabel(s.device.kind))}</span></p>
    </div>
    <figure class="qr" data-testid="qr">${qrSvg(url)}<figcaption>scan to open this passport<br><span class="mono small">${esc(url)}</span></figcaption></figure>
  </div>
  ${verifyBanner(m, search)}
  ${m.verify.ok ? curingFlag(anomalyFlags, s.pour.strengthApproved) : ""}
  <div class="grid2">
    <section class="card"><h2>Mix and volume</h2>
      <p><strong>Delivered:</strong> ${esc(m.delivered.mix_code)}, ${esc(m.delivered.label)}; ${esc(m.delivered.cement_type)}, ${m.delivered.cement_kg_per_m3} kg/m³ cement <span class="small">(${esc(m.delivered.cement_basis)})</span></p>
      <p><strong>Volume:</strong> ${vol} m³ on chain (createPour, ${s.pour.volumeDm3} dm³)${m.inputs.volume_basis ? ` <span class="small">${esc(m.inputs.volume_basis)}</span>` : ""}</p>
      <p><strong>Baseline:</strong> ${m.baseline ? `${esc(m.baseline.mix_code)}, ${esc(m.baseline.label)}; declared on chain by the contractor before the pour` : "none declared"}</p>
    </section>
    <section class="card" data-testid="carbon"><h2>Embodied CO2</h2>
      <p><strong>Delivered mix:</strong> ${esc(range(carbon.delivered.low_kg, carbon.delivered.high_kg, "kg CO2e"))} <span class="small">(${vol} m³ × ${esc(range(m.delivered.gwp_total_kg_per_m3[0], m.delivered.gwp_total_kg_per_m3[1], "kg CO2e/m³"))}; on chain ${s.pour.gwpLow} to ${s.pour.gwpHigh})</span></p>
      ${carbon.baseline ? `<p><strong>Baseline mix:</strong> ${esc(range(carbon.baseline.low_kg, carbon.baseline.high_kg, "kg CO2e"))} <span class="small">(on chain ${s.baseline.gwpLow} to ${s.baseline.gwpHigh} kg CO2e/m³)</span></p>` : ""}
      ${carbon.saving ? `<p data-testid="saving"><strong>Saving, baseline vs delivered:</strong> ${esc(range(carbon.saving.low_kg, carbon.saving.high_kg, "kg CO2e"))} <span class="small">(ledger savingRange: ${esc(range(onChainSaving[0], onChainSaving[1], "kg CO2e"))}; low = baseline low minus delivered high)</span></p>` : `<p>No saving: no baseline was declared before this pour.</p>`}
      <p class="small">Source: sample EPDs (<a href="${esc(publishedUrl(m.delivered.epd_doc))}" target="_blank" rel="noopener">${esc(m.delivered.mix_code)}</a>${m.baseline ? `, <a href="${esc(publishedUrl(m.baseline.epd_doc))}" target="_blank" rel="noopener">${esc(m.baseline.mix_code)}</a>` : ""}), cement GWP ${esc(m.delivered.cement_gwp_basis)}; other constituents ${esc(m.delivered.other_basis)}. Sample values, not a real product.</p>
    </section>
  </div>
  <section class="card"><h2>Curing curve</h2>
    ${curingChart(readings, { sourceLabel: deviceLabel(s.device.kind), note: SERIES_NOTE[m.inputs.device_series], marked: m.applied?.index ?? null })}
    <p class="small">${readings.length} readings, every 30 min from ${esc(fmtTime(m.batches[0]?.readings[0]?.t_unix ?? pourStart))}; pour start on chain ${esc(fmtTime(pourStart))}.</p>
  </section>
  <section class="card"><h2>Maturity and strength</h2>
    ${strength}
    <p><strong>Curing check (rules in packages/core, not AI; run when the batches were published):</strong> ${anomalyFlags.length ? anomalyFlags.map((f) => `<span class="no">${esc(FLAG_TEXT[f] ?? f)}</span>`).join("; ") : "no flags: heat rise over the air in the first 24 h, no gaps"}</p>
    ${m.ai?.explanation ? explanation(m.ai.explanation) : ""}
  </section>
  ${claimStatus(m)}
  ${timeline(m)}
  <section class="card"><h2>Documents on chain</h2>
    <div class="table-wrap"><table class="docs" data-testid="docs"><thead><tr><th>What</th><th>File</th><th>On chain</th><th>Check in this browser</th></tr></thead><tbody>
    ${m.docs.map(docRow).join("")}${m.evidence ? docRow(m.evidence.check) : ""}</tbody></table></div>
  </section>
  ${m.ai ? `<section class="card" data-testid="ai"><h2>AI field extraction</h2><p>Claude reads the ticket photo and the EPD PDFs and proposes each field with the page and quote it came from. Code checks every PDF quote against the PDF's text; a field that fails is unverified and its approval stays locked. The AI approves nothing.</p>
    ${aiBlock(`Delivery ticket ${m.label}`, m.ai.ticket, publishedUrl(m.ai.ticket.document))}
    ${m.ai.epds.map((e) => aiBlock(`EPD, ${e.role} mix (${e.mix})`, e, publishedUrl(e.document))).join("")}
  </section>` : ""}`;
}
