// "Fake a warm night": the visitor edits the curing record in their own browser and watches verification refuse it.
// No number is typed into this file; ranges are read from the page and compared.
import { expect, test, type Page } from "@playwright/test";

const MINUS = "\u2212";
const RANGE_KG = /(\d[\d,]*) to (\d[\d,]*) kg CO2e/;
const FORGED = /The edited copy would claim day \d+: (\d+\.\d) to (\d+\.\d) MPa, against (\d+\.\d) to (\d+\.\d) MPa from the signed readings\. It is refused below, so neither number is used\./;

/** The night the card opens on, as the card names it: "Night <n> (<lo> to <hi> °C) is the coldest night ...". */
async function coldNight(page: Page): Promise<string> {
  const note = page.getByTestId("try-cold-night");
  await expect(note).toContainText(/^Night \d+ \(\d+\.\d to \d+\.\d °C\) is the coldest night in the first \d+ days after the hydration peak \(night \d+, \d+\.\d to \d+\.\d °C\), so the card opens on it\.$/);
  const [, n, peak] = (await note.textContent())!.match(/^Night (\d+) .* \(night (\d+), /)!;
  expect(Number(n)).toBeGreaterThan(Number(peak));
  return n;
}

async function green(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId("verify-status")).toHaveAttribute("data-ok", "true");
}

test("(1) P-001 as signed: green, the card, the saving already claimed once by the supplier, the notes", async ({ page }) => {
  await green(page, "/pour/P-001");
  const card = page.getByTestId("try");
  await expect(card.locator("h2")).toHaveText("Fake a warm night");
  const n = await coldNight(page);
  await expect(card.getByTestId("try-night").filter({ hasText: new RegExp(`^${n}$`) })).toHaveAttribute("aria-current", "true");
  await expect(card.getByTestId("try-night").first()).not.toHaveAttribute("aria-current", "true");
  await expect(card.locator("[data-try-target]")).toContainText(new RegExp(`^night ${n}: \\d+ readings, .+ to .+, \\d+\\.\\d to \\d+\\.\\d °C as signed$`));
  const claimed = (await page.getByTestId("claim-status").textContent())!.match(RANGE_KG)!;
  const claimable = page.getByTestId("claimable-now");
  await expect(claimable).toContainText(`Saving this record supports: ${claimed[1]} to ${claimed[2]} kg CO2e, already claimed once by supplier. A second claim reverts on chain.`);
  await expect(page.getByTestId("forged-claim")).toHaveCount(0);
  await expect(page.getByTestId("calibration-note")).toHaveText(
    "Calibration: the dataset's class B25 concrete, not the delivered mix. A real supplier calibrates each mix first (ASTM C1074). Acceptance stays with the 28-day specimens.",
  );
  await expect(page.getByTestId("trust-note")).toContainText(/\(snapshot file, block \d+, sha256 [0-9a-f]{12}\)\. So this shows that one edited reading cannot match its signed root\. It does not show that the server is honest\./);
  await expect(page.getByTestId("trust-note")).toContainText(
    "Re-running the scenario yourself re-signs everything with your own keys: it checks the code, not this record. A run on a public testnet would let you check this record; it has not run yet.",
  );
  await expect(card.getByTestId("try-sources")).toContainText("Where the numbers come from: readings from the published dataset (class B25)");
  await expect(card.getByTestId("try-sources").getByRole("link", { name: "the two sample EPDs shown in the passport" })).toHaveAttribute("href", "#carbon");
});

