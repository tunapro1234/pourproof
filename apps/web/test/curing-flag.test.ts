// The amber curing-flag band reads the rule-based anomaly flags (packages/core), never AI output.
import { describe, expect, it } from "vitest";
import { curingFlag } from "../src/views/pour.ts";
import { snapshot } from "./fixtures.ts";

/** Flags the snapshot recorded for a pour: packages/core anomaly() run on the signed readings. */
const flagsOf = (label: string) => (snapshot.pours[label] as unknown as { anomaly: { flags: string[] } }).anomaly.flags;

describe("curing-flag band", () => {
  it("P-002 (flagged by the curing check, not approved): signatures valid but not curing concrete, no approval, no claim", () => {
    const flags = flagsOf("P-002");
    expect(flags).toEqual(["no_hydration_signature"]);
    const html = curingFlag(flags, false);
    expect(html).toContain('data-testid="curing-flag"');
    expect(html).toContain("Signatures are valid, but this record does not look like curing concrete: no hydration heat rise in the first 24 h (no_hydration_signature).");
    expect(html).toContain("No strength approval, no saving claim.");
  });

  it("P-001 (no flags) has no band; other flags are named as they are", () => {
    expect(curingFlag(flagsOf("P-001"), true)).toBe("");
    const gap = curingFlag(["gap"], true);
    expect(gap).toContain("the curing check flagged this record: gap.");
    expect(gap).toContain("The inspector approved it anyway");
  });
});
