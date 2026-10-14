// Serves the published repo files the chain commits to under /published/<repo path> (dev and preview) and copies
// them into the build, so the static site verifies against exactly the committed files:
//   data/pours/*/ (device batches)   data/scenario/inputs.json   data/sample-docs/*.png|pdf
//   scenario/*-evidence-*.json       deployments/*.json
// `vite build --mode snapshot` (npm run build:snapshot) writes the static site to dist-snapshot/ (scripts/static-site.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { assertRecordedAi, findSecrets, injectNotice, readSnapshots, routeFiles, snapshotSha256, staticNotice } from "./scripts/static-site.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
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

/** Static snapshot site: label in every HTML file, one HTML file per route, recorded AI only, no secret-like strings. */
function staticSite(outDir: string): Plugin {
  const snaps = readSnapshots(join(HERE, "public/snapshot"));
  return {
    name: "pourproof-static-site",
    apply: "build",
    buildStart() {
      assertRecordedAi(JSON.parse(readFileSync(join(HERE, "public/ai/outputs.json"), "utf8")));
    },
    transformIndexHtml: (html) => injectNotice(html, staticNotice(snaps)),
    closeBundle() {
      const index = readFileSync(join(outDir, "index.html"));
      for (const f of routeFiles(snaps.flatMap((s) => s.pours))) {
        mkdirSync(dirname(join(outDir, f)), { recursive: true });
        writeFileSync(join(outDir, f), index);
      }
      const hits = findSecrets(outDir);
      if (hits.length) throw new Error(`secret-like strings in ${outDir}:\n${hits.join("\n")}`);
    },
  };
}

export default defineConfig(({ mode }) => {
  const snapshotSite = mode === "snapshot";
  const outDir = snapshotSite ? "dist-snapshot" : "dist";
  return {
    base: "/",
    plugins: [published(), ...(snapshotSite ? [staticSite(join(HERE, outDir))] : [])],
    define: { __POURPROOF_STATIC__: JSON.stringify(snapshotSite), __POURPROOF_SNAPSHOT_SHA256__: JSON.stringify(snapshotSha256(join(HERE, "public/snapshot"))) },
    server: { port: 5173, strictPort: false, fs: { allow: [REPO] } },
    preview: { port: 4317, strictPort: true },
    build: { outDir, emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 1200 },
  };
});
