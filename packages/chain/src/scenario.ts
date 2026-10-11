// End-to-end scenario on a real chain (local Anvil or Base Sepolia): deploy, roles, two pours, every device batch,
// strength approval, one saving claim and the rejected second claim, plus the P-002 tamper attempts. Rejected calls are
// sent as real transactions so the chain itself records the revert; the revert name comes from the same call simulated
// on the state just before it.
//
// Time. On Anvil the scenario moves the chain clock forward ("advanced"): the baseline, the pour record, the device and
// the acceptance are mined before pourStart, each batch a little after its last reading, the approval after the last
// batch. Base Sepolia's clock cannot be moved, so the readings are placed in the past instead ("backdated", the replay
// rule in packages/device); there the chain order (NotBeforePour) shows the baseline came before the pour.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseEventLogs,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type PublicClient,
} from "viem";
import type { Hex } from "@pourproof/core";
import {
  REPO_ROOT,
  SCENARIO_TEXT,
  loadDeviceKey,
  replay,
  replayPourStart,
  tamperAttempts,
  type BatchesFile,
  type Dataset,
  type DeviceKey,
  type PublishedBatch,
  type TamperFile,
} from "@pourproof/device";
import { loadLedgerArtifact } from "./artifacts.ts";
import { aiEvidence } from "./ai-evidence.ts";
import { evidencePackage, type EvidenceDataset, type Mix } from "./evidence.ts";
import { rpc } from "./anvil.ts";
import { pretty, sha256Hex } from "./json.ts";
import type { RoleName } from "./roles.ts";

export type NetworkName = "anvil" | "baseSepolia";

export const NETWORK_LABEL: Record<NetworkName, string> = { anvil: "local Anvil", baseSepolia: "Base Sepolia" };

export type TimeMode = "advanced" | "backdated";
export const TIME_MODE: Record<NetworkName, TimeMode> = { anvil: "advanced", baseSepolia: "backdated" };
export const TIME_NOTE: Record<TimeMode, string> = {
  advanced: "chain clock advanced by the scenario: each batch is mined shortly after its last reading",
  backdated: "readings time-shifted into the past from the published dataset",
};

/** Advanced mode timing, in seconds. Fixed, so a re-run mines the same blocks at the same times. */
export const TIMING = {
  /** pourStart = the block before the pour's setup + this; setup (baseline, pour, device, acceptance) fits well inside */
  pourLeadS: 1800,
  /** P-002 is poured the next day: its pourStart = P-001's + this */
  secondPourOffsetS: 27 * 3600,
  /** a batch is sent this long after its last reading (the device's upload delay) */
  sendDelayS: 120,
  /** the inspector approves this long after the last P-001 batch is on chain */
  approveAfterS: 3600,
  /** each claim comes this long after the step before it */
  claimAfterS: 3600,
};
/** Seconds per block when nothing sets the next timestamp (the Anvil node is started with this interval). */
export const BLOCK_INTERVAL_S = 12;

/** Gas limits for sent transactions. Fixed limits skip estimation, which would fail for the calls meant to revert. */
export const GAS = { appendBatch: 800_000n, default: 400_000n };

/** Rough gas per role for the whole scenario, used to check testnet balances before the first transaction. */
export const GAS_BUDGET: Record<RoleName, bigint> = {
  admin: 3_000_000n + 4n * 60_000n,
  supplier: 2n * 160_000n + 80_000n,
  contractor: 120_000n + 2n * 60_000n + 60_000n,
  inspector: 2n * 130_000n + 80_000n,
  owner: 0n,
  relay: 226n * 400_000n,
};

export interface ScenarioInputs {
  /** epd_doc: the mix's sample EPD (PDF), relative to the repo root; its sha256 goes on chain */
  mixes: Record<string, Mix & { epd_doc: string }>;
  /** ticket_doc: the pour's delivery ticket photo (PNG); its sha256 goes on chain as ticketHash */
  pours: Record<string, { baseline_mix: string | null; delivered_mix: string; volume_m3: number; ticket: unknown; ticket_doc: string; device_series: string; strength_reference?: unknown }>;
}

