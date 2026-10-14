// Everything one pour page needs, loaded and checked once: chain state, published batches (optionally tampered),
// the verification result, documents and their on-chain hashes, the evidence package, AI outputs.
import type { Hex } from "@pourproof/core";
import type { AiPour } from "./ai.ts";
import { eventsOf, type ChainPour, type ChainView } from "./chain.ts";
import type { AppConfig } from "./config.ts";
import { evidencePath, fileHash, loadAi, loadBatches, loadChain, loadInputs, loadJson, publishedUrl, type InputsFile, type Mix, type PourInputs } from "./data.ts";
import type { EvidencePackage } from "./compute.ts";
import { applyTamper, nightsOf, parseTamper, type Night, type Tamper, type TamperApplied } from "./tamper.ts";
import { verifyBatches, type BatchesFile, type OnChainBatch, type PublishedBatch, type VerifyResult } from "./verify.ts";

export interface DocCheck {
  what: string;
  path: string;
  url: string;
  onChain: Hex;
  computed: Hex | null;
  matches: boolean;
  error?: string;
}

export interface PourModel {
  label: string;
  view: ChainView;
  chain: ChainPour;
  inputs: PourInputs;
  delivered: Mix;
  baseline: Mix | null;
  file: BatchesFile;
  batches: PublishedBatch[];
  tamper: Tamper | null;
  applied: TamperApplied | null;
  /** the pour's nights in the published file (for the tamper card) */
  nights: Night[];
  onChain: OnChainBatch[];
  verify: VerifyResult;
  /** problems with the published file itself (signed for another chain or ledger) */
  contextProblems: string[];
  docs: DocCheck[];
  evidence: { path: string; url: string; pkg: EvidencePackage | null; check: DocCheck } | null;
  ai: AiPour | null;
}

const ZERO = /^0x0+$/i;

async function checkDoc(what: string, path: string, onChain: Hex): Promise<DocCheck> {
  const url = publishedUrl(path);
  try {
    const computed = await fileHash(url);
    return { what, path, url, onChain, computed, matches: computed.toLowerCase() === onChain.toLowerCase() };
  } catch (e) {
    return { what, path, url, onChain, computed: null, matches: false, error: String(e instanceof Error ? e.message : e) };
  }
}

/** The batch part of a pour page: the published file (optionally tampered) checked against the chain view. No I/O. */
export function checkPour(view: ChainView, chain: ChainPour, file: BatchesFile, search: string): Pick<PourModel, "batches" | "tamper" | "applied" | "nights" | "onChain" | "verify" | "contextProblems"> {
  const contextProblems: string[] = [];
  if (file.context.chainId !== view.chainId || file.context.ledger.toLowerCase() !== view.ledger.toLowerCase()) {
    contextProblems.push(
      `The published batches were signed for chain ${file.context.chainId}, ledger ${file.context.ledger}; this page reads chain ${view.chainId}, ledger ${view.ledger}`,
    );
  }
  if (file.pourId.toLowerCase() !== chain.pourId.toLowerCase()) contextProblems.push(`The published batches are for pour id ${file.pourId}, not ${chain.pourId}`);

  const pourStart = Number(chain.state.pour.pourStart);
  const tamper = parseTamper(search, { batches: file.batches, pourStart });
  const t = tamper ? applyTamper(file.batches, tamper) : null;
  const batches = t?.batches ?? file.batches;

  const onChain: OnChainBatch[] = eventsOf(view, chain.pourId, "BatchAppended").map((e) => ({
    counter: Number(e.args.counter),
    fromTs: Number(e.args.fromTs),
    toTs: Number(e.args.toTs),
    root: e.args.root as Hex,
    block: e.block,
    txHash: e.txHash,
  }));
  const verify = verifyBatches({
    chainId: view.chainId,
    ledger: view.ledger,
    pourId: chain.pourId,
    deviceKey: { qx: chain.state.device.qx, qy: chain.state.device.qy },
    onChain,
    published: batches,
  });
  if (contextProblems.length) verify.ok = false;
  return { batches, tamper: t ? tamper : null, applied: t?.applied ?? null, nights: nightsOf(file.batches, pourStart), onChain, verify, contextProblems };
}

export async function loadPour(cfg: AppConfig, label: string, search: string): Promise<PourModel> {
  const inputsFile: InputsFile = await loadInputs();
  const view = await loadChain(cfg, Object.keys(inputsFile.pours));
  const chain = view.pours[label];
  const inputs = inputsFile.pours[label];
  if (!chain || !inputs) throw new Error(`pour ${label} is not on this chain view`);
  const file = await loadBatches(label);
  const checked = checkPour(view, chain, file, search);

  const delivered = inputsFile.mixes[inputs.delivered_mix];
  const baseline = inputs.baseline_mix ? inputsFile.mixes[inputs.baseline_mix] : null;
  const docs = [checkDoc("delivery ticket (photo) = ticketHash", inputs.ticket_doc, chain.state.pour.ticketHash)];
  docs.push(checkDoc(`EPD of the delivered mix (${delivered.mix_code}) = epdHash`, delivered.epd_doc, chain.state.pour.epdHash));
  if (baseline && !ZERO.test(chain.state.baseline.mixHash)) docs.push(checkDoc(`EPD of the declared baseline (${baseline.mix_code}) = baseline mixHash`, baseline.epd_doc, chain.state.baseline.mixHash));

  let evidence: PourModel["evidence"] = null;
  if (!ZERO.test(chain.state.pour.evidenceHash)) {
    const path = evidencePath(view.network, label);
    const check = await checkDoc("evidence package = evidenceHash (approveStrength)", path, chain.state.pour.evidenceHash);
    const pkg = check.computed ? await loadJson<EvidencePackage>(publishedUrl(path)).catch(() => null) : null;
    evidence = { path, url: publishedUrl(path), pkg, check };
  }

  const ai = (await loadAi().catch(() => null))?.pours[label] ?? null;
  return {
    label,
    view,
    chain,
    inputs,
    delivered,
    baseline,
    file,
    ...checked,
    docs: await Promise.all(docs),
    evidence,
    ai,
  };
}
