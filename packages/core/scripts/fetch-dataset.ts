// Downloads the Mendeley dataset nmr8pjx8d8 (v1, CC BY 4.0), parses the "Data" sheet and writes
// data/dataset/mendeley-nmr8pjx8d8.json. The xlsx itself stays outside the repo (cache dir).
//   node scripts/fetch-dataset.ts [--cache <dir>] [--out <file>] [--offline]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

const API = "https://data.mendeley.com/public-api/datasets/nmr8pjx8d8";
const DOI = "10.17632/nmr8pjx8d8.1";
const ATTRIBUTION =
  "Utepov et al., Complex Maturity Method for Estimating the Concrete Strength Based on Curing Temperature, " +
  "Ambient Temperature and Relative Humidity, Applied Sciences 11(16):7712, 2021; dataset doi 10.17632/nmr8pjx8d8.1, CC BY 4.0";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const cacheDir = resolve(opt("--cache", process.env.POURPROOF_CACHE ?? join(homedir(), ".cache", "pourproof")));
const outFile = resolve(opt("--out", join(here, "..", "..", "..", "data", "dataset", "mendeley-nmr8pjx8d8.json")));
const offline = args.includes("--offline");

interface FileMeta {
  filename: string;
  content_details: { download_url: string; sha256_hash: string };
}

async function download(): Promise<{ path: string; sha256: string; datasetVersion: number | null }> {
  const xlsxPath = join(cacheDir, "Data.xlsx");
  if (offline) {
    if (!existsSync(xlsxPath)) throw new Error(`--offline but ${xlsxPath} is missing`);
    return { path: xlsxPath, sha256: sha256(readFileSync(xlsxPath)), datasetVersion: null };
  }
  const meta = (await (await fetch(API)).json()) as { version?: number; files: FileMeta[] };
  const f = meta.files.find((x) => x.filename === "Data.xlsx");
  if (!f) throw new Error("Data.xlsx not listed in dataset metadata");
  const want = f.content_details.sha256_hash;
  if (!(existsSync(xlsxPath) && sha256(readFileSync(xlsxPath)) === want)) {
    const res = await fetch(f.content_details.download_url);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = sha256(buf);
    if (got !== want) throw new Error(`sha256 mismatch: got ${got}, expected ${want}`);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(xlsxPath, buf);
  }
  return { path: xlsxPath, sha256: want, datasetVersion: meta.version ?? null };
}

function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

type Cell = string | number | null;
const norm = (c: Cell) => (typeof c === "string" ? c.replace(/\s+/g, " ").trim().toLowerCase() : "");
const num = (c: Cell) => (typeof c === "number" && Number.isFinite(c) ? c : null);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** First column in header rows (0-based indices) whose label starts with `label`. */
function findCol(rows: Cell[][], headerRows: number[], label: string, from = 0): number {
  const want = label.toLowerCase();
  for (const r of headerRows) {
    const row = rows[r] ?? [];
    for (let c = from; c < row.length; c++) if (norm(row[c]).startsWith(want)) return c;
  }
  throw new Error(`header '${label}' not found in rows ${headerRows.map((r) => r + 1).join(",")}`);
}

