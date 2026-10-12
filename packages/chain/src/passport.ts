// Exports an approved pour as a W3C Verifiable Credential 2.0 (packages/core vc.ts), signed by the inspector.
// Every value comes from files the scenario wrote: the deployment record, the transaction log with its events, the
// evidence package whose sha256 is on chain, the published batches and the sample inputs. Nothing is typed in here.
//   node src/cli.ts passport --network anvil|baseSepolia [--pour P-001]
// anvil: the inspector is Anvil's dev account with that address; its key comes from Anvil's public test mnemonic
//        (a local chain only, the same accounts the scenario used). baseSepolia: the key from $POURPROOF_SECRETS/roles.json.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mnemonicToAccount, privateKeyToAccount, type LocalAccount } from "viem/accounts";
import {
  attachProof,
  buildPassport,
  embodiedCo2,
  isoTime,
  passportTypedData,
  verifyPassport,
  type Hex,
  type PassportSubject,
  type SignedPassport,
} from "@pourproof/core";
import { REPO_ROOT, type BatchesFile } from "@pourproof/device";
import { pretty } from "./json.ts";
import { loadRoleKeys } from "./roles.ts";
import type { NetworkName } from "./scenario.ts";

/** Anvil's documented default mnemonic: public, funds nothing outside a local dev chain. */
const ANVIL_TEST_MNEMONIC = "test test test test test test test test test test test junk";

interface Step {
  step: number;
  pour: string | null;
  role: string;
  account: Hex;
  fn: string;
  args: unknown[];
  txHash: Hex;
  block: string;
  timestamp: string;
  status: "success" | "reverted";
  events: { name: string; args: Record<string, unknown> }[];
  revert: unknown;
}

interface MixInput {
  label: string;
  cement_type: string;
  cement_kg_per_m3: number;
  cement_basis: string;
  gwp_total_kg_per_m3: [number, number];
  mix_code: string;
  epd_doc: string;
}

export const passportPath = (network: string, label: string) => `scenario/${network}-passport-${label}.json`;

