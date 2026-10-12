// The tamper case says what it is above the fold, and the pages fit a phone screen (390 px) without sideways scrolling.
import { expect, test } from "@playwright/test";

test("P-002: amber curing-flag band right under the green verification banner, inside the first screen", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/pour/P-002");
  await expect(page.getByTestId("verify-status")).toHaveAttribute("data-ok", "true");
  const flag = page.getByTestId("curing-flag");
  await expect(flag).toBeVisible();
  await expect(flag).toContainText("Signatures are valid, but this record does not look like curing concrete: no hydration heat rise in the first 24 h (no_hydration_signature).");
  await expect(flag).toContainText("No strength approval, no saving claim.");
  const box = (await flag.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(900);
  // the refused tamper attempts are red rows in the roles and signatures table
  const rejected = page.getByTestId("rejected-tx");
  await expect(rejected).toHaveCount(2);
  await expect(rejected.nth(0)).toContainText("appendBatch rejected on chain: BadSignature");
  await expect(rejected.nth(1)).toContainText("appendBatch rejected on chain: CounterGap");
});

test("P-001 has no curing-flag band", async ({ page }) => {
  await page.goto("/pour/P-001");
  await expect(page.getByTestId("verify-status")).toHaveAttribute("data-ok", "true");
  await expect(page.getByTestId("curing-flag")).toHaveCount(0);
});

for (const path of ["/pour/P-001", "/verify/P-001", "/pour/P-002", "/"]) {
  test(`390x844: ${path} does not scroll sideways; wide tables scroll inside their box`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    await expect(page.getByTestId("loading")).toHaveCount(0);
    await expect(page.locator("table").first()).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
    const unwrapped = await page.evaluate(() => [...document.querySelectorAll("table")].filter((t) => !t.parentElement?.classList.contains("table-wrap")).length);
    expect(unwrapped).toBe(0);
  });
}
