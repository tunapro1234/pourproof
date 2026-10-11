// The hand-written ABI must match what forge compiled, item by item.
import { describe, expect, it } from "vitest";
import { formatAbiItem } from "viem/utils";
import type { Abi, AbiFunction, AbiParameter } from "viem";
import { loadLedgerArtifact } from "@pourproof/chain";
import { LEDGER_ABI } from "../src/abi.ts";

describe("hand-written ledger ABI", () => {
  it("every event, function and error exists in contracts/out with the same signature and outputs", () => {
    const { abi } = loadLedgerArtifact();
    type Item = Extract<Abi[number], { type: "event" | "function" | "error" }>;
    const sig = (x: Item) =>
      `${x.type} ${formatAbiItem(x)}${x.type === "function" ? ` -> ${formatAbiItem({ ...x, name: "out", inputs: x.outputs } as AbiFunction)}` : ""}${x.type === "event" ? ` ${x.inputs.map((i: AbiParameter & { indexed?: boolean }) => (i.indexed ? 1 : 0)).join("")}` : ""}`;
    const compiled = new Set(abi.filter((x) => x.type === "event" || x.type === "function" || x.type === "error").map((x) => sig(x as Item)));
    for (const item of LEDGER_ABI) {
      if (item.type === "event" || item.type === "function" || item.type === "error") expect(compiled, sig(item as Item)).toContain(sig(item as Item));
    }
  });
});
