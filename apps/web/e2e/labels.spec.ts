// Labels a judge reads: the curing curve named as the published class B25 dataset, the simulated-device label on every
// screen, no "first" or "DPP-ready" claim.
import { expect, test } from "@playwright/test";

const DEVICE = "simulated device · replayed from published dataset";

test("P-001 passport: the curve note under the chart and inside it", async ({ page }) => {
  await page.goto("/pour/P-001");
  await expect(page.getByTestId("verify-status")).toHaveAttribute("data-ok", "true");
  await expect(page.getByTestId("curve-note")).toHaveText("Curing curve: published dataset, class B25, not the delivered mix.");
  await expect(page.getByTestId("curve-note")).toBeVisible();
  await expect(page.getByTestId("curing-chart")).toContainText("curing curve: published dataset, class B25, not the delivered mix");
});

for (const path of ["/", "/pour/P-001", "/pour/P-002", "/verify/P-001"]) {
  test(`${path}: the simulated-device label is on screen; no "first" or "DPP-ready" claim`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByText(DEVICE).first()).toBeVisible();
    const text = (await page.locator("body").textContent()) ?? "";
    expect(text).not.toMatch(/DPP-ready|world'?s first/i);
  });
}
