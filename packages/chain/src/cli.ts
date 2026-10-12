// PourProof chain CLI.
//   node src/cli.ts scenario --network anvil|baseSepolia [--rpc <url>]
//   node src/cli.ts deploy   --network anvil|baseSepolia [--rpc <url>]
//   node src/cli.ts roles-keygen [--force]
//   node src/cli.ts passport --network anvil|baseSepolia [--pour P-001]   (after scenario: W3C VC 2.0 signed by the inspector)
// anvil: starts a private local Anvil (fixed genesis time, 12 s per block) unless --rpc points at a running node, and
//        stops it at the end. Role accounts are the node's unlocked dev accounts 0..5.
// baseSepolia: role keys from $POURPROOF_SECRETS/roles.json, RPC https://sepolia.base.org (or BASE_SEPOLIA_RPC).
//        Not enough test ETH -> a clear error before the first transaction; there is no fallback to Anvil.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, http, type Account, type Address, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil, baseSepolia } from "viem/chains";
import { REPO_ROOT } from "@pourproof/device";
import { rpc, startAnvil, type AnvilNode } from "./anvil.ts";
import { loadLedgerArtifact } from "./artifacts.ts";
import { pretty } from "./json.ts";
import { exportPassport } from "./passport.ts";
import { ROLE_NAMES, loadRoleKeys, rolesKeygen, type RoleName } from "./roles.ts";
import { NETWORK_LABEL, checkBalances, runScenario, type NetworkName } from "./scenario.ts";

const [cmd, ...args] = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

interface Net {
  network: NetworkName;
  chain: Chain;
  rpcUrl: string;
  roles: Record<RoleName, Account | Address>;
  pollingInterval: number;
  node: AnvilNode | null;
}

async function connect(): Promise<Net> {
  const network = opt("--network") as NetworkName | undefined;
  if (network === "anvil") {
    const node = opt("--rpc") ? null : await startAnvil(anvil.id);
    const rpcUrl = opt("--rpc") ?? node!.url;
    const accts = await rpc<Address[]>(rpcUrl, "eth_accounts");
    if (accts.length < ROLE_NAMES.length) throw new Error(`anvil has ${accts.length} unlocked accounts, need ${ROLE_NAMES.length}`);
    const roles = Object.fromEntries(ROLE_NAMES.map((r, i) => [r, accts[i]])) as Record<RoleName, Address>;
    return { network, chain: anvil, rpcUrl, roles, pollingInterval: 20, node };
  }
  if (network === "baseSepolia") {
    const keys = loadRoleKeys();
    const roles = Object.fromEntries(ROLE_NAMES.map((r) => [r, privateKeyToAccount(keys[r])])) as Record<RoleName, Account>;
    const rpcUrl = opt("--rpc") ?? process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
    return { network, chain: baseSepolia, rpcUrl, roles, pollingInterval: 1000, node: null };
  }
  throw new Error("--network anvil|baseSepolia is required");
}

async function main() {
  if (cmd === "roles-keygen") {
    const { path, addresses } = rolesKeygen({ force: args.includes("--force") });
    console.log(`role keys written to ${path} (mode 600). Fund these Base Sepolia addresses:`);
    for (const [r, a] of Object.entries(addresses)) console.log(`  ${r.padEnd(10)} ${a}`);
    return;
  }
  if (cmd === "passport") {
    const network = opt("--network") as NetworkName | undefined;
    if (network !== "anvil" && network !== "baseSepolia") throw new Error("--network anvil|baseSepolia is required");
    const { path, vc } = await exportPassport(network, opt("--pour") ?? "P-001");
    console.log(`wrote ${path}: ${vc.id}, issuer ${vc.issuer}, verified`);
    return;
  }
  if (cmd !== "scenario" && cmd !== "deploy") {
    console.error("usage: node src/cli.ts scenario|deploy|passport --network anvil|baseSepolia [--rpc url] | roles-keygen [--force]");
    process.exit(2);
  }
  const net = await connect();
  try {
    if (cmd === "scenario") {
      await runScenario({ ...net, writeDataPours: net.network === "anvil" && !opt("--rpc") });
      return;
    }
    const pub = createPublicClient({ chain: net.chain, transport: http(net.rpcUrl), pollingInterval: net.pollingInterval });
    if (net.network !== "anvil") await checkBalances(pub as never, { admin: net.roles.admin } as never, net.network);
    const { abi, bytecode } = loadLedgerArtifact();
    const wallet = createWalletClient({ chain: net.chain, transport: http(net.rpcUrl) });
    const hash = await wallet.deployContract({ abi, bytecode, args: [typeof net.roles.admin === "string" ? net.roles.admin : net.roles.admin.address], account: net.roles.admin, chain: net.chain });
    const rc = await pub.waitForTransactionReceipt({ hash });
    const doc = { network: net.network, networkLabel: NETWORK_LABEL[net.network], chainId: net.chain.id, ledger: { address: rc.contractAddress, txHash: hash, block: rc.blockNumber }, note: "deploy only; roles not granted. `scenario` deploys its own ledger." };
    const p = join(REPO_ROOT, "deployments", `${net.network}-deploy-only.json`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, pretty(doc));
    console.log(`deployed ${rc.contractAddress} on ${NETWORK_LABEL[net.network]}; wrote ${p}`);
    if (net.node) console.log("note: the local Anvil started for this command is stopped now, so this deployment is gone; use --rpc for a running node");
  } finally {
    await net.node?.stop();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
