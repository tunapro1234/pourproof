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

// Home page hero: the one pour a visitor should open first, and who opens a passport and when.
export const HERO_POUR = "P-001";
export const heroTitle = (label: string): string => `Pour ${label} left one signed curing record. Fake a warm night in it and see what happens.`;
export const ROLE_LINE =
  "Who opens it: the site engineer before stripping formwork, the supplier to claim the saving once, the inspector when the 28-day result is in.";
export const HERO_OPEN = (label: string): string => `Open the passport of ${label}`;

// Passport card where the visitor edits the curing record in their own browser.
export const TRY_TITLE = "Fake a warm night";
export const TRY_TEXT =
  "A cold night slows curing. Raise one night's readings and the edited copy would claim a higher early strength, so formwork could come off sooner. This browser rebuilds the Merkle root of every batch and checks each P-256 signature against the roots and device key recorded on chain.";
export const trustNote = (block: string, sha: string): string =>
  `On this static page the recorded chain state comes from the same server as the readings (snapshot file, block ${block}, sha256 ${sha}). So this shows that one edited reading cannot match its signed root. It does not show that the server is honest. To check against a chain you run yourself: npm run scenario, then npm run dev and open ?mode=live (README).`;
export const liveNote = (rpc: string): string => `Live mode: chain state read from ${rpc}`;
export const TAMPER_NOTE_CLAIMED = "Nothing on chain changed. Only your copy in this browser did; the claim already made used the untouched record.";
export const TAMPER_NOTE = "Nothing on chain changed. Only your copy in this browser did.";
export const UNDO = "Undo the change";
export const CALIBRATION_NOTE =
  "Calibration: the dataset's class B25 concrete, not the delivered mix. A real supplier calibrates each mix first (ASTM C1074). Acceptance stays with the 28-day specimens.";
