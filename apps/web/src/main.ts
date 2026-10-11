// PourProof web: /, /pour/:id, /verify/:id. Plain TypeScript, no framework; pages are rendered as HTML strings.
import "./style.css";
import { readConfig } from "./config.ts";
import { loadChain, loadInputs } from "./data.ts";
import { esc } from "./format.ts";
import { loadPour } from "./model.ts";
import { homeView } from "./views/home.ts";
import { page } from "./views/layout.ts";
import { pourView } from "./views/pour.ts";
import { verifyPage } from "./views/verify.ts";

const app = document.getElementById("app")!;
let seq = 0;

async function render(): Promise<void> {
  const my = ++seq;
  const { pathname, search } = location;
  app.innerHTML = page(search, `<p class="loading" data-testid="loading">Loading chain state and published files...</p>`, null);
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
      document.title = "PourProof";
      html = page(search, homeView(v, inputs, search), v);
    } else {
      html = page(search, `<h1>Not found</h1><p>No page at ${esc(pathname)}.</p>`, null);
    }
    if (my === seq) app.innerHTML = html;
  } catch (e) {
    if (my === seq) app.innerHTML = page(search, `<section class="banner bad" data-testid="error"><strong>Could not load this page.</strong><p>${esc(e instanceof Error ? e.message : e)}</p></section>`, null);
  }
}

document.addEventListener("click", (e) => {
  const a = (e.target as Element).closest?.("a[data-nav]") as HTMLAnchorElement | null;
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  history.pushState(null, "", a.getAttribute("href"));
  void render().then(() => window.scrollTo(0, 0));
});
window.addEventListener("popstate", () => void render());
void render();
