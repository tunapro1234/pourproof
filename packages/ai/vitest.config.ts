import { defineConfig } from "vitest/config";

// pdftotext and the dataset maths run in child processes and pure JS; under nice 19 on a busy machine they can be slow.
export default defineConfig({ test: { testTimeout: 180_000, hookTimeout: 60_000 } });
