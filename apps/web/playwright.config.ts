// e2e smoke test against the production build served by `vite preview`. Run through npm run e2e (build + test);
// on the shared server via agir.sh with the browser lock (see README).
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, defineConfig } from "@playwright/test";

const PORT = Number(process.env.POURPROOF_E2E_PORT ?? 4317);

/** The Chromium this Playwright version ships with, else the newest headless shell already in the cache (no download). */
function executablePath(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (existsSync(chromium.executablePath())) return undefined;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  const shells = readdirSync(cache)
    .filter((d) => /^chromium_headless_shell-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    .map((d) => join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell"));
  return shells.find((p) => existsSync(p));
}

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, headless: true, launchOptions: { executablePath: executablePath() } },
  webServer: { command: `npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`, url: `http://127.0.0.1:${PORT}/`, reuseExistingServer: false, timeout: 60_000 },
});