const read = (root: string, p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

/** One decimal, rounded outward so the stated range never gets narrower than the computed one. */
const down1 = (x: number) => Math.floor(x * 10) / 10;
const up1 = (x: number) => Math.ceil(x * 10) / 10;

/** Builds the unsigned credential for one approved pour from the scenario outputs. */
export function passportFor(network: NetworkName, label = "P-001", root = REPO_ROOT) {
  const dep = read(root, `deployments/${network}.json`);
  const log = read(root, `scenario/${network}-log.json`);
  const ev = log.evidence;
  if (ev?.pour !== label) throw new Error(`${label}: the scenario has no evidence package for this pour`);
  const evidence = read(root, ev.path);
  const inputs = read(root, "data/scenario/inputs.json");
  const pourIn = inputs.pours[label];
  const batches = read(root, `data/pours/${label}/batches.json`) as BatchesFile;

  const steps = (log.steps as Step[]).filter((s) => s.pour === label);
  const ok = (fn: string) => {
    const s = steps.filter((x) => x.fn === fn && x.status === "success");
    if (s.length === 0) throw new Error(`${label}: no successful ${fn} in scenario/${network}-log.json`);
    return s;
  };
  const event = (s: Step, name: string) => {
    const e = s.events.find((x) => x.name === name);
    if (!e) throw new Error(`${label}: ${s.fn} at step ${s.step} has no ${name} event`);
    return e.args;
  };

  const baselineStep = ok("declareBaseline")[0];
  const create = ok("createPour")[0];
  const device = ok("registerDevice")[0];
  const accept = ok("acceptPour")[0];
  const appends = ok("appendBatch");
  const approve = ok("approveStrength")[0];
  const claim = ok("claimSaving")[0];
  const refused = steps.filter((s) => s.fn === "claimSaving" && s.status === "reverted");

  const created = event(create, "PourCreated");
  const baseline = event(baselineStep, "BaselineDeclared");
  const approved = event(approve, "StrengthApproved");
  const claimed = event(claim, "SavingClaimed");
  if (approved.evidenceHash !== ev.sha256) throw new Error(`${label}: evidenceHash on chain is not the sha256 of ${ev.path}`);

  const volume_dm3 = Number(created.volumeDm3);
  const volume_m3 = volume_dm3 / 1000;
  const gwp = { low: Number(created.gwpLow), high: Number(created.gwpHigh) };
  const co2 = embodiedCo2(volume_m3, gwp);
  const delivered = inputs.mixes[pourIn.delivered_mix] as MixInput;
  const base = inputs.mixes[pourIn.baseline_mix] as MixInput;
  const readings = batches.batches.flatMap((b) => b.readings);
  const roleOf = (account: string) => Object.entries(dep.roles as Record<string, string>).find(([, a]) => a.toLowerCase() === account.toLowerCase())?.[0] ?? "unknown";

  const subject: PassportSubject = {
    id: `urn:pourproof:pour:${dep.chainId}:${dep.ledger.address}:${batches.pourId}`,
    type: "ConcretePour",
    pourId: batches.pourId as Hex,
    pourLabel: label,
    notice: "Testnet demo, no real claim. Sample documents and sample mix values; the curing record is replayed from a published dataset.",
    mix: {
      delivered: {
        mixCode: delivered.mix_code,
        label: delivered.label,
        cementType: delivered.cement_type,
        cementKgPerM3: delivered.cement_kg_per_m3,
        cementBasis: delivered.cement_basis,
        gwpTotalKgCo2ePerM3: { low: gwp.low, high: gwp.high, onChain: "createPour gwpLow, gwpHigh" },
        epd: { document: delivered.epd_doc, sha256: created.epdHash },
      },
      baseline: {
        mixCode: base.mix_code,
        label: base.label,
        cementType: base.cement_type,
        cementKgPerM3: base.cement_kg_per_m3,
        gwpTotalKgCo2ePerM3: { low: Number(baseline.baselineGwpLow), high: Number(baseline.baselineGwpHigh), onChain: "declareBaseline" },
        declaredBy: { role: "contractor", account: baselineStep.account, before: "the pour was created on chain" },
        mixHash: baseline.baselineMixHash,
        epdDocument: base.epd_doc,
      },
    },
    volume: { m3: volume_m3, onChainDm3: volume_dm3 },
    embodiedCo2: { lowKg: co2.low_kg, highKg: co2.high_kg, unit: "kg CO2e", scope: "A1-A3", basis: "volume x the delivered mix's GWP range from its EPD, as declared on chain" },
    savingVsBaseline: {
      lowKg: Number(claimed.savingLow_kg),
      highKg: Number(claimed.savingHigh_kg),
      unit: "kg CO2e",
      basis: "computed on chain by savingRange: low = (baseline low - delivered high) x m3, high = (baseline high - delivered low) x m3",
      claimedOnce: { role: roleOf(claim.account), account: claim.account, txHash: claim.txHash },
      laterClaimsRefused: refused.map((s) => ({ role: s.role, account: s.account, txHash: s.txHash })),
    },
    curing: {
      device: { kind: batches.deviceKind, source: batches.source, qx: batches.device.qx, qy: batches.device.qy },
      curve: pourIn.curing_curve,
      batches: batches.batches.length,
      readings: readings.length,
      from: isoTime(readings[0].t_unix),
      to: isoTime(readings[readings.length - 1].t_unix),
      merkleRoots: "one per batch, in the BatchAppended events; each batch signed by the device key (P-256) and checked on chain",
      maturity: { method: evidence.maturity.method, atHours: evidence.maturity.at_h, celsiusHours: Math.round(evidence.maturity.maturity_ch) },
      strength: {
        label: evidence.strength.label,
        calibration: evidence.strength.calibration,
        range: evidence.strength.range,
        checkpoints: (evidence.strength.checkpoints as { age_d: number; strength: { low_mpa: number; high_mpa: number; extrapolated: boolean } }[]).map((c) => ({
          ageDays: c.age_d,
          lowMpa: down1(c.strength.low_mpa),
          highMpa: up1(c.strength.high_mpa),
          extrapolated: c.strength.extrapolated,
        })),
      },
      anomalyFlags: evidence.anomaly.flags,
    },
    documents: {
      ticketSha256: created.ticketHash,
      epdSha256: created.epdHash,
      baselineMixHash: baseline.baselineMixHash,
      evidence: { path: ev.path, sha256: approved.evidenceHash },
    },
    dataset: { doi: evidence.dataset.doi, license: evidence.dataset.license, attribution: evidence.dataset.attribution },
    chain: {
      network,
      networkLabel: dep.networkLabel,
      chainId: dep.chainId,
      ledger: dep.ledger.address,
      timeMode: log.timeMode,
      approvedAtBlock: Number(approve.block),
      txs: {
        declareBaseline: baselineStep.txHash,
        createPour: create.txHash,
        registerDevice: device.txHash,
        acceptPour: accept.txHash,
        firstBatch: appends[0].txHash,
        lastBatch: appends[appends.length - 1].txHash,
        approveStrength: approve.txHash,
        claimSaving: claim.txHash,
      },
    },
  };
  const vc = buildPassport({ subject, issuer: approve.account, validFrom: Number(approve.timestamp) });
  return { vc, inspector: (dep.roles.inspector as string).toLowerCase() as Hex, chainId: dep.chainId as number, ledger: dep.ledger.address as Hex };
}

/** The inspector's signing account: Anvil's dev account with that address, or the Base Sepolia key file. */
export function inspectorAccount(network: NetworkName, inspector: Hex): LocalAccount {
  if (network === "baseSepolia") return privateKeyToAccount(loadRoleKeys().inspector);
  for (let i = 0; i < 10; i++) {
    const a = mnemonicToAccount(ANVIL_TEST_MNEMONIC, { addressIndex: i });
    if (a.address.toLowerCase() === inspector) return a;
  }
  throw new Error(`inspector ${inspector} is not one of Anvil's default dev accounts`);
}

/** Builds, signs (EIP-712, as a wallet would) and checks the passport; writes it next to the scenario log. */
export async function exportPassport(network: NetworkName, label = "P-001", root = REPO_ROOT): Promise<{ path: string; vc: SignedPassport }> {
  const { vc, inspector, chainId, ledger } = passportFor(network, label, root);
  const account = inspectorAccount(network, inspector);
  const signature = await account.signTypedData(passportTypedData(vc));
  const signed = attachProof(vc, signature);
  const check = verifyPassport(signed, { expectedIssuer: inspector, chainId, ledger });
  if (!check.ok) throw new Error(`passport does not verify: ${check.problems.join("; ")}`);
  const path = passportPath(network, label);
  writeFileSync(join(root, path), pretty(signed));
  return { path, vc: signed };
}
