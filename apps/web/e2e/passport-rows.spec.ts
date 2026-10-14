// Embodied CO2 card rows: the inventory beside the saving, the two cement parts, the range note, the scope; the
// one-claim note on the claim card. Numbers are read from the page and checked against each other.
import { expect, test } from "@playwright/test";

const num = (s: string) => Number(s.replace(/,/g, ""));

test("P-001: inventory, saving and its two cement parts, range note, scope, one-claim note", async ({ page }) => {
  await page.goto("/pour/P-001");
  await expect(page.getByTestId("verify-status")).toHaveAttribute("data-ok", "true");
  const card = page.getByTestId("carbon");
  await expect(card.getByTestId("inventory")).toContainText(/^Inventory, delivered mix: [\d,]+ to [\d,]+ kg CO2e \(absolute, A1-A3, GWP-total\)\. This is the pour's own footprint; the saving below is an avoided-emissions claim and sits outside the inventory\./);
  const [, lo, hi] = (await card.getByTestId("saving").textContent())!.match(/([\d,]+) to ([\d,]+) kg CO2e/)!;

  const split = card.getByTestId("saving-split");
  await expect(split).toBeVisible();
  const text = (await split.textContent())!.replace(/\s+/g, " ");
  const [, qa] = text.match(/Less cement: about \d+ kg CO2e\/m³ \((\d[\d,]*) kg for \d+ m³\), from \d+ vs \d+ kg\/m³ cement\. The strength record backs this part\./)!;
  const [, ta] = text.match(/Cement type: about \d+ kg CO2e\/m³ \((\d[\d,]*) kg\), from the two cement EPDs\. The supplier's EPD declares this part; a curing record cannot prove it\./)!;
  const [, sum] = text.match(/Cement difference alone: about (\d[\d,]*) kg for \d+ m³\./)!;
  expect(num(qa)).toBeGreaterThan(0);
  expect(num(ta)).toBeGreaterThan(0);
  expect(Math.abs(num(qa) + num(ta) - num(sum))).toBeLessThanOrEqual(10);
  expect(num(sum)).toBeGreaterThan(num(lo));
  expect(num(sum)).toBeLessThan(num(hi));

  await expect(card.getByTestId("range-note")).toHaveText(`The ${lo} to ${hi} kg range comes from the sample mixes' other constituents counted on both sides. It is not an error bar.`);
  await expect(card.getByTestId("scope")).toHaveText(
    "Scope: A1-A3, GWP-total. Cement factors from a US-PCR EPD (ISO 21930, NSF PCR v3.2, not EN 15804) that includes transport to the US market.",
  );
  await expect(card.getByTestId("baseline-cap")).toHaveText("Baseline cap against a regional benchmark: not yet. The contractor's declared baseline is used as is.");
  await expect(page.getByTestId("one-claim")).toHaveText(
    "Reduction claim recorded once, by the supplier. If it is ever sold as a certificate, the delivered mix is reported at baseline intensity.",
  );
  await expect(page.getByTestId("mix")).toContainText("C30/37 (assumed strength class, sample)");
});

test("P-002: inventory and scope, no split, no range note, no one-claim note", async ({ page }) => {
  await page.goto("/pour/P-002");
  await expect(page.getByTestId("verify-status")).toHaveAttribute("data-ok", "true");
  const card = page.getByTestId("carbon");
  await expect(card.getByTestId("inventory")).toBeVisible();
  await expect(card.getByTestId("scope")).toBeVisible();
  for (const id of ["saving-split", "range-note", "baseline-cap"]) await expect(card.getByTestId(id)).toHaveCount(0);
  await expect(page.getByTestId("one-claim")).toHaveCount(0);
});
