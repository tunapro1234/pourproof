// Pour passport as a W3C Verifiable Credential 2.0 (https://www.w3.org/TR/vc-data-model-2.0/).
//
// Securing mechanism (an embedded proof of our own type, "PourProofEip712Signature"; it is not a registered
// Data Integrity cryptosuite, so a verifier needs this file or the description in SECURITY.md):
//  1. credentialHash = keccak256(utf8(JCS(credential without "proof"))), JCS = RFC 8785 canonical JSON
//  2. EIP-712 typed data, signed with the inspector's Ethereum key (the account holding INSPECTOR on the ledger):
//       domain  EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
//               { name: "PourProof", version: "1", chainId, verifyingContract: ledger }
//       message PourPassport(string credentialId,bytes32 pourId,bytes32 credentialHash)
//     Any wallet can produce the signature with eth_signTypedData_v4 and shows the pour id while signing.
//  3. proofValue = 65-byte r || s || v (v = 27 or 28, low-s), the eth_signTypedData_v4 output
// The issuer is did:pkh:eip155:<chainId>:<address>. The domain binds the signature to one chain and one ledger,
// so a passport signed for the Anvil demo does not verify as a Base Sepolia passport.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { fromHex, toHex, type Hex } from "./batch.ts";

export const VC_CONTEXT_V2 = "https://www.w3.org/ns/credentials/v2";
export const PASSPORT_TYPE = "ConcretePourPassport";
export const PROOF_TYPE = "PourProofEip712Signature";
export const EIP712_NAME = "PourProof";
export const EIP712_VERSION = "1";

const DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const PASSPORT_STRUCT = "PourPassport(string credentialId,bytes32 pourId,bytes32 credentialHash)";

/** The chain references every passport carries; chainId and ledger also go into the EIP-712 domain. */
export interface ChainRefs {
  network: string;
  chainId: number;
  ledger: Hex;
  /** transaction hash per step, e.g. createPour, approveStrength */
  txs: Record<string, Hex>;
  [k: string]: unknown;
}

/** What the passport states about one pour. Values come from the chain and the evidence package, never from an LLM. */
export interface PassportSubject {
  id: string;
  type: "ConcretePour";
  pourId: Hex;
  pourLabel: string;
  chain: ChainRefs;
  [k: string]: unknown;
}

export interface UnsignedPassport {
  "@context": string[];
  id: string;
  type: string[];
  name: string;
  description: string;
  issuer: string;
  validFrom: string;
  credentialSubject: PassportSubject;
}

export interface PassportProof {
  type: typeof PROOF_TYPE;
  created: string;
  proofPurpose: "assertionMethod";
  verificationMethod: string;
  canonicalization: string;
  eip712: { domain: Eip712Domain; primaryType: "PourPassport" };
  credentialHash: Hex;
  proofValue: Hex;
}

export interface SignedPassport extends UnsignedPassport {
  proof: PassportProof;
}

export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Hex;
}

// ---------- canonical JSON (RFC 8785) ----------

/** RFC 8785 JCS: keys sorted by UTF-16 code units, no whitespace, ECMAScript number and string serialisation. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`JCS: ${v} is not a JSON number`);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  throw new Error(`JCS: cannot encode a ${typeof v}`);
}

// ---------- identifiers ----------

export function didPkh(chainId: number, address: Hex): string {
  return `did:pkh:eip155:${chainId}:${address.toLowerCase()}`;
}

/** Parses did:pkh:eip155:<chainId>:<address>; null for anything else. */
export function parseDidPkh(did: string): { chainId: number; address: Hex } | null {
  const m = /^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(did);
  return m ? { chainId: Number(m[1]), address: m[2].toLowerCase() as Hex } : null;
}

export function passportId(chainId: number, ledger: Hex, pourId: Hex): string {
  return `urn:pourproof:passport:${chainId}:${ledger.toLowerCase()}:${pourId.toLowerCase()}`;
}

/** Ethereum address of a secp256k1 secret key (last 20 bytes of keccak256 of the uncompressed point). */
export function ethAddressOf(secretKey: Uint8Array): Hex {
  return addressOfPoint(secp256k1.getPublicKey(secretKey, false));
}

function addressOfPoint(uncompressed: Uint8Array): Hex {
  return toHex(keccak_256(uncompressed.slice(1)).slice(12));
}

// ---------- building ----------

export interface BuildPassportInput {
  subject: PassportSubject;
  /** the inspector's address; the issuer DID is formed on subject.chain.chainId */
  issuer: Hex;
  /** unix seconds; the approveStrength block time */
  validFrom: number;
}

