// The static snapshot site (dist-snapshot/, npm run e2e:snapshot): label in the served HTML before any script runs,
// one file per route, and live-mode parameters ignored. Skipped when the normal build (dist/) is served.
import { expect, test } from "@playwright/test";

const SNAPSHOT_SITE = process.env.POURPROOF_E2E_DIST === "dist-snapshot";

test.describe("static snapshot site", () => {
  test.skip(!SNAPSHOT_SITE, "serves dist/, not the static snapshot site");

  test("every route's HTML file carries the recorded-state label", async ({ request }) => {
    for (const path of ["/", "/pour/P-001/", "/verify/P-002/", "/404.html"]) {
      const html = await (await request.get(path)).text();
      expect(html, path).toMatch(/recorded on-chain state, block \d+/);
      expect(html, path).toContain("Testnet demo, no real claim");
    }
  });

  test("?mode=live is ignored: the page still shows the recorded snapshot and recorded AI", async ({ page }) => {
    await page.goto("/pour/P-001?mode=live&rpc=http://127.0.0.1:9");
    await expect(page.getByTestId("verify-status")).toHaveAttribute("data-ok", "true");
    await expect(page.getByTestId("state-label")).toContainText(/recorded on-chain state, block \d+/);
    await expect(page.getByTestId("ai-label").first()).toContainText("recorded response");
  });

  test("an unknown path still names the recorded state", async ({ page }) => {
    await page.goto("/no-such-page");
    await expect(page.locator("h1")).toHaveText("Not found");
    await expect(page.getByTestId("state-label")).toContainText(/recorded on-chain state, block \d+/);
  });
});
