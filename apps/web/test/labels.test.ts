// Wording: "leaner", the curing curve named as the published class B25 dataset wherever it is shown, no "first" or
// "DPP-ready" claims, and the simulated-device label on every screen that shows readings.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { curingChart } from "../src/chart.ts";
import { deviceLabel, SERIES_NOTE } from "../src/labels.ts";
import { homeView } from "../src/views/home.ts";
import { inputs, REPO, view } from "./fixtures.ts";

const BANNED = /low(er)?-clinker|DPP-ready|world'?s first/i;
const CURVE = "published dataset, class B25, not the delivered mix";

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe("wording", () => {
  it("no banned wording in the web sources, README or SECURITY", () => {
    const files = [...filesUnder(join(REPO, "apps/web/src")), join(REPO, "README.md"), join(REPO, "SECURITY.md")];
    for (const f of files) expect([f, BANNED.test(readFileSync(f, "utf8"))]).toEqual([f, false]);
  });

  it("the curing curve is labelled as the published class B25 dataset, in the chart and in the README", () => {
    expect(SERIES_NOTE.box1).toContain(CURVE);
    const svg = curingChart(
      [
        { t_h: 0.5, temp_c: 20 },
        { t_h: 1, temp_c: 21 },
      ],
      { sourceLabel: deviceLabel("simulated"), note: SERIES_NOTE.box1 },
    );
    expect(svg).toContain(CURVE);
    expect(readFileSync(join(REPO, "README.md"), "utf8")).toContain(CURVE);
  });

  it("the home list keeps the simulated-device label on every pour", () => {
    const html = homeView(view, inputs, "");
    expect(html.match(/simulated device · replayed from published dataset/g)).toHaveLength(Object.keys(view.pours).length);
  });
});