export const isoTime = (unix: number): string => new Date(unix * 1000).toISOString().replace(".000Z", "Z");

export function buildPassport(i: BuildPassportInput): UnsignedPassport {
  const s = i.subject;
  return {
    "@context": [VC_CONTEXT_V2],
    id: passportId(s.chain.chainId, s.chain.ledger, s.pourId),
    type: ["VerifiableCredential", PASSPORT_TYPE],
    name: `PourProof passport ${s.pourLabel}`,
    description: "Signed record of one concrete pour. Testnet demo, no real claim. Strength is an estimated range, the inspector decides.",
    issuer: didPkh(s.chain.chainId, i.issuer),
    validFrom: isoTime(i.validFrom),
    credentialSubject: s,
  };
}

function withoutProof(vc: UnsignedPassport | SignedPassport): UnsignedPassport {
  const { proof: _proof, ...rest } = vc as SignedPassport;
  return rest;
}

export function credentialHash(vc: UnsignedPassport | SignedPassport): Hex {
  return toHex(keccak_256(new TextEncoder().encode(canonicalJson(withoutProof(vc)))));
}

// ---------- EIP-712 ----------

export function domainOf(vc: UnsignedPassport): Eip712Domain {
  const c = vc.credentialSubject.chain;
  return { name: EIP712_NAME, version: EIP712_VERSION, chainId: c.chainId, verifyingContract: c.ledger.toLowerCase() as Hex };
}

/** The typed data a wallet signs (viem signTypedData / eth_signTypedData_v4 shape). */
export function passportTypedData(vc: UnsignedPassport, domain = domainOf(vc)) {
  return {
    domain,
    types: {
      PourPassport: [
        { name: "credentialId", type: "string" },
        { name: "pourId", type: "bytes32" },
        { name: "credentialHash", type: "bytes32" },
      ],
    },
    primaryType: "PourPassport" as const,
    message: { credentialId: vc.id, pourId: vc.credentialSubject.pourId, credentialHash: credentialHash(vc) },
  };
}

const kec = (b: Uint8Array) => keccak_256(b);
const utf8 = (s: string) => new TextEncoder().encode(s);

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function uintWord(v: number | bigint): Uint8Array {
  const n = BigInt(v);
  if (n < 0n || n >= 1n << 256n) throw new Error(`${v} does not fit uint256`);
  return fromHex(n.toString(16).padStart(64, "0"));
}

function word32(h: string, len: number): Uint8Array {
  const b = fromHex(h);
  if (b.length !== len) throw new Error(`expected ${len} bytes: ${h}`);
  return cat(new Uint8Array(32 - len), b);
}

export function domainSeparator(d: Eip712Domain): Hex {
  return toHex(kec(cat(kec(utf8(DOMAIN_TYPE)), kec(utf8(d.name)), kec(utf8(d.version)), uintWord(d.chainId), word32(d.verifyingContract, 20))));
}

/** keccak256(0x19 0x01 || domainSeparator || hashStruct(PourPassport)) */
export function passportDigest(vc: UnsignedPassport, domain = domainOf(vc)): Hex {
  const m = passportTypedData(vc, domain).message;
  const struct = kec(cat(kec(utf8(PASSPORT_STRUCT)), kec(utf8(m.credentialId)), word32(m.pourId, 32), word32(m.credentialHash, 32)));
  return toHex(kec(cat(new Uint8Array([0x19, 0x01]), fromHex(domainSeparator(domain)), struct)));
}

// ---------- signing ----------

/** Adds the proof to a credential from a 65-byte r || s || v signature made elsewhere (a wallet, viem). */
export function attachProof(vc: UnsignedPassport, signature: Hex, created = vc.validFrom): SignedPassport {
  const domain = domainOf(vc);
  return {
    ...vc,
    proof: {
      type: PROOF_TYPE,
      created,
      proofPurpose: "assertionMethod",
      verificationMethod: `${vc.issuer}#blockchainAccountId`,
      canonicalization: "RFC 8785 JCS of the credential without proof, then keccak256",
      eip712: { domain, primaryType: "PourPassport" },
      credentialHash: credentialHash(vc),
      proofValue: signature.toLowerCase() as Hex,
    },
  };
}

