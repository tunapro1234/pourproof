// End-to-end scenario on a real chain (local Anvil or Base Sepolia): deploy, roles, two pours, every device batch,
// strength approval, one saving claim and the rejected second claim, plus the P-002 tamper attempts. Rejected calls are
// sent as real transactions so the chain itself records the revert; the revert name comes from the same call simulated
// on the state just before it.
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
import { evidencePackage, type EvidenceDataset, type Mix } from "./evidence.ts";
import { pretty, sha256Hex } from "./json.ts";
import type { RoleName } from "./roles.ts";

export type NetworkName = "anvil" | "baseSepolia";

export const NETWORK_LABEL: Record<NetworkName, string> = { anvil: "local Anvil", baseSepolia: "Base Sepolia" };

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

  /** Sends one call. `expect` = the custom error it must revert with; the tx is still sent and mined. */
  const send = async (role: RoleName, fn: string, args: unknown[], pour: string | null, opt: { expect?: string; note?: string } = {}) => {
    const account = o.roles[role];
    const simulate = async (blockNumber?: bigint) => {
      try {
        await pub.simulateContract({ address: ledger, abi: abi as Abi, functionName: fn, args, account, blockNumber });
        return null;
      } catch (e) {
        const r = revertOf(e);
        if (!r) throw e;
        return r;
      }
    };
    // Calls meant to revert are simulated first, so a wrong expectation stops the run before anything is sent.
    const revert = opt.expect ? await simulate() : null;
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
    const s: Step = {
      step: steps.length,
      pour,
      role,
      account: addr(account),
      fn,
      args,
      txHash: hash,
      block: rc.blockNumber,
      timestamp: 0n,
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

  // ---- device replay for this ledger: the pour is placed in the past so every batch is already closed (FutureBatch)
  const now = (await pub.getBlock()).timestamp;
  const { pourStart, rule } = replayPourStart(Number(now), dataset.series.box1, dataset.series.ambient);
  const common = { dataset, pourStart, pourStartRule: rule, replayBlockTime: Number(now), chainId, ledger: ledger as Hex };
  const p1 = replay({ ...common, pourLabel: "P-001", seriesName: "box1", scenario: SCENARIO_TEXT["P-001"], key: k1 });
  const p2 = replay({ ...common, pourLabel: "P-002", seriesName: "ambient", scenario: SCENARIO_TEXT["P-002"], key: k2 });
  const t2 = tamperAttempts(p2, k1);
  say(`replayed devices for ${NETWORK_LABEL[o.network]}: pourStart ${pourStart} (${rule})`);

  const mixOf = (name: string) => {
    const m = inputs.mixes[name];
    if (!m) throw new Error(`mix ${name} not in inputs`);
    return m;
  };
  const appendAll = async (f: BatchesFile, batches: PublishedBatch[]) => {
    for (const b of batches) await send("relay", "appendBatch", [f.pourId, BigInt(b.counter), BigInt(b.fromTs), BigInt(b.toTs), b.root, b.r, b.s], f.pourLabel);
  };
  const createPour = async (label: string, f: BatchesFile) => {
    const p = inputs.pours[label];
    const mix = mixOf(p.delivered_mix);
    const [lo, hi] = mix.gwp_total_kg_per_m3;
    return send(
      "supplier",
      "createPour",
      [f.pourId, bytes32OfHex(docHash(p.ticket_doc)), bytes32OfHex(docHash(mix.epd_doc)), Math.round(p.volume_m3 * 1000), lo, hi, BigInt(f.pourStart)],
      label,
      { note: `ticketHash = sha256 of ${p.ticket_doc}, epdHash = sha256 of ${mix.epd_doc}` },
    );
  };
  const register = (f: BatchesFile, k: DeviceKey) => send("inspector", "registerDevice", [f.pourId, k.qx, k.qy, f.deviceKind], f.pourLabel);

  // ---- P-001: honest low-clinker pour
  const in1 = inputs.pours["P-001"];
  const base = mixOf(in1.baseline_mix!);
  await send("contractor", "declareBaseline", [p1.pourId, bytes32OfHex(docHash(base.epd_doc)), base.gwp_total_kg_per_m3[0], base.gwp_total_kg_per_m3[1]], "P-001", {
    note: `declared before the pour exists on chain; baselineMixHash = sha256 of ${base.epd_doc}`,
  });
  await createPour("P-001", p1);
  await register(p1, k1);
  await send("contractor", "acceptPour", [p1.pourId], "P-001");
  await appendAll(p1, p1.batches);
  say(`P-001: ${p1.batches.length} batches appended`);
  const ev = evidencePackage({
    pour: p1,
    dataset,
    network: o.network,
    baseline: base,
    delivered: mixOf(in1.delivered_mix),
    volume_m3: in1.volume_m3,
    strengthReference: in1.strength_reference,
  });
  const evidencePath = `scenario/${o.network}-evidence-P-001.json`;
  await send("inspector", "approveStrength", [p1.pourId, ev.sha256], "P-001", { note: `evidenceHash = sha256 of ${evidencePath}` });
  await send("supplier", "claimSaving", [p1.pourId], "P-001");
  await send("contractor", "claimSaving", [p1.pourId], "P-001", { expect: "AlreadyClaimed", note: "second claim on the same pour" });

  // ---- P-002: tamper case
  await createPour("P-002", p2);
  await register(p2, k2);
  await send("contractor", "acceptPour", [p2.pourId], "P-002");
  await appendAll(p2, p2.batches.slice(0, 1));
  const tamperResults: { id: string; description: string; expectRevert: string; step: number; txHash: Hash; block: bigint; revert: Revert | null }[] = [];
  for (const id of ["other_device_key", "skipped_batch"] as const) {
    const a = t2.attempts.find((x) => x.id === id)!;
    const b = a.batch;
    const s = await send("relay", "appendBatch", [p2.pourId, BigInt(b.counter), BigInt(b.fromTs), BigInt(b.toTs), b.root, b.r, b.s], "P-002", {
      expect: a.expectRevert,
      note: `tamper attempt ${a.id}: ${a.description}`,
    });
    tamperResults.push({ id: a.id, description: a.description, expectRevert: a.expectRevert, step: s.step, txHash: s.txHash, block: s.block, revert: s.revert });
  }
  await appendAll(p2, p2.batches.slice(1));
  say(`P-002: ${p2.batches.length} batches appended, tamper attempts rejected: ${tamperResults.map((t) => t.revert?.name).join(", ")}`);

  // ---- read the final state back from the chain
  const head = await pub.getBlock();
  const decoded = [];
  for (let from = deployRc.blockNumber; from <= head.number; from += 2000n) {
    const to = from + 1999n < head.number ? from + 1999n : head.number;
    decoded.push(...parseEventLogs({ abi, logs: await pub.getLogs({ address: ledger, fromBlock: from, toBlock: to }) }));
  }
  await fillTimes([...steps.map((x) => x.block), ...decoded.map((l) => l.blockNumber)]);
  for (const x of steps) x.timestamp = blockTime.get(x.block)!;
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
    pourStart,
    pourStartRule: rule,
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
