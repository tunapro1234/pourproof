import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { snapshotSha256 } from "./scripts/static-site.ts";

// Unit tests only (test/); e2e/ is Playwright. Signature checks and the live Anvil run are slow under nice 19.
// The snapshot sha256 is defined as in vite.config.ts, so view tests see the trust note the build shows.
const HERE = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  define: { __POURPROOF_SNAPSHOT_SHA256__: JSON.stringify(snapshotSha256(join(HERE, "public/snapshot"))) },
  test: { include: ["test/**/*.test.ts"], environment: "node", testTimeout: 180_000, hookTimeout: 180_000 },
});
