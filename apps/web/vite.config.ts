// Serves the published repo files the chain commits to under /published/<repo path> (dev and preview) and copies
// them into the build, so the static site verifies against exactly the committed files:
//   data/pours/*/ (device batches)   data/scenario/inputs.json   data/sample-docs/*.png|pdf
//   scenario/*-evidence-*.json       deployments/*.json
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLISHED: { dir: string; match: RegExp }[] = [
  { dir: "data/pours", match: /^[\w-]+\/(batches|tamper)\.json$/ },
  { dir: "data/scenario", match: /^inputs\.json$/ },
  { dir: "data/sample-docs", match: /^[\w-]+\.(png|pdf)$/ },
  { dir: "scenario", match: /^[\w-]+-evidence-[\w-]+\.json$/ },
  { dir: "deployments", match: /^[\w-]+\.json$/ },
];
const TYPES: Record<string, string> = { ".json": "application/json", ".png": "image/png", ".pdf": "application/pdf" };

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
}

/** repo-relative paths of every published file */
export function publishedFiles(): string[] {
  return PUBLISHED.flatMap(({ dir, match }) => walk(join(REPO, dir)).map((f) => relative(join(REPO, dir), f)).filter((r) => match.test(r)).map((r) => `${dir}/${r}`));
}

function isPublished(rel: string): boolean {
  return PUBLISHED.some(({ dir, match }) => rel.startsWith(`${dir}/`) && match.test(rel.slice(dir.length + 1)));
}

function published(): Plugin {
  const serve = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = decodeURIComponent((req.url ?? "").split("?")[0]);
    if (!path.startsWith("/published/")) return next();
    const rel = path.slice("/published/".length);
    if (rel.includes("..") || !isPublished(rel) || !existsSync(join(REPO, rel))) {
      res.statusCode = 404;
      return res.end("not published");
    }
    res.setHeader("content-type", TYPES[extname(rel)] ?? "application/octet-stream");
    res.end(readFileSync(join(REPO, rel)));
  };
  return {
    name: "pourproof-published",
    configureServer: (s) => void s.middlewares.use(serve),
    configurePreviewServer: (s) => void s.middlewares.use(serve),
    generateBundle() {
      for (const rel of publishedFiles()) this.emitFile({ type: "asset", fileName: `published/${rel}`, source: readFileSync(join(REPO, rel)) });
    },
  };
}

export default defineConfig({
  plugins: [published()],
  server: { port: 5173, strictPort: false, fs: { allow: [REPO] } },
  preview: { port: 4317, strictPort: true },
  build: { outDir: "dist", target: "es2022", chunkSizeWarningLimit: 1200 },
});
