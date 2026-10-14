import type { ChainView } from "../chain.ts";
import { link } from "../config.ts";
import { esc } from "../format.ts";
import { ATTRIBUTION, DEMO_CARD_TEXT, DEMO_CARD_TITLE } from "../labels.ts";

/** The bar on every screen: network, where the chain state comes from, how the clock was handled. */
export function sourceBar(v: ChainView): string {
  return `<div class="source-bar" data-testid="source-bar">
    <span class="pill net" data-testid="network-label">network: ${esc(v.networkLabel)}</span>
    <span class="pill ${v.source}" data-testid="state-label">${esc(v.sourceLabel)}</span>
    <span class="pill time" data-testid="time-label">${esc(v.timeMode === "backdated" ? "readings time-shifted into the past from the published dataset" : v.timeNote)}</span>
  </div>`;
}

export function demoCard(): string {
  return `<aside class="demo-card" data-testid="demo-card"><strong>${esc(DEMO_CARD_TITLE)}.</strong> ${esc(DEMO_CARD_TEXT)}</aside>`;
}

/** A page: header, then the hero (home page) so a visitor first reads what this is, then the source bar and the demo
 * card (on every screen), then the page itself. */
export function page(search: string, body: string, v: ChainView | null, hero = ""): string {
  return `<header class="top">
    <a href="${link("/", search)}" data-nav class="brand">PourProof</a>
    <span class="tag">a signed passport for every concrete pour</span>
  </header>
  ${hero}
  ${v ? sourceBar(v) : ""}
  ${demoCard()}
  <main>${body}</main>
  <footer>${esc(ATTRIBUTION)} Code: MIT. AI never approves anything; it proposes fields with their source and code checks them.</footer>`;
}

export const ok = (b: boolean): string => (b ? `<span class="yes">✓</span>` : `<span class="no">✗</span>`);
