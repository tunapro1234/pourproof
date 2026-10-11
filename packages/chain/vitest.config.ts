import { defineConfig } from "vitest/config";

// Signature checks over 224 snapshot batches are pure JS; under nice 19 on a busy machine they can take far longer than 5 s.
export default defineConfig({ test: { testTimeout: 180_000, hookTimeout: 60_000 } });
