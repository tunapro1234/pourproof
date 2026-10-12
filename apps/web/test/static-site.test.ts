// The static snapshot site (npm run build:snapshot): build-time helpers in scripts/static-site.ts and the app's
// snapshot-only config. The build itself is checked by the project's acceptance script and the e2e run on dist-snapshot.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.ts";
import { assertRecordedAi, findSecrets, injectNotice, readSnapshots, routeFiles, staticNotice } from "../scripts/static-site.ts";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const snaps = readSnapshots(join(WEB, "public/snapshot"));

describe("static snapshot site", () => {
  it("reads the label and block from each recorded snapshot", () => {
    const anvil = snaps.find((s) => s.network === "anvil")!;
    expect(anvil.label).toBe(`recorded on-chain state, block ${anvil.block}`);
    expect(anvil.pours).toEqual(["P-001", "P-002"]);
  });

  it("writes the label into index.html before any script runs, also for readers without JavaScript", () => {
    const html = readFileSync(join(WEB, "index.html"), "utf8");
    const out = injectNotice(html, staticNotice(snaps));
    const label = snaps[0].label;
    expect(out.match(new RegExp(label, "g"))).toHaveLength(2);
    expect(out).toContain(`<div id="app"><p class="loading" data-testid="static-label">Static site: local Anvil: ${label}.`);
    expect(out).toContain("Testnet demo, no real claim");
    expect(() => staticNotice([])).toThrow(/no recorded snapshot/);
    expect(() => injectNotice("<body></body>", "x")).toThrow(/no <div id="app">/);
  });

  it("has an HTML file for every page so deep links work without a rewrite rule", () => {
    expect(routeFiles(["P-002", "P-001", "P-001"])).toEqual([
      "pour/P-001/index.html",
      "verify/P-001/index.html",
      "pour/P-002/index.html",
      "verify/P-002/index.html",
      "404.html",
    ]);
    expect(() => routeFiles(["../x"])).toThrow(/not usable in a path/);
  });

  it("accepts the committed AI outputs (all recorded) and refuses a live one", () => {
    const ai = JSON.parse(readFileSync(join(WEB, "public/ai/outputs.json"), "utf8"));
    expect(() => assertRecordedAi(ai)).not.toThrow();
    ai.pours["P-001"].ticket.mode = "live";
    expect(() => assertRecordedAi(ai)).toThrow(/recorded responses only/);
  });

  it("finds secret-like strings in built files", () => {
    const dir = mkdtempSync(join(tmpdir(), "pourproof-site-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<p>recorded on-chain state, block 1</p>");
    expect(findSecrets(dir)).toEqual([]);
    writeFileSync(join(dir, "assets/a.js"), `const k = "${"sk-"}ant-api03-xxxxxxxx";`);
    writeFileSync(join(dir, "b.json"), `{"private_key": "${"ab".repeat(32)}"}`);
    expect(findSecrets(dir)).toEqual(["assets/a.js: Anthropic API key", "b.json: private key field"]);
  });

  it("the static build shows snapshots only: ?mode=live, ?rpc and ?ledger are ignored", () => {
    const q = "?mode=live&rpc=http://example.invalid&ledger=0x0000000000000000000000000000000000000001";
    expect(readConfig(q, true)).toEqual({ mode: "snapshot", network: "anvil", rpcUrl: "http://127.0.0.1:8545", ledger: null });
    expect(readConfig(q, false).mode).toBe("live");
    expect(readConfig("?network=baseSepolia", true).network).toBe("baseSepolia");
    expect(() => readConfig("?network=mainnet", true)).toThrow(/unknown network/);
  });
});
