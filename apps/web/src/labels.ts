// Fixed on-screen labels. Every screen says where its data comes from, which network it is, and that this is a
// testnet demo. Labels are text a judge can read, not small grey print.

export const DATASET_CITATION = "Mendeley nmr8pjx8d8, CC BY 4.0";

/** Device label from the deviceKind the inspector registered on chain. */
export function deviceLabel(kind: string): string {
  if (kind === "esp32") return "measured by our sensor";
  if (kind === "simulated") return `simulated device · replayed from published dataset (${DATASET_CITATION})`;
  return `unknown device kind "${kind}"`;
}

export const DEMO_CARD_TITLE = "Testnet demo, no real claim";
export const DEMO_CARD_TEXT =
  "Pours, parties and documents are samples. The saving claim on this page is a test transaction on a local or test network: nothing was issued, sold or retired. Strength is an estimated range from code; the inspector decides.";

export const ATTRIBUTION =
  "Curing data: Utepov et al., Complex Maturity Method for Estimating the Concrete Strength Based on Curing Temperature, Ambient Temperature and Relative Humidity, Applied Sciences 11(16):7712, 2021; dataset doi 10.17632/nmr8pjx8d8.1, CC BY 4.0.";

export const SERIES_NOTE: Record<string, string> = {
  box1: "curing curve: published dataset (class B25), not Mix B",
  ambient: "this device logged the dataset's ambient air series (tamper case)",
};

export const FLAG_TEXT: Record<string, string> = {
  no_hydration_signature: "no hydration signature: no heat rise over the air in the first 24 h, or the curve follows the air",
  gap: "gap: a step between readings longer than the device's normal interval",
};
