// W3C VC 2.0 passport: canonical form, EIP-712 digest and signature (checked against viem, the library wallets and
// the chain package use), and every way verification has to fail. The last block checks the committed Anvil passport
// (scenario/anvil-passport-P-001.json) against the deployment record and the transaction log it was built from.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  PASSPORT_TYPE,
  VC_CONTEXT_V2,
  attachProof,
  buildPassport,
  canonicalJson,
  credentialHash,
  didPkh,
  ethAddressOf,
  passportDigest,
  passportTypedData,
  pourIdOf,
  signPassport,
  toHex,
  verifyPassport,
  type Hex,
  type PassportSubject,
  type SignedPassport,
} from "../src/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readJson = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

// Test keys derived from fixed strings: not secrets, used only here.
const KEY = keccak_256(new TextEncoder().encode("pourproof vc test: inspector"));
const OTHER = keccak_256(new TextEncoder().encode("pourproof vc test: someone else"));
const INSPECTOR = ethAddressOf(KEY);
const LEDGER = "0x5fbdb2315678afecb367f032d93f642f64180aa3" as Hex;

function subject(chainId = 31337, ledger = LEDGER): PassportSubject {
  const pourId = pourIdOf("P-TEST");
  return {
    id: `urn:pourproof:pour:${chainId}:${ledger}:${pourId}`,
    type: "ConcretePour",
    pourId,
    pourLabel: "P-TEST",
    volume: { m3: 8, onChainDm3: 8000 },
    embodiedCo2: { lowKg: 2448, highKg: 2608, unit: "kg CO2e" },
    curing: { strength: { label: "estimated range, inspector decides", checkpoints: [{ ageDays: 7, lowMpa: 19.6, highMpa: 25.6 }] } },
    chain: { network: "anvil", chainId, ledger, txs: { approveStrength: `0x${"ab".repeat(32)}` } },
  };
}

const unsigned = () => buildPassport({ subject: subject(), issuer: INSPECTOR, validFrom: 1791441180 });
const signed = () => signPassport(unsigned(), KEY);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("canonical JSON (RFC 8785)", () => {
  it("sorts keys at every level, keeps array order, writes numbers the ECMAScript way", () => {
    expect(canonicalJson({ b: [3, { z: 1, a: null }], a: "x", c: { e: 1e21, d: 0.000001, f: -0 } })).toBe(
      '{"a":"x","b":[3,{"a":null,"z":1}],"c":{"d":0.000001,"e":1e+21,"f":0}}',
    );
    expect(canonicalJson({ "é": 1, z: 2, "€": 3 })).toBe('{"z":2,"é":1,"€":3}');
  });

  it("does not depend on key order and refuses values JSON cannot carry", () => {
    expect(canonicalJson({ x: 1, y: { p: 2, q: 3 } })).toBe(canonicalJson({ y: { q: 3, p: 2 }, x: 1 }));
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/not a JSON number/);
    expect(() => canonicalJson({ a: 1n })).toThrow(/cannot encode/);
  });
});

describe("building and signing", () => {
  it("is a VC 2.0 credential with the passport type, an issuer DID for the inspector and no proof yet", () => {
    const vc = unsigned();
    expect(vc["@context"]).toEqual([VC_CONTEXT_V2]);
    expect(vc.type).toEqual(["VerifiableCredential", PASSPORT_TYPE]);
    expect(vc.issuer).toBe(didPkh(31337, INSPECTOR));
    expect(vc.validFrom).toBe("2026-10-08T06:33:00Z");
    expect("proof" in vc).toBe(false);
  });

  it("computes the same EIP-712 digest as viem and the same signature a wallet makes", async () => {
    const vc = unsigned();
    const td = passportTypedData(vc);
    expect(passportDigest(vc)).toBe(hashTypedData(td));
    const walletSig = await privateKeyToAccount(toHex(KEY)).signTypedData(td);
    const ours = signPassport(vc, KEY);
    expect(ours.proof.proofValue).toBe(walletSig.toLowerCase());
    expect((await recoverTypedDataAddress({ ...td, signature: ours.proof.proofValue })).toLowerCase()).toBe(INSPECTOR);
    expect(attachProof(vc, walletSig)).toEqual(ours);
  });

  it("refuses to sign with a key that is not the issuer's", () => {
    expect(() => signPassport(unsigned(), OTHER)).toThrow(/does not belong to the credential issuer/);
  });

  it("verifies, names the signer and the hash of the credential without its proof", () => {
    const vc = signed();
    const r = verifyPassport(vc, { expectedIssuer: INSPECTOR, chainId: 31337, ledger: LEDGER });
    expect(r).toEqual({ ok: true, signer: INSPECTOR, credentialHash: credentialHash(unsigned()), problems: [] });
    expect(vc.proof.credentialHash).toBe(r.credentialHash);
  });
});

