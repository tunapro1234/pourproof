import { defineConfig } from "vitest/config";

// Unit tests only (test/); e2e/ is Playwright. Signature checks and the live Anvil run are slow under nice 19.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], environment: "node", testTimeout: 180_000, hookTimeout: 180_000 } });