function parse(path: string) {
  const wb = XLSX.read(readFileSync(path), { type: "buffer" });
  const ws = wb.Sheets["Data"];
  if (!ws) throw new Error("sheet 'Data' not found");
  const rows = XLSX.utils.sheet_to_json<Cell[]>(ws, { header: 1, raw: true, defval: null, blankrows: true });

  // Headers live in sheet rows 1-4. Row 4 names the sensors, row 3 the other columns.
  const col = {
    age: findCol(rows, [2], "age, day"),
    cyl1: findCol(rows, [3], "cylinder 1"),
    cyl2: findCol(rows, [3], "cylinder 2"),
    box1: findCol(rows, [3], "box 1"),
    box2: findCol(rows, [3], "box 2"),
    rh: findCol(rows, [2], "relative humidity"),
    ambient: findCol(rows, [2], "ambient temperature"),
    matCyl: findCol(rows, [2], "maturity in cylynders"),
    matBox: findCol(rows, [2], "maturity in boxes"),
  };
  const testBlock = findCol(rows, [0], "results of stregnth tests");
  const tcol = {
    age: findCol(rows, [0], "age, day", col.age + 1),
    cyl: findCol(rows, [2], "cylynders", testBlock),
    cube: findCol(rows, [2], "cubes", testBlock),
    box1: findCol(rows, [2], "box 1", testBlock),
    box2: findCol(rows, [2], "box 2", testBlock),
  };
  const methodRow = rows[1] ?? [];
  // Row 2 names the test standard; a merged cell covers both boxes, so walk left to the label.
  const standardAt = (c: number) => {
    for (let k = c; k >= testBlock; k--) if (typeof methodRow[k] === "string") return String(methodRow[k]);
    return "";
  };
  const firstData = rows.findIndex((r, i) => i > 3 && num(r[col.age]) !== null);
  if (firstData < 0) throw new Error("no data rows");

  const series = { box1: [], box2: [], cyl1: [], cyl2: [], ambient: [], rh: [] } as Record<string, { t_h: number; temp_c?: number; rh_pct?: number }[]>;
  const authors_maturity: { t_h: number; cylinders_c_day: number; boxes_c_day: number }[] = [];
  for (let i = firstData; i < rows.length; i++) {
    const r = rows[i];
    const age = num(r[col.age]);
    if (age === null) continue;
    const t_h = r3(age * 24);
    for (const k of ["box1", "box2", "cyl1", "cyl2", "ambient"] as const) {
      const v = num(r[col[k]]);
      if (v !== null) series[k].push({ t_h, temp_c: v });
    }
    const rh = num(r[col.rh]);
    if (rh !== null) series.rh.push({ t_h, rh_pct: rh });
    const mc = num(r[col.matCyl]);
    const mb = num(r[col.matBox]);
    if (mc !== null && mb !== null) authors_maturity.push({ t_h, cylinders_c_day: mc, boxes_c_day: mb });
  }

  const specimens = [
    { key: "cyl", specimen: "cylinder_15x15cm", method: "lab compression", standard: standardAt(tcol.cyl) },
    { key: "cube", specimen: "cube_10cm", method: "lab compression", standard: standardAt(tcol.cube) },
    { key: "box1", specimen: "box1_50cm", method: "nondestructive (rebound)", standard: standardAt(tcol.box1) },
    { key: "box2", specimen: "box2_50cm", method: "nondestructive (rebound)", standard: standardAt(tcol.box2) },
  ] as const;
  const strength_tests: { age_d: number; specimen: string; method: string; standard: string; mpa: number }[] = [];
  for (let i = firstData; i < rows.length; i++) {
    const age = num(rows[i][tcol.age]);
    if (age === null) continue;
    for (const s of specimens) {
      const v = num(rows[i][tcol[s.key]]);
      // Age 0 rows hold 0 MPa placeholders, not tests.
      if (v !== null && age > 0 && v > 0) {
        strength_tests.push({ age_d: age, specimen: s.specimen, method: s.method, standard: toAsciiStandard(s.standard), mpa: v });
      }
    }
  }
  return { series, strength_tests, authors_maturity };
}

// The sheet labels Russian standards in Cyrillic; keep the JSON ASCII.
function toAsciiStandard(s: string): string {
  return s.replace(/ГОСТ/g, "GOST").trim();
}

const { path, sha256: xlsxSha, datasetVersion } = await download();
const parsed = parse(path);
const doc = {
  source: "https://data.mendeley.com/datasets/nmr8pjx8d8",
  doi: DOI,
  license: "CC BY 4.0",
  attribution: ATTRIBUTION,
  dataset_version: datasetVersion ?? 1,
  source_file: { name: "Data.xlsx", sheet: "Data", sha256: xlsxSha },
  notes: [
    "Converted from the authors' Data.xlsx by packages/core/scripts/fetch-dataset.ts. Values are unchanged; layout is ours.",
    "t_h = the sheet's 'Age, day' x 24, rounded to 0.001 h. Readings every 0.5 h for 28 days.",
    "box1/box2: 50 x 50 x 50 cm blocks; cyl1/cyl2: 15 x 15 cm cylinders; ambient and rh logged next to them.",
    "strength_tests: cylinders and cubes are lab compression tests; box values are rebound hammer readings (IPS-MG 4.01, GOST 22690). Age 0 placeholder rows (0 MPa) are omitted.",
    "authors_maturity: the authors' ASTM C1074 Nurse-Saul columns in degC*day, datum -10 degC, computed on the average of the two cylinders and of the two boxes.",
  ],
  units: { t_h: "hours since casting", temp_c: "degC", rh_pct: "% relative humidity", mpa: "MPa", authors_maturity: "degC*day" },
  authors_maturity_datum_c: -10,
  series: parsed.series,
  strength_tests: parsed.strength_tests,
  authors_maturity: parsed.authors_maturity,
};
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(doc) + "\n");
const counts = Object.fromEntries(Object.entries(parsed.series).map(([k, v]) => [k, v.length]));
console.log(`wrote ${outFile}`, counts, `strength_tests=${parsed.strength_tests.length}`, `authors_maturity=${parsed.authors_maturity.length}`);