/** Signs with a secp256k1 secret key (RFC 6979, low-s). The key must belong to the issuer address. */
export function signPassport(vc: UnsignedPassport, secretKey: Uint8Array): SignedPassport {
  const issuer = parseDidPkh(vc.issuer);
  if (!issuer || issuer.address !== ethAddressOf(secretKey)) throw new Error("the key does not belong to the credential issuer");
  const sig = secp256k1.sign(fromHex(passportDigest(vc)), secretKey, { prehash: false, lowS: true, format: "recovered" });
  return attachProof(vc, toHex(cat(sig.slice(1, 65), new Uint8Array([27 + sig[0]]))));
}

/** Address that produced a 65-byte r || s || v signature over the digest; null if it does not parse or s is high. */
export function recoverSigner(digest: Hex, signature: Hex): Hex | null {
  try {
    const b = fromHex(signature);
    if (b.length !== 65) return null;
    const v = b[64] >= 27 ? b[64] - 27 : b[64];
    if (v !== 0 && v !== 1) return null;
    const s = BigInt(toHex(b.slice(32, 64)));
    if (s === 0n || s > secp256k1.Point.CURVE().n / 2n) return null;
    const pub = secp256k1.recoverPublicKey(cat(new Uint8Array([v]), b.slice(0, 64)), fromHex(digest), { prehash: false });
    return addressOfPoint(secp256k1.Point.fromBytes(pub).toBytes(false));
  } catch {
    return null;
  }
}

// ---------- verification ----------

export interface VerifyPassportOptions {
  /** the address that must have signed, e.g. the INSPECTOR role holder read from the ledger */
  expectedIssuer?: Hex;
  /** the chain and ledger the verifier trusts; the proof must be bound to them */
  chainId?: number;
  ledger?: Hex;
}

export interface PassportCheck {
  ok: boolean;
  signer: Hex | null;
  credentialHash: Hex;
  problems: string[];
}

/** Checks the data model, the context binding and the signature. Read the role holder from the chain for expectedIssuer. */
export function verifyPassport(vc: SignedPassport, o: VerifyPassportOptions = {}): PassportCheck {
  const problems: string[] = [];
  const hash = credentialHash(vc);
  const p = vc.proof;
  if (vc["@context"]?.[0] !== VC_CONTEXT_V2) problems.push(`@context must start with ${VC_CONTEXT_V2}`);
  if (!vc.type?.includes("VerifiableCredential") || !vc.type.includes(PASSPORT_TYPE)) problems.push(`type must include VerifiableCredential and ${PASSPORT_TYPE}`);
  if (!p || p.type !== PROOF_TYPE) {
    problems.push(`proof type must be ${PROOF_TYPE}`);
    return { ok: false, signer: null, credentialHash: hash, problems };
  }
  if (p.proofPurpose !== "assertionMethod") problems.push("proofPurpose must be assertionMethod");
  if (p.credentialHash !== hash) problems.push("credential content does not match the signed credentialHash");

  const s = vc.credentialSubject;
  const domain = domainOf(vc);
  if (canonicalJson(p.eip712?.domain) !== canonicalJson(domain)) problems.push("proof domain is not the chain and ledger named in the credential");
  if (vc.id !== passportId(s.chain.chainId, s.chain.ledger, s.pourId)) problems.push("credential id does not name this chain, ledger and pour");
  if (o.chainId !== undefined && s.chain.chainId !== o.chainId) problems.push(`credential is for chain ${s.chain.chainId}, expected ${o.chainId}`);
  if (o.ledger !== undefined && s.chain.ledger.toLowerCase() !== o.ledger.toLowerCase()) problems.push(`credential is for ledger ${s.chain.ledger}, expected ${o.ledger}`);

  const issuer = parseDidPkh(vc.issuer);
  if (!issuer) problems.push("issuer must be a did:pkh:eip155 account");
  else if (issuer.chainId !== s.chain.chainId) problems.push("issuer DID names another chain");
  if (p.verificationMethod !== `${vc.issuer}#blockchainAccountId`) problems.push("verificationMethod is not the issuer account");

  const signer = recoverSigner(passportDigest(vc), p.proofValue);
  if (!signer) problems.push("proofValue is not a valid low-s secp256k1 signature");
  else {
    if (issuer && signer !== issuer.address) problems.push(`signed by ${signer}, not by the issuer ${issuer.address}`);
    if (o.expectedIssuer && signer !== o.expectedIssuer.toLowerCase()) problems.push(`signed by ${signer}, expected ${o.expectedIssuer.toLowerCase()}`);
  }
  if (Number.isNaN(Date.parse(vc.validFrom))) problems.push("validFrom is not a date");
  return { ok: problems.length === 0, signer, credentialHash: hash, problems };
}
