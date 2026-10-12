// The committed passport is exactly what `npm run passport -- --network anvil` builds from the committed scenario files.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attachProof, passportTypedData, verifyPassport } from "@pourproof/core";
import { REPO_ROOT } from "@pourproof/device";
import { inspectorAccount, passportFor, passportPath } from "../src/passport.ts";
import { plain } from "../src/json.ts";

describe("anvil passport export", () => {
  it("rebuilds the committed scenario/anvil-passport-P-001.json byte for byte and verifies it", async () => {
    const { vc, inspector, chainId, ledger } = passportFor("anvil", "P-001");
    const account = inspectorAccount("anvil", inspector);
    expect(account.address.toLowerCase()).toBe(inspector);
    const signed = attachProof(vc, await account.signTypedData(passportTypedData(vc)));
    const committed = JSON.parse(readFileSync(join(REPO_ROOT, passportPath("anvil", "P-001")), "utf8"));
    expect(plain(signed)).toEqual(committed);
    expect(verifyPassport(signed, { expectedIssuer: inspector, chainId, ledger }).ok).toBe(true);
  });

  it("refuses a pour without an approved evidence package", () => {
    expect(() => passportFor("anvil", "P-002")).toThrow(/no evidence package/);
  });
});
