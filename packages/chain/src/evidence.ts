// The evidence package behind approveStrength: maturity and strength computed by packages/core from exactly the
// readings the device signed, plus what they rest on. evidenceHash on chain = sha256 of the package file's bytes.
import { fitStrength, maturityAt, maturitySeries, saving, strengthRange, type Reading } from "@pourproof/core";
import { toReadings, type BatchesFile } from "@pourproof/device";
import { sha256Hex } from "./json.ts";

export interface EvidenceDataset {
  doi: string;
  license: string;
  attribution: string;
  series: Record<string, Reading[]>;
  strength_tests: { age_d: number; specimen: string; mpa: number }[];
}

export interface Mix {
  label: string;
  gwp_total_kg_per_m3: [number, number];
}

export const CALIBRATION_SPECIMEN = "cylinder_15x15cm";
export const CHECKPOINT_DAYS = [3, 7, 14, 28];

const average = (a: Reading[], b: Reading[]): Reading[] => a.map((r, i) => ({ t_h: r.t_h, temp_c: (r.temp_c + b[i].temp_c) / 2 }));

export function evidencePackage(o: {
  pour: BatchesFile;
  dataset: EvidenceDataset;
  network: string;
  baseline: Mix;
  delivered: Mix;
  volume_m3: number;
  strengthReference?: unknown;
}) {
  const { pour, dataset } = o;
  const readings = toReadings(pour.batches.flatMap((b) => b.readings), pour.pourStart);
  const m = maturitySeries(readings);
  const calM = maturitySeries(average(dataset.series.cyl1, dataset.series.cyl2));
  const tests = dataset.strength_tests.filter((t) => t.specimen === CALIBRATION_SPECIMEN && t.age_d <= 28);
  const fit = fitStrength(calM, tests);
  const last = readings[readings.length - 1].t_h;
  const checkpoints = CHECKPOINT_DAYS.filter((d) => d * 24 <= last).map((d) => {
    const m_ch = maturityAt(m, d * 24);
    return { age_d: d, maturity_ch: m_ch, strength: strengthRange(fit, m_ch) };
  });
  const s = saving(
    { low: o.baseline.gwp_total_kg_per_m3[0], high: o.baseline.gwp_total_kg_per_m3[1] },
    { low: o.delivered.gwp_total_kg_per_m3[0], high: o.delivered.gwp_total_kg_per_m3[1] },
    o.volume_m3,
  );
  const pkg = {
    format: "pourproof.evidence/1",
    pourLabel: pour.pourLabel,
    pourId: pour.pourId,
    network: o.network,
    chainId: pour.context.chainId,
    ledger: pour.context.ledger,
    device: { ...pour.device, deviceKind: pour.deviceKind, source: pour.source },
    batches: { count: pour.batches.length, readings: readings.length, pourStart: pour.pourStart, roots: pour.batches.map((b) => b.root) },
    maturity: {
      method: "Nurse-Saul temperature-time factor (ASTM C1074), datum -10 degC, computed by packages/core from the signed readings",
      at_h: last,
      maturity_ch: m[m.length - 1].m_ch,
    },
    strength: {
      label: "estimated range, inspector decides",
      calibration: `S = a + b ln(M) fitted on the dataset's lab tests (${CALIBRATION_SPECIMEN}, ages up to 28 d) against the average of the two cylinder temperature records`,
      fit,
      range: "prediction +- 2 residual standard deviations",
      checkpoints,
      reference: o.strengthReference ?? null,
    },
    anomaly: { flags: pour.anomaly.flags, reference: pour.anomaly.reference },
    carbon: {
      baseline: o.baseline,
      delivered: o.delivered,
      volume_m3: o.volume_m3,
      saving_kg: s,
      note: "sample values; on chain the saving is computed again from the declared integers",
    },
    dataset: { doi: dataset.doi, license: dataset.license, attribution: dataset.attribution },
    ai: null,
  };
  const text = JSON.stringify(pkg, null, 1) + "\n";
  return { pkg, text, sha256: sha256Hex(text) };
}