/** sha256 of a committed document (data/sample-docs), the hash the parties put on chain. */
export const docHash = (repoPath: string): Hex => sha256Hex(readFileSync(join(REPO_ROOT, repoPath)));

export interface ScenarioOptions {
  network: NetworkName;
  chain: Chain;
  rpcUrl: string;
  /** Anvil: unlocked node accounts (addresses). Base Sepolia: local accounts from roles.json. */
  roles: Record<RoleName, Account | Address>;
  pollingInterval: number;
  /** where deployments/, scenario/, apps/web/public/snapshot/ and data/pours/ are written */
  outRoot?: string;
  /** also refresh data/pours/* (the committed device outputs) with the batches signed for this chain */
  writeDataPours?: boolean;
  log?: (s: string) => void;
}

export interface Revert {
  name: string;
  args: unknown[];
}

export interface Step {
  step: number;
  pour: string | null;
  role: RoleName;
  account: Address;
  fn: string;
  args: unknown[];
  txHash: Hash;
  block: bigint;
  timestamp: bigint;
  gasUsed: bigint;
  status: "success" | "reverted";
  events: { name: string; args: unknown }[];
  revert: Revert | null;
  note?: string;
}

/** One scheduled call. `at` = the earliest block time it may be mined at (advanced mode); in backdated mode only order. */
interface Action {
  at: number;
  run: () => Promise<unknown>;
}

/** The custom error a reverted call carries, if any. */
export function revertOf(e: unknown): Revert | null {
  if (!(e instanceof BaseError)) return null;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
  if (!(r instanceof ContractFunctionRevertedError) || !r.data?.errorName) return null;
  return { name: r.data.errorName, args: [...(r.data.args ?? [])] };
}

const addr = (a: Account | Address): Address => (typeof a === "string" ? a : a.address);
const bytes32OfHex = (h: Hex) => h as `0x${string}`;

/** Checks every role can pay for its part of the scenario at twice the current gas price. Throws with the shortfall. */
export async function checkBalances(pub: PublicClient, roles: Record<RoleName, Account | Address>, network: NetworkName) {
  const price = (await pub.getGasPrice()) * 2n;
  const need = new Map<Address, { roles: RoleName[]; wei: bigint }>();
  for (const [r, a] of Object.entries(roles) as [RoleName, Account | Address][]) {
    const k = addr(a);
    const cur = need.get(k) ?? { roles: [], wei: 0n };
    cur.roles.push(r);
    cur.wei += GAS_BUDGET[r] * price;
    need.set(k, cur);
  }
  const short: string[] = [];
  for (const [a, n] of need) {
    if (n.wei === 0n) continue;
    const have = await pub.getBalance({ address: a });
    if (have < n.wei) short.push(`${n.roles.join("+")} ${a}: has ${have} wei, needs about ${n.wei} wei`);
  }
  if (short.length) {
    throw new Error(
      `${NETWORK_LABEL[network]}: not enough test ETH, stopping before any transaction (no fallback to Anvil):\n  ${short.join("\n  ")}`,
    );
  }
}

