// Smoke test of the built site in snapshot mode: passport green, tamper red, second claim refused.
import { expect, test } from "@playwright/test";

test("passport P-001: curing record verifies in the browser, labels are on screen", async ({ page }) => {
  await page.goto("/pour/P-001");
  const status = page.getByTestId("verify-status");
  await expect(status).toHaveAttribute("data-ok", "true");
  await expect(status).toContainText("Curing record verified in this browser: 112 batches, 1344 readings");
  await expect(page.getByTestId("device-label")).toContainText("simulated device · replayed from published dataset (Mendeley nmr8pjx8d8, CC BY 4.0)");
  await expect(page.getByTestId("network-label")).toContainText("local Anvil");
  await expect(page.getByTestId("roles-note")).toBeVisible();
  await expect(page.getByTestId("roles-note")).toHaveText("Roles are test accounts we run (Anvil's default dev accounts, whose keys are public).");
  await expect(page.getByTestId("state-label")).toContainText(/recorded on-chain state, block \d+/);
  await expect(page.getByTestId("demo-card")).toContainText("Testnet demo, no real claim");
  await expect(page.getByTestId("curing-chart")).toContainText("replayed from published dataset");
  await expect(page.getByTestId("strength")).toContainText("estimated range, inspector decides");
  await expect(page.getByTestId("strength")).toContainText(/\d+\.\d to \d+\.\d MPa/);
  // the headline line repeats the day 7 row of the table
  const day7 = (await page.getByTestId("strength").locator("tr", { hasText: "day 7" }).locator("strong").textContent())!;
  await expect(page.getByTestId("strength-line")).toHaveText(
    `Estimated strength at day 7: ${day7}, from a curve fitted on the dataset's own B25 cylinders, not the delivered mix.`,
  );
  await expect(page.getByTestId("saving")).toContainText("512 to 840 kg CO2e");
  await expect(page.getByTestId("qr").locator("svg")).toBeVisible();
  await expect(page.getByTestId("ai-label").first()).toContainText("recorded response");
  await expect(page.getByTestId("docs")).not.toContainText("✗");
  await expect(page.getByTestId("docs").locator(".yes")).toHaveCount(4);
});

test("tamper: one changed reading turns verification red", async ({ page }) => {
  await page.goto("/verify/P-001?tamper=reading:40");
  const status = page.getByTestId("verify-status");
  await expect(status).toHaveAttribute("data-ok", "false");
  await expect(status).toContainText(/Reading 2026-09-1\d \d\d:\d\d UTC\+3 does not match the signed root/);
  await expect(page.locator("tr.bad-row")).toHaveCount(1);
  await expect(page.getByTestId("batch-row")).toHaveCount(112);

  await page.goto("/pour/P-001?tamper=reading:40");
  await expect(page.getByTestId("verify-status")).toHaveAttribute("data-ok", "false");
  await expect(page.getByTestId("strength")).toHaveCount(0);
});

test("saving claim: claimed once by the supplier, the second claim was refused", async ({ page }) => {
  await page.goto("/pour/P-001");
  const claim = page.getByTestId("claim-status");
  await expect(claim).toContainText("Already claimed by supplier");
  await expect(claim.getByTestId("rejected-claim")).toContainText("contractor tried claimSaving: rejected, AlreadyClaimed");
});

test("list page links to both pours; P-002 verifies but is flagged and not claimable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("pour-row-P-001")).toContainText("Already claimed by supplier");
  await page.getByTestId("pour-row-P-002").getByRole("link", { name: "P-002" }).click();
  await expect(page).toHaveURL(/\/pour\/P-002$/);
  await expect(page.getByTestId("verify-status")).toHaveAttribute("data-ok", "true");
  await expect(page.locator("body")).toContainText("no hydration signature");
  await expect(page.getByTestId("ai-explanation")).toContainText("recorded response");
  await expect(page.getByTestId("claim-status")).toContainText("Not claimable: the inspector has not approved this pour's curing record");
  await expect(page.locator("body")).not.toContainText("no baseline");
});