test("(2) the cold night, +5 °C: red, the changed batches named, the forged claim beside its refusal, nothing claimable, no new request", async ({ page }) => {
  await green(page, "/pour/P-001");
  const n = await coldNight(page);
  const requests: string[] = [];
  page.on("request", (r) => {
    if (!r.url().endsWith("/favicon.ico")) requests.push(r.url());
  });
  const card = page.getByTestId("try");
  await card.getByRole("link", { name: "+5 °C", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/pour/P-001\\?tamper=night%3A${n}%3A5#try$`));
  const status = page.getByTestId("verify-status");
  await expect(status).toHaveAttribute("data-ok", "false");
  await expect(status).toContainText(new RegExp(`Tamper demo: night ${n}: `));
  await expect(status).toContainText(/Tamper demo: night \d+: \d+ readings from .+ to .+ \(batches \d+(, \d+)+\) were changed in this browser by \+5 °C before checking\./);
  await expect(status).toContainText(/Reading 2026-\d\d-\d\d \d\d:\d\d UTC\+3 does not match the signed root/);
  await expect(page.getByTestId("claimable-now")).toHaveText("Saving this record supports: none. The curing record does not verify.");
  const forged = page.getByTestId("forged-claim");
  await expect(forged).toContainText(FORGED);
  // a small edit: the claimed range moves up by a fraction of an MPa, and it is still caught
  const [, lo, hi, lo0, hi0] = (await forged.textContent())!.match(FORGED)!.map(Number);
  expect(hi).toBeGreaterThanOrEqual(hi0);
  expect(lo).toBeGreaterThanOrEqual(lo0);
  expect(hi + lo).toBeGreaterThan(hi0 + lo0);
  await expect(page.getByTestId("tamper-note")).toContainText("The recorded chain state did not change. Only your copy in this browser did; the claim already made used the untouched record.");
  await expect(page.getByTestId("strength")).toHaveCount(0);
  await expect(page.getByTestId("chart-changed")).toHaveCount(1);
  await expect(card.getByRole("link", { name: "+5 °C", exact: true })).toHaveAttribute("aria-current", "true");
  // the claim on chain is untouched
  await expect(page.getByTestId("claim-status")).toContainText("Already claimed by supplier");
  expect(requests).toEqual([]);
});

test("(3) Undo the change: green again", async ({ page }) => {
  await page.goto("/pour/P-001?tamper=night:1:5#try");
  await expect(page.getByTestId("verify-status")).toHaveAttribute("data-ok", "false");
  await page.getByTestId("tamper-note").getByRole("link", { name: "Undo the change" }).click();
  await expect(page.getByTestId("verify-status")).toHaveAttribute("data-ok", "true");
  await expect(page.getByTestId("forged-claim")).toHaveCount(0);
  await expect(page.getByTestId("claimable-now")).toContainText("already claimed once by supplier");
});

test("one reading by number, -1 °C: red, that reading named", async ({ page }) => {
  await green(page, "/pour/P-001");
  const card = page.getByTestId("try");
  await card.getByTestId("try-reading").fill("40");
  await expect(card.locator("[data-try-target]")).toHaveText("reading 40");
  await card.getByRole("link", { name: `${MINUS}1 °C`, exact: true }).click();
  await expect(page).toHaveURL(/tamper=reading%3A40%3A-1#try$/);
  const status = page.getByTestId("verify-status");
  await expect(status).toHaveAttribute("data-ok", "false");
  await expect(status).toContainText(/Tamper demo: reading 40 \(2026-\d\d-\d\d \d\d:\d\d UTC\+3\) was changed in this browser/);
  await expect(card.getByTestId("try-reading")).toHaveValue("40");
});

for (const [w, h] of [
  [1280, 800],
  [390, 844],
]) {
  test(`(5) ${w}x${h}: the hero is on the first screen and its button turns the passport red in one click`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/");
    const hero = page.getByTestId("hero");
    await expect(hero.locator("h1")).toHaveText("Pour P-001 left one signed curing record. Fake a warm night in it and see what happens.");
    await expect(hero).toContainText(/m³ of a leaner mix\. A simulated device replays [\d,]+ published curing readings, signs them in \d+ batches, and anchors each batch on a local test chain\. The supplier claimed the saving, \d[\d,]* to \d[\d,]* kg CO2e, once; the record is what that claim rests on\./);
    await expect(hero).toContainText("Who opens it: the site engineer before stripping formwork, the supplier to claim the saving once, the inspector when the 28-day result is in.");
    const button = page.getByTestId("hero-try");
    await expect(button).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("hero-open")).toBeVisible();
    await button.click();
    await expect(page).toHaveURL(/\/pour\/P-001\?tamper=night%3A\d+%3A5#try$/);
    const status = page.getByTestId("verify-status");
    await expect(status).toHaveAttribute("data-ok", "false");
    await expect(status).toBeInViewport();
    // the button edits the night the card opens on
    const n = new URL(page.url()).searchParams.get("tamper")!.split(":")[1];
    await page.goto("/pour/P-001");
    expect(await coldNight(page)).toBe(n);
  });
}

test("(6) 390x844: the passport with a changed night does not scroll sideways; the labels stay", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/pour/P-001?tamper=night:1:5");
  await expect(page.getByTestId("verify-status")).toHaveAttribute("data-ok", "false");
  await expect(page.getByTestId("forged-claim")).toBeVisible();
  const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll).toBeLessThanOrEqual(client);
  for (const id of ["demo-card", "source-bar", "device-label"]) await expect(page.getByTestId(id)).toBeVisible();
});

test("(7) P-002: the card, nothing claimable for the real reason, the flag band and the refused batches; no forged claim", async ({ page }) => {
  await green(page, "/pour/P-002");
  await expect(page.getByTestId("try")).toBeVisible();
  await expect(page.getByTestId("claimable-now")).toHaveText("Saving this record supports: none. The inspector has not approved this pour's curing record.");
  await expect(page.getByTestId("curing-flag")).toBeVisible();
  await expect(page.getByTestId("rejected-tx")).toHaveCount(3);
  await page.getByTestId("try").getByRole("link", { name: "+5 °C", exact: true }).click();
  await expect(page.getByTestId("verify-status")).toHaveAttribute("data-ok", "false");
  await expect(page.getByTestId("tamper-note")).toHaveText(/^The recorded chain state did not change\. Only your copy in this browser did\./);
  await expect(page.getByTestId("tamper-note")).not.toContainText("the claim already made");
  await expect(page.getByTestId("forged-claim")).toHaveCount(0);
  await expect(page.getByTestId("rejected-tx")).toHaveCount(3);
});