export async function runScenario(o: ScenarioOptions) {
  const say = o.log ?? ((s: string) => console.log(s));
  const out = o.outRoot ?? REPO_ROOT;
  const { abi, bytecode } = loadLedgerArtifact();
  const pub = createPublicClient({ chain: o.chain, transport: http(o.rpcUrl, { batch: true }), pollingInterval: o.pollingInterval }) as PublicClient;
  const wallet = createWalletClient({ chain: o.chain, transport: http(o.rpcUrl) });
  const chainId = await pub.getChainId();
  if (chainId !== o.chain.id) throw new Error(`RPC answers chain ${chainId}, expected ${o.chain.id}`);
  if (o.network !== "anvil") await checkBalances(pub, o.roles, o.network);

  const dataset = JSON.parse(readFileSync(join(REPO_ROOT, "data", "dataset", "mendeley-nmr8pjx8d8.json"), "utf8")) as Dataset & EvidenceDataset;
  const inputs = JSON.parse(readFileSync(join(REPO_ROOT, "data", "scenario", "inputs.json"), "utf8")) as ScenarioInputs;
  const k1 = loadDeviceKey("P-001");
  const k2 = loadDeviceKey("P-002");

  const steps: Step[] = [];
  const blockTime = new Map<bigint, bigint>();
  /** Block timestamps, fetched in one batched request at the end. */
  const fillTimes = async (blocks: bigint[]) => {
    const missing = [...new Set(blocks)].filter((n) => !blockTime.has(n));
    const got = await Promise.all(missing.map((n) => pub.getBlock({ blockNumber: n })));
    got.forEach((b) => blockTime.set(b.number, b.timestamp));
  };
  // Fees fixed once per run at three times the current price: no fee lookups per transaction.
  const price = await pub.getGasPrice();
  const fees = { maxFeePerGas: price * 3n, maxPriorityFeePerGas: price < 1_000_000n ? price : 1_000_000n };
  const receipt = async (hash: Hash) => {
    for (let i = 0; ; i++) {
      try {
        return await pub.getTransactionReceipt({ hash });
      } catch (e) {
        if (i * o.pollingInterval > 180_000) throw new Error(`no receipt for ${hash} after 180 s: ${e instanceof Error ? e.message : e}`);
        await new Promise((r) => setTimeout(r, o.pollingInterval));
      }
    }
  };

  // ---- deploy
  const admin = o.roles.admin;
  const deployHash = await wallet.deployContract({ abi, bytecode, args: [addr(admin)], account: admin, chain: o.chain, ...fees });
  const deployRc = await receipt(deployHash);
  if (deployRc.status !== "success" || !deployRc.contractAddress) throw new Error(`deploy failed: ${deployHash}`);
  const ledger = deployRc.contractAddress;
  steps.push({
    step: 0,
    pour: null,
    role: "admin",
    account: addr(admin),
    fn: "deploy PourLedger",
    args: [addr(admin)],
    txHash: deployHash,
    block: deployRc.blockNumber,
    timestamp: 0n,
    gasUsed: deployRc.gasUsed,
    status: "success",
    events: parseEventLogs({ abi, logs: deployRc.logs }).map((l) => ({ name: l.eventName, args: l.args })),
    revert: null,
  });
  say(`deployed PourLedger at ${ledger} (block ${deployRc.blockNumber})`);

  // Advanced mode: the scenario keeps its own clock, the time of the latest mined block. Each send either lets the node
  // add BLOCK_INTERVAL_S or sets the next block's time to the action's `at`, whichever is later. The planned times are
  // checked against the mined blocks at the end.
  const advanced = TIME_MODE[o.network] === "advanced";
  let clock = 0;
  const planned = new Map<bigint, number>();
  if (advanced) {
    await rpc(o.rpcUrl, "anvil_setBlockTimestampInterval", [BLOCK_INTERVAL_S]);
    clock = Number((await pub.getBlock({ blockNumber: deployRc.blockNumber })).timestamp);
  }
  const nextBlockTime = async (at?: number) => {
    if (!advanced) return undefined;
    if (at !== undefined && at > clock + BLOCK_INTERVAL_S) {
      await rpc(o.rpcUrl, "evm_setNextBlockTimestamp", [at]);
      clock = at;
    } else clock += BLOCK_INTERVAL_S;
    return clock;
  };

  /** Sends one call. `expect` = the custom error it must revert with; the tx is still sent and mined. */
  const send = async (role: RoleName, fn: string, args: unknown[], pour: string | null, opt: { at?: number; expect?: string; note?: string } = {}) => {
    const account = o.roles[role];
    const ts = await nextBlockTime(opt.at);
    const simulate = async (blockNumber?: bigint, time?: number) => {
      try {
        // viem passes blockOverrides through to eth_call: the call runs at the block time the tx will be mined at.
        const overrides = time === undefined ? {} : { blockOverrides: { time: BigInt(time) } };
        await pub.simulateContract({ address: ledger, abi: abi as Abi, functionName: fn, args, account, blockNumber, ...(overrides as object) });
        return null;
      } catch (e) {
        const r = revertOf(e);
        if (!r) throw e;
        return r;
      }
    };
    // Calls meant to revert are simulated first, so a wrong expectation stops the run before anything is sent.
    const revert = opt.expect ? await simulate(undefined, ts) : null;
    if (opt.expect && revert?.name !== opt.expect) throw new Error(`${fn} by ${role}: expected ${opt.expect}, simulation gives ${revert?.name ?? "success"}`);
    const hash = await wallet.sendTransaction({
      account,
      to: ledger,
      data: encodeFunctionData({ abi: abi as Abi, functionName: fn, args }),
      gas: fn === "appendBatch" ? GAS.appendBatch : GAS.default,
      ...fees,
      chain: null,
    });
    const rc = await receipt(hash);
    if (rc.status === "reverted" && !opt.expect) {
      const why = await simulate(rc.blockNumber - 1n).catch(() => null);
      throw new Error(`${fn} by ${role}: tx ${hash} reverted (${why?.name ?? "unknown"})`);
    }
    if (rc.status === "success" && opt.expect) throw new Error(`${fn} by ${role}: tx ${hash} succeeded, expected ${opt.expect}`);
    if (ts !== undefined) planned.set(rc.blockNumber, ts);
    const s: Step = {
      step: steps.length,
      pour,
      role,
      account: addr(account),
      fn,
      args,
      txHash: hash,
      block: rc.blockNumber,
      timestamp: BigInt(ts ?? 0),
      gasUsed: rc.gasUsed,
      status: rc.status,
      events: parseEventLogs({ abi, logs: rc.logs }).map((l) => ({ name: l.eventName, args: l.args })),
      revert,
      ...(opt.note ? { note: opt.note } : {}),
    };
    steps.push(s);
    return s;
  };
  const role = async (name: string) => (await pub.readContract({ address: ledger, abi, functionName: name })) as Hex;

  // ---- roles
  for (const r of ["supplier", "contractor", "inspector", "owner"] as const) {
    await send("admin", "grantRole", [await role(`${r.toUpperCase()}_ROLE`), addr(o.roles[r])], null);
  }

  // ---- device replay for this ledger
  const roleBlock = await pub.getBlock();
  const now = Number(roleBlock.timestamp);
  if (advanced && now !== clock) throw new Error(`chain clock ${now} differs from the scenario clock ${clock}`);
  // advanced: P-001's setup starts at the next block and its pour begins TIMING.pourLeadS after this block; P-002 the
  // next day. backdated: both pours lie in the past so every batch is already closed (FutureBatch).
  const times = advanced
    ? (() => {
        const s1 = now + TIMING.pourLeadS;
        const s2 = s1 + TIMING.secondPourOffsetS;
        const rule = (label: string, s: number) =>
          label === "P-001"
            ? `advanced: chain clock moved forward by the scenario; pourStart = block time ${now} before the pour setup + ${TIMING.pourLeadS} s; each batch is sent ${TIMING.sendDelayS} s after its last reading`
            : `advanced: chain clock moved forward by the scenario; pourStart = P-001 pourStart ${s - TIMING.secondPourOffsetS} + ${TIMING.secondPourOffsetS} s (next day); each batch is sent ${TIMING.sendDelayS} s after its last reading`;
        return { p1: { pourStart: s1, rule: rule("P-001", s1), replayBlockTime: undefined }, p2: { pourStart: s2, rule: rule("P-002", s2), replayBlockTime: undefined } };
      })()
    : (() => {
        const { pourStart, rule } = replayPourStart(now, dataset.series.box1, dataset.series.ambient);
        const t = { pourStart, rule, replayBlockTime: now };
        return { p1: t, p2: t };
      })();
  const common = { dataset, chainId, ledger: ledger as Hex };
  const timeFields = (t: { pourStart: number; rule: string; replayBlockTime?: number }) => ({ pourStart: t.pourStart, pourStartRule: t.rule, replayBlockTime: t.replayBlockTime });
  const p1 = replay({ ...common, ...timeFields(times.p1), pourLabel: "P-001", seriesName: "box1", scenario: SCENARIO_TEXT["P-001"], key: k1 });
  const p2 = replay({ ...common, ...timeFields(times.p2), pourLabel: "P-002", seriesName: "ambient", scenario: SCENARIO_TEXT["P-002"], key: k2 });
  const t2 = tamperAttempts(p2, k1);
  say(`replayed devices for ${NETWORK_LABEL[o.network]} (${TIME_MODE[o.network]}): P-001 pourStart ${p1.pourStart}, P-002 pourStart ${p2.pourStart}`);

  const mixOf = (name: string) => {
    const m = inputs.mixes[name];
    if (!m) throw new Error(`mix ${name} not in inputs`);
    return m;
  };
  const append = (f: BatchesFile, b: PublishedBatch, opt: { at?: number; expect?: string; note?: string } = {}) =>
    send("relay", "appendBatch", [f.pourId, BigInt(b.counter), BigInt(b.fromTs), BigInt(b.toTs), b.root, b.r, b.s], f.pourLabel, opt);
  const createPour = async (label: string, f: BatchesFile, at?: number) => {
    const p = inputs.pours[label];
    const mix = mixOf(p.delivered_mix);
    const [lo, hi] = mix.gwp_total_kg_per_m3;
    return send(
      "supplier",
      "createPour",
      [f.pourId, bytes32OfHex(docHash(p.ticket_doc)), bytes32OfHex(docHash(mix.epd_doc)), Math.round(p.volume_m3 * 1000), lo, hi, BigInt(f.pourStart)],
      label,
      { at, note: `ticketHash = sha256 of ${p.ticket_doc}, epdHash = sha256 of ${mix.epd_doc}` },
    );
  };
  const register = (f: BatchesFile, k: DeviceKey) => send("inspector", "registerDevice", [f.pourId, k.qx, k.qy, f.deviceKind], f.pourLabel);
  const sent = (b: PublishedBatch) => b.toTs + TIMING.sendDelayS;
  const before = (s: Step, f: BatchesFile) => {
    if (advanced && s.timestamp >= BigInt(f.pourStart)) throw new Error(`${f.pourLabel} ${s.fn} planned at ${s.timestamp}, not before pourStart ${f.pourStart}`);
  };

  // The whole story as scheduled actions, run in order of `at` (ties keep the order they were added in).
  const actions: Action[] = [];
  const plan = (t: number, run: () => Promise<unknown>) => actions.push({ at: t, run });

  // ---- P-001: honest low-clinker pour; the contractor declares the baseline before the pour exists on chain
  const in1 = inputs.pours["P-001"];
  const base = mixOf(in1.baseline_mix!);
  // In backdated mode `at` only orders the actions, so each pour's setup is keyed just before its (past) pourStart.
  plan(advanced ? now : p1.pourStart - TIMING.pourLeadS, async () => {
    for (const s of [
      await send("contractor", "declareBaseline", [p1.pourId, bytes32OfHex(docHash(base.epd_doc)), base.gwp_total_kg_per_m3[0], base.gwp_total_kg_per_m3[1]], "P-001", {
        note: `declared before the pour exists on chain; baselineMixHash = sha256 of ${base.epd_doc}`,
      }),
      await createPour("P-001", p1),
      await register(p1, k1),
      await send("contractor", "acceptPour", [p1.pourId], "P-001"),
    ])
      before(s, p1);
  });
  for (const b of p1.batches) plan(sent(b), () => append(p1, b, { at: sent(b) }));
  const ev = evidencePackage({
    pour: p1,
    dataset,
    network: o.network,
    baseline: base,
    delivered: mixOf(in1.delivered_mix),
    volume_m3: in1.volume_m3,
    strengthReference: in1.strength_reference,
    ai: await aiEvidence(in1.ticket_doc, [base.epd_doc, mixOf(in1.delivered_mix).epd_doc]),
  });
  const evidencePath = `scenario/${o.network}-evidence-P-001.json`;
  const tApprove = sent(p1.batches.at(-1)!) + TIMING.approveAfterS;
  plan(tApprove, async () => {
    await send("inspector", "approveStrength", [p1.pourId, ev.sha256], "P-001", { at: tApprove, note: `evidenceHash = sha256 of ${evidencePath}` });
    await send("supplier", "claimSaving", [p1.pourId], "P-001", { at: tApprove + TIMING.claimAfterS });
    await send("contractor", "claimSaving", [p1.pourId], "P-001", { at: tApprove + 2 * TIMING.claimAfterS, expect: "AlreadyClaimed", note: "second claim on the same pour" });
  });

  // ---- P-002: tamper case. Batch 0, then the forged batch 1 (other device's key) when batch 1 closes, then batch 2
  // sent with batch 1 withheld when batch 2 closes; the honest batch 1 and the rest follow.
  const tamperResults: { id: string; description: string; expectRevert: string; step: number; txHash: Hash; block: bigint; revert: Revert | null }[] = [];
  const tSetup2 = p2.pourStart - TIMING.pourLeadS;
  plan(tSetup2, async () => {
    for (const s of [await createPour("P-002", p2, tSetup2), await register(p2, k2), await send("contractor", "acceptPour", [p2.pourId], "P-002")]) before(s, p2);
  });
  plan(sent(p2.batches[0]), () => append(p2, p2.batches[0], { at: sent(p2.batches[0]) }));
  const attempt = (id: "other_device_key" | "skipped_batch", counter: number) => {
    const a = t2.attempts.find((x) => x.id === id)!;
    const t = sent(p2.batches[counter]);
    plan(t, async () => {
      const s = await append(p2, a.batch, { at: t, expect: a.expectRevert, note: `tamper attempt ${a.id}: ${a.description}` });
      tamperResults.push({ id: a.id, description: a.description, expectRevert: a.expectRevert, step: s.step, txHash: s.txHash, block: s.block, revert: s.revert });
    });
    return t;
  };
  attempt("other_device_key", 1);
  const tSkip = attempt("skipped_batch", 2);
  for (const b of p2.batches.slice(1)) {
    const t = Math.max(sent(b), tSkip);
    plan(t, () => append(p2, b, { at: t }));
  }

  const ordered = actions.map((a, i) => ({ ...a, i })).sort((x, y) => x.at - y.at || x.i - y.i);
  for (const a of ordered) await a.run();
  say(`P-001: ${p1.batches.length} batches appended; P-002: ${p2.batches.length} batches, tamper attempts rejected: ${tamperResults.map((t) => t.revert?.name).join(", ")}`);

  // ---- read the final state back from the chain
  const head = await pub.getBlock();
  const decoded = [];
  for (let from = deployRc.blockNumber; from <= head.number; from += 2000n) {
    const to = from + 1999n < head.number ? from + 1999n : head.number;
    decoded.push(...parseEventLogs({ abi, logs: await pub.getLogs({ address: ledger, fromBlock: from, toBlock: to }) }));
  }
  await fillTimes([...steps.map((x) => x.block), ...decoded.map((l) => l.blockNumber)]);
  for (const x of steps) {
    const t = blockTime.get(x.block)!;
    if (planned.has(x.block) && BigInt(planned.get(x.block)!) !== t) throw new Error(`step ${x.step} (${x.fn}): block ${x.block} mined at ${t}, planned ${planned.get(x.block)}`);
    x.timestamp = t;
  }
  const events = decoded.map((l) => ({
    name: l.eventName,
    args: l.args,
    block: l.blockNumber,
    timestamp: blockTime.get(l.blockNumber)!,
    txHash: l.transactionHash,
    logIndex: l.logIndex,
  }));
  const read = (fn: string, id: Hex) => pub.readContract({ address: ledger, abi, functionName: fn, args: [id] });
  const chainState = async (id: Hex) => ({
    pour: await read("pour", id),
    baseline: await read("baseline", id),
    device: await read("deviceOf", id),
    nextCounter: await read("nextCounter", id),
    savingRange: await read("savingRange", id),
  });

  const deployment = {
    network: o.network,
    networkLabel: NETWORK_LABEL[o.network],
    chainId,
    rpc: o.network === "anvil" ? "local Anvil started by the scenario (stopped afterwards)" : o.rpcUrl,
    ledger: { contract: "PourLedger (includes DeviceRegistry)", address: ledger, txHash: deployHash, block: deployRc.blockNumber },
    compiler: { solc: "0.8.28", evmVersion: "prague", optimizer: true, codeHash: keccak256(bytecode) },
    roles: Object.fromEntries(Object.entries(o.roles).map(([r, a]) => [r, addr(a)])),
  };
  const log = {
    format: "pourproof.scenario-log/1",
    network: o.network,
    networkLabel: NETWORK_LABEL[o.network],
    chainId,
    ledger,
    deviceKind: p1.deviceKind,
    source: p1.source,
    timeMode: TIME_MODE[o.network],
    timeNote: TIME_NOTE[TIME_MODE[o.network]],
    ...(advanced ? { timing: TIMING } : {}),
    pourStart: p1.pourStart,
    pourStartRule: p1.pourStartRule,
    pours: Object.fromEntries([p1, p2].map((f) => [f.pourLabel, { pourId: f.pourId, pourStart: f.pourStart, pourStartRule: f.pourStartRule }])),
    evidence: { pour: "P-001", path: evidencePath, sha256: ev.sha256 },
    tamper: tamperResults,
    steps,
  };
  const compact = (f: BatchesFile) => ({
    ...f,
    batches: f.batches.map((b) => ({
      counter: b.counter,
      fromTs: b.fromTs,
      toTs: b.toTs,
      root: b.root,
      digest: b.digest,
      r: b.r,
      s: b.s,
      readings: b.readings.map((r) => [r.t_unix, r.temp_milliC]),
    })),
  });
  const snapshot = {
    format: "pourproof.snapshot/1",
    label: `recorded on-chain state, block ${head.number}`,
    network: o.network,
    networkLabel: NETWORK_LABEL[o.network],
    timeMode: TIME_MODE[o.network],
    timeNote: TIME_NOTE[TIME_MODE[o.network]],
    chainId,
    ledger,
    deployBlock: deployRc.blockNumber,
    block: head.number,
    blockTimestamp: head.timestamp,
    readingsFormat: "[t_unix, temp_milliC]; leaves and proofs are rebuilt with packages/core",
    events,
    pours: {
      "P-001": { ...compact(p1), inputs: in1, chain: await chainState(p1.pourId), evidence: { path: evidencePath, sha256: ev.sha256, package: ev.pkg } },
      "P-002": { ...compact(p2), inputs: inputs.pours["P-002"], chain: await chainState(p2.pourId), tamper: tamperResults },
    },
    mixes: inputs.mixes,
  };

  const write = (rel: string, text: string) => {
    const p = join(out, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    say(`wrote ${rel}`);
  };
  write(`deployments/${o.network}.json`, pretty(deployment));
  write(evidencePath, ev.text);
  write(`scenario/${o.network}-log.json`, pretty(log));
  write(`apps/web/public/snapshot/${o.network}.json`, pretty(snapshot));
  if (o.writeDataPours) {
    const dev = (doc: unknown) => JSON.stringify(doc, null, 1) + "\n";
    write("data/pours/P-001/batches.json", dev(p1));
    write("data/pours/P-002/batches.json", dev(p2));
    write("data/pours/P-002/tamper.json", dev(t2 satisfies TamperFile));
  }
  return { deployment, log, snapshot, evidence: ev };
}
