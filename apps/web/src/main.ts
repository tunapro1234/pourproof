// PourProof web: /, /pour/:id, /verify/:id. Plain TypeScript, no framework; pages are rendered as HTML strings.
import "./style.css";
import { readConfig } from "./config.ts";
import { loadBatches, loadChain, loadInputs } from "./data.ts";
import { esc } from "./format.ts";
import { HERO_POUR } from "./labels.ts";
import { loadPour } from "./model.ts";
import { tamperHref } from "./tamper.ts";
import { homeHero, homeView } from "./views/home.ts";
import { page } from "./views/layout.ts";
import { pourView } from "./views/pour.ts";
import { verifyPage } from "./views/verify.ts";

const app = document.getElementById("app")!;
let seq = 0;
/** path and query of the page on screen; a change of #hash alone does not render again */
let shown = "";
let shownPath = "";

async function render(): Promise<void> {
  const my = ++seq;
  const { pathname, search } = location;
  // Same page with another query (a tamper tried on the passport): keep the page on screen until the new one is ready.
  if (pathname !== shownPath) {
    app.innerHTML = page(search, `<p class="loading" data-testid="loading">Loading chain state and published files...</p>`, null);
  }
  try {
    const cfg = readConfig(search);
    let html: string;
    const pour = pathname.match(/^\/pour\/([\w-]+)\/?$/);
    const verify = pathname.match(/^\/verify\/([\w-]+)\/?$/);
    if (pour || verify) {
      const label = decodeURIComponent((pour ?? verify)![1]);
      const m = await loadPour(cfg, label, search);
      document.title = `${verify ? "Verify" : "Pour"} ${label} · PourProof`;
      html = page(search, pour ? pourView(m, search) : verifyPage(m, search), m.view);
    } else if (pathname === "/" || pathname === "/index.html") {
      const inputs = await loadInputs();
      const v = await loadChain(cfg, Object.keys(inputs.pours));
      const heroFile = await loadBatches(HERO_POUR).catch(() => null);
      document.title = "PourProof";
      html = page(search, homeView(v, inputs, search), v, homeHero(v, inputs, search, heroFile));
    } else {
      const v = cfg.mode === "snapshot" ? await loadChain(cfg, []).catch(() => null) : null;
      html = page(search, `<h1>Not found</h1><p>No page at ${esc(pathname)}.</p>`, v);
    }
    if (my === seq) app.innerHTML = html;
  } catch (e) {
    if (my === seq) app.innerHTML = page(search, `<section class="banner bad" data-testid="error"><strong>Could not load this page.</strong><p>${esc(e instanceof Error ? e.message : e)}</p></section>`, null);
  }
  if (my === seq) [shown, shownPath] = [`${pathname}${search}`, pathname];
}

/** Scrolls to the #hash target, or to the top. #try (the tamper card) scrolls to the verification banner right above
 * it, so the result and the card are on screen together. */
function scrollToHash(): void {
  const id = decodeURIComponent(location.hash.slice(1));
  const el = id ? document.getElementById(id) : null;
  if (!el) return window.scrollTo(0, 0);
  const banner = id === "try" ? document.querySelector('[data-testid="verify-status"]') : null;
  (banner ?? el).scrollIntoView({ block: "start" });
}

document.addEventListener("click", (e) => {
  const a = (e.target as Element).closest?.("a[data-nav]") as HTMLAnchorElement | null;
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  history.pushState(null, "", a.getAttribute("href"));
  void render().then(scrollToHash);
});

// Tamper card: typing a reading number points the change buttons at that reading; clearing it restores them.
document.addEventListener("input", (e) => {
  const input = (e.target as Element).closest?.("input[data-try-reading]") as HTMLInputElement | null;
  const card = input?.closest<HTMLElement>("[data-try]");
  if (!input || !card) return;
  const i = input.value.trim() === "" ? NaN : Number(input.value);
  const valid = Number.isInteger(i) && i >= 0 && i < Number(card.dataset.readings);
  for (const b of card.querySelectorAll<HTMLAnchorElement>("a[data-d]")) {
    b.dataset.orig ??= b.getAttribute("href") ?? "";
    b.setAttribute("href", valid ? tamperHref(card.dataset.base ?? location.pathname, `reading:${i}:${b.dataset.d}`) : b.dataset.orig);
  }
  const target = card.querySelector<HTMLElement>("[data-try-target]");
  if (target) {
    target.dataset.orig ??= target.textContent ?? "";
    target.textContent = valid ? `reading ${i}` : target.dataset.orig;
  }
});

window.addEventListener("popstate", () => {
  if (`${location.pathname}${location.search}` === shown) return scrollToHash();
  void render().then(scrollToHash);
});
void render().then(() => location.hash && scrollToHash());