describe("verification fails", () => {
  it("when a value in the subject changes", () => {
    const vc = clone(signed());
    (vc.credentialSubject.volume as { m3: number }).m3 = 9;
    const r = verifyPassport(vc);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain("credential content does not match the signed credentialHash");
  });

  it("when the changed credential also carries a recomputed hash: the signature no longer matches the issuer", () => {
    const vc = clone(signed());
    (vc.credentialSubject.embodiedCo2 as { lowKg: number }).lowKg = 1000;
    vc.proof.credentialHash = credentialHash(vc);
    const r = verifyPassport(vc);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.startsWith("signed by ") && p.endsWith(`not by the issuer ${INSPECTOR}`))).toBe(true);
  });

  it("when the passport is moved to another chain or ledger (context binding)", () => {
    const other = buildPassport({ subject: subject(84532), issuer: INSPECTOR, validFrom: 1791441180 });
    const moved = { ...other, proof: signed().proof } as SignedPassport;
    const r = verifyPassport(moved);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain("proof domain is not the chain and ledger named in the credential");

    const elsewhere = verifyPassport(signed(), { chainId: 84532, ledger: "0x0000000000000000000000000000000000000001" });
    expect(elsewhere.problems).toEqual([
      "credential is for chain 31337, expected 84532",
      `credential is for ledger ${LEDGER}, expected 0x0000000000000000000000000000000000000001`,
    ]);
  });

  it("when someone else signs, even if they put their own DID in as issuer", async () => {
    const vc = unsigned();
    const forged = attachProof(vc, await privateKeyToAccount(toHex(OTHER)).signTypedData(passportTypedData(vc)));
    expect(verifyPassport(forged).problems).toContain(`signed by ${ethAddressOf(OTHER)}, not by the issuer ${INSPECTOR}`);

    const self = signPassport(buildPassport({ subject: subject(), issuer: ethAddressOf(OTHER), validFrom: 1791441180 }), OTHER);
    expect(verifyPassport(self).ok).toBe(true);
    expect(verifyPassport(self, { expectedIssuer: INSPECTOR }).problems).toEqual([`signed by ${ethAddressOf(OTHER)}, expected ${INSPECTOR}`]);
  });

  it("for a high-s twin of a valid signature, a malformed proofValue, a wrong context or proof type", () => {
    const vc = signed();
    const sig = vc.proof.proofValue;
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = (N - BigInt(`0x${sig.slice(66, 130)}`)).toString(16).padStart(64, "0");
    const v = Number.parseInt(sig.slice(130), 16) === 27 ? "1c" : "1b";
    const twin = clone(vc);
    twin.proof.proofValue = `${sig.slice(0, 66)}${highS}${v}` as Hex;
    expect(verifyPassport(twin).problems).toContain("proofValue is not a valid low-s secp256k1 signature");

    const short = clone(vc);
    short.proof.proofValue = sig.slice(0, 100) as Hex;
    expect(verifyPassport(short).ok).toBe(false);

    const v1 = clone(vc);
    v1["@context"] = ["https://www.w3.org/2018/credentials/v1"];
    expect(verifyPassport(v1).problems).toContain(`@context must start with ${VC_CONTEXT_V2}`);

    const other = clone(vc) as unknown as { proof: { type: string } };
    other.proof.type = "DataIntegrityProof";
    expect(verifyPassport(other as unknown as SignedPassport).problems).toContain("proof type must be PourProofEip712Signature");
  });
});

describe("committed Anvil passport for P-001", () => {
  const vc = readJson("scenario/anvil-passport-P-001.json") as SignedPassport;
  const dep = readJson("deployments/anvil.json");
  const log = readJson("scenario/anvil-log.json");
  const steps = (log.steps as { pour: string; fn: string; status: string; txHash: string; account: string; events: { name: string; args: Record<string, unknown> }[] }[]).filter(
    (s) => s.pour === "P-001",
  );
  const tx = (fn: string) => steps.find((s) => s.fn === fn && s.status === "success")!;

  it("verifies against the inspector role holder, the chain and the ledger in deployments/anvil.json", () => {
    const r = verifyPassport(vc, { expectedIssuer: dep.roles.inspector, chainId: dep.chainId, ledger: dep.ledger.address });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(vc["@context"][0]).toBe(VC_CONTEXT_V2);
    expect(vc.type).toContain("VerifiableCredential");
  });

  it("carries the on-chain values and transaction hashes of the scenario log", () => {
    const s = vc.credentialSubject as PassportSubject & Record<string, any>;
    const created = tx("createPour").events.find((e) => e.name === "PourCreated")!.args;
    const claimed = tx("claimSaving").events.find((e) => e.name === "SavingClaimed")!.args;
    expect(s.pourId).toBe(pourIdOf("P-001"));
    expect(s.volume.onChainDm3).toBe(created.volumeDm3);
    expect(s.documents.ticketSha256).toBe(created.ticketHash);
    expect(s.documents.evidence.sha256).toBe(log.evidence.sha256);
    expect([s.savingVsBaseline.lowKg, s.savingVsBaseline.highKg].map(String)).toEqual([claimed.savingLow_kg, claimed.savingHigh_kg]);
    for (const fn of ["createPour", "approveStrength", "claimSaving", "declareBaseline", "registerDevice", "acceptPour"]) {
      expect(s.chain.txs[fn]).toBe(tx(fn).txHash);
    }
    expect(s.savingVsBaseline.laterClaimsRefused).toHaveLength(1);
    expect(s.curing.strength.label).toBe("estimated range, inspector decides");
    for (const c of s.curing.strength.checkpoints) expect(c.lowMpa).toBeLessThan(c.highMpa);
  });
});
