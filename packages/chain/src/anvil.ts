// Starts a private local Anvil for one scenario run and stops it afterwards. The node starts at a fixed genesis time
// and every block advances the clock by 12 s, so the same run produces the same blocks, hashes and files.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { foundryBin } from "./foundry.ts";

export const ANVIL_GENESIS_TS = 1_791_763_200; // 2026-10-12T00:00:00Z
export const ANVIL_BLOCK_INTERVAL_S = 12;

export interface AnvilNode {
  url: string;
  stop: () => Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a && typeof a === "object" ? res(a.port) : rej(new Error("no port"))));
    });
  });
}

export async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

export async function startAnvil(chainId = 31337): Promise<AnvilNode> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(
    foundryBin("anvil"),
    ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId), "--timestamp", String(ANVIL_GENESIS_TS), "--accounts", "6", "--silent"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.once("error", (e) => (stderr += String(e)));
  child.stderr?.on("data", (d) => (stderr += String(d)));
  const exited = new Promise<void>((res) => child.once("exit", () => res()));
  const stop = async () => {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    await exited;
  };
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null || child.pid === undefined) throw new Error(`anvil exited (${child.exitCode}): ${stderr.trim()}`);
    try {
      await rpc(url, "eth_chainId");
      await rpc(url, "anvil_setBlockTimestampInterval", [ANVIL_BLOCK_INTERVAL_S]);
      return { url, stop };
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await stop();
  throw new Error(`anvil did not answer on ${url}: ${stderr.trim()}`);
}
