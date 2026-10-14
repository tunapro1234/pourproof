# Security

PourProof is a hackathon prototype running on a local Anvil chain and the Base Sepolia testnet. It has had no external
audit. Testnet demo, no real claim: do not use it to make a real carbon claim or a structural decision.

This file says what the system protects, where trust sits, what a signature does and does not prove, how keys are held,
and what we know is missing. The threat table is in [docs/threat-model.md](docs/threat-model.md). Static analysis output
is in [docs/slither-output.txt](docs/slither-output.txt).

To report a problem, open an issue on the repository. Do not put keys or personal data in the issue.

## Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| Curing record (readings) | Device, then `data/pours/<pour>/batches.json`; on chain only the Merkle root per batch | The maturity and strength range are computed from it |
| Device key (P-256) | Simulated device: `$POURPROOF_SECRETS/devices/<pour>.json`, mode 600, outside the repo. ESP32: flash | Anyone holding it can sign batches as the device |
| Role keys (supplier, contractor, inspector, owner, admin) | Anvil: the node's dev accounts. Base Sepolia: `$POURPROOF_SECRETS/roles.json`, mode 600 | They create pours, register devices, approve strength, claim the saving |
| Saving claim | `PourLedger.claimSaving`, once per pour | The one thing that must not be counted twice |
| Evidence package | `scenario/<network>-evidence-<pour>.json`, sha256 on chain in `approveStrength` | Records what the inspector approved, including the AI prompt hashes |
| Passport credential | `scenario/<network>-passport-<pour>.json` (W3C VC 2.0) | Portable copy of the record, signed by the inspector |

## Trust boundaries

1. **Concrete to sensor.** Nothing in software can see where the sensor is. This is the oracle problem, below.
2. **Sensor to device key.** The device signs what its sensor reports. On the simulated device both run in one process.
3. **Device to chain.** Anyone may relay a batch (`appendBatch` has no role check). The contract accepts it only with a
   valid P-256 signature from the key the inspector registered for that pour, the next counter, and a time window inside
   `[pourStart, block.timestamp]`.
4. **Documents to AI to people.** Claude reads the delivery ticket photo and the EPD PDF and proposes field values with
   the quote they came from. Code checks each PDF quote against `pdftotext` output; image fields always wait for a person.
   The AI approves nothing and never produces a number on its own: an explanation that contains a number not in the
   computed stats is rejected.
5. **People to chain.** Each role acts with its own key. The admin can grant and revoke roles.
6. **Chain to reader.** The web app reads public RPC or a recorded snapshot and verifies roots and signatures in the
   browser. It has no wallet and signs nothing.

**Trust model of the static demo.** On the static site the readings, the batch roots and the device key all come from the
same server: one snapshot file and the published batch files. The browser check proves that an edited reading cannot
match its signed root. It does not prove that the server is honest, because the server could replace readings, roots and
key together. The page names the snapshot's block and sha256 so the file can be compared with the one in the repository.
To remove that trust, run the scenario on your own Anvil and open the app with `?mode=live`; the roots, the device key,
the approval and the claim then come from your node (README, "Trust model").

## The oracle problem

A valid device signature says only one thing: **this device key signed these readings**. It does not say that the sensor
was inside this pour, inside concrete at all, or that it worked.

Scenario: the crew is behind schedule. They leave the sensor in a bucket of water on the site office heater instead of
casting it into the slab. Every batch is signed by the registered key, every counter is in order, every signature
verifies on chain. Pour P-002 in the demo is the honest version of this case: its device logged the dataset's open-air
series instead of concrete, and every batch is valid.

Three measures, in the order they act:

1. **Physics check on the signed curve.** `packages/core` `anomaly()` looks for the hydration heat peak in the first 24
   hours and for a curve that follows ambient air (correlation 0.95 or more). Either one raises `no_hydration_signature`;
   missing time raises `gap`. P-002 is flagged this way and is never approved, so its saving cannot be claimed. A heated
   bucket can imitate a peak, so this check catches the lazy case, not a careful one.
2. **Binding the device to the pour on site.** Only the inspector role can register a device, one per pour, before the
   readings start; a swap is a separate inspector transaction with a `DeviceReplaced` event. In the field the inspector
   records the device serial and its position before the concrete goes in (tied to the rebar, cable sealed). The chain
   keeps who registered which key and when; it cannot see the rebar.
3. **Independent confirmation before money moves.** The saving can only be claimed after `approveStrength`, and the
   inspector approves an evidence package, not a sensor. Break tests on cylinders or cores go into that package and its
   hash. The strength shown to anyone is an estimated range with the label "estimated range, inspector decides".

## Key management

- **Simulated device (this demo).** The P-256 key is generated in software and stored in
  `$POURPROOF_SECRETS/devices/<pour>.json` with mode 600, outside the repository. The loader refuses files readable by
  group or others. Only the public key (qx, qy) is in repo files and on chain. Anyone with shell access to that folder
  can sign as the device; that is acceptable for a replay of a public dataset and not for a real pour.
- **ESP32 (planned firmware, not in this repository yet).** The key would sit in the ESP32's flash. There is no secure
  element on a bare ESP32 board: with physical access, flash can be read unless flash encryption and secure boot are
  enabled, and even then it is a software-held key. The device kind on chain is `"esp32"` so readers can tell.
- **Secure element path.** A Microchip ATECC608A (I2C secure element) generates the P-256 key inside the chip and never
  exports it. It signs a 32-byte digest, which is exactly what our batch message needs (the device signs the sha256
  digest with no extra hashing), so the message format and the contract stay the same. Microchip's pre-provisioned variants ship
  with a device certificate, which would let the inspector register only keys that live in such a chip.
- **Role keys.** On Anvil the roles are the node's unlocked dev accounts from Anvil's public test mnemonic; they protect
  nothing and exist only on a local chain. On Base Sepolia they come from `$POURPROOF_SECRETS/roles.json` (mode 600,
  testnet only, created by `npm run roles-keygen -w packages/chain`). A real deployment would put the inspector and admin
  keys on hardware wallets and the admin role behind a multisig.
- **Rotation.** Role keys rotate with `grantRole` and `revokeRole` (admin). A device key is rotated with `replaceDevice`
  (inspector); the counter continues and the old key stops working at once (`test_replaceDevice_oldKeyStops_counterContinues`).
- **Secrets never enter the repository.** `.env.example` holds names only. `ANTHROPIC_API_KEY` is read from the process
  environment only.

## Replay and reuse

Every batch signature covers
`sha256(abi.encode("POURPROOF_BATCH_V1", chainId, ledger, pourId, counter, fromTs, toTs, root))`.

- The domain string separates batch signatures from anything else the key might sign.
- `chainId` and `ledger` stop a batch signed for the Anvil demo from being replayed on Base Sepolia or on another
  deployment (`test_RevertWhen_signatureFromOtherChain`).
- `pourId` stops one pour's batch from being appended to another pour that uses the same device key
  (`test_RevertWhen_signatureReusedFromOtherPour`).
- `counter` and the time window stop the same batch from being sent twice or out of order.
- Signatures must be low-s (`test_RevertWhen_highS`), so a valid signature cannot be turned into a second valid one.

The passport credential uses the same idea: its EIP-712 domain carries `chainId` and the ledger address
(`verifyingContract`), and its id names chain, ledger and pour. `verifyPassport` rejects a passport whose proof is moved
to another chain or ledger (`packages/core/test/vc.test.ts`).

## Counter

The counter starts at 0 for each pour and must go up by exactly one per batch. Anything else reverts with
`CounterGap(pourId, expected, got)`. The invariant test `invariant_counterMonotone` drives random calls and checks that
the counter never goes down or jumps. A device that loses a batch cannot skip it: it has to keep unsent batches and send
them in order, and until it does, the record visibly stops at the gap.

## Privacy

On chain there are only hashes, Merkle roots, integers (volume, GWP range) and account addresses: no readings, no
documents, no names, no site address. The delivery ticket and EPD are on chain as sha256 hashes. In this demo the
readings and sample documents are published next to the chain data on purpose, so that anyone can verify the roots in a
browser. A real deployment could keep readings with the parties and show them only to the inspector; the roots on chain
still pin them.

Two leaks to know about: a hash of a public document (a published EPD used as a baseline) can be matched by anyone who
has that document, and role addresses are pseudonymous but link all pours of the same company.

## Passport credential (W3C VC 2.0)

`packages/core/src/vc.ts` turns an approved pour into a Verifiable Credential 2.0
(`@context` `https://www.w3.org/ns/credentials/v2`, type `VerifiableCredential` and `ConcretePourPassport`).
`npm run passport -w packages/chain -- --network anvil` writes `scenario/anvil-passport-P-001.json` from the deployment
record, the transaction log and the evidence package; nothing is typed in by hand.

How the proof works (proof type `PourProofEip712Signature`):

1. `credentialHash = keccak256(JCS(credential without proof))`, with JCS the RFC 8785 canonical JSON.
2. The inspector signs EIP-712 typed data `PourPassport(string credentialId, bytes32 pourId, bytes32 credentialHash)` in
   the domain `{name: "PourProof", version: "1", chainId, verifyingContract: ledger}`. A wallet can make this signature
   with `eth_signTypedData_v4` and shows the pour id while signing; the export signs with viem the same way.
3. `proofValue` is the 65-byte `r || s || v` signature. The issuer is `did:pkh:eip155:<chainId>:<inspector address>`.

`verifyPassport` recomputes the hash, recovers the signer, and checks that it is the issuer, that the domain matches the
chain and ledger in the credential, and (when given) that it is the address holding the inspector role on that ledger.
This is our own proof type, not a registered Data Integrity cryptosuite; a generic VC verifier will read the credential
but needs this description or `vc.ts` to check the proof.

## Post-quantum note

P-256 (device) and secp256k1 (accounts, passport) both fall to a large quantum computer running Shor's algorithm. The
hashes (sha256, keccak256) only lose part of their margin. Roadmap: add an algorithm id to the device registry entry and
to the signed batch message (a `POURPROOF_BATCH_V2` domain that names the algorithm), so a pour can register an ML-DSA
(FIPS 204) or SLH-DSA (FIPS 205) device key once chains can verify it, and so old and new batches cannot be confused.
The passport proof can carry a second signature the same way. Nothing of this is built.

## Slither

[Slither](https://github.com/crytic/slither) 0.11.6 on `contracts/` with solc 0.8.28, run through the project's
heavy-job wrapper: `slither . --filter-paths "lib/|test/|script/"`. 102 detectors over 15 contracts (OpenZeppelin,
forge-std, tests and scripts filtered out). Three results; output in [docs/slither-output.txt](docs/slither-output.txt).

| Detector | Impact / confidence | Where | Decision |
| --- | --- | --- | --- |
| `uninitialized-local` | Medium / Medium | `PourLedger.claimSaving`, local `role` | False positive. Each branch either sets `role` (supplier, contractor, owner) or reverts with `NotAClaimant`, so the event never carries an unset role. Covered by `test_ownerCanClaim`, `test_RevertWhen_claimByNonParty`, `test_RevertWhen_claimByAnotherSupplier` and the invariant `invariant_atMostOneSavingClaimedPerPour`. No change. |
| `timestamp` | Low / Medium | `PourLedger.declareBaseline`, `block.timestamp >= p.pourStart` | Intended. A block producer can move the timestamp by seconds; the baseline has to be declared before the pour starts, hours ahead in practice. A few seconds either way changes nothing that matters. Accepted. |
| `timestamp` | Low / Medium | `PourLedger.appendBatch`, `toTs > block.timestamp` (`FutureBatch`) | Intended. The check stops batches dated in the future; readings are 30 minutes apart, so seconds of drift cannot let a fake future batch in. Accepted. |

Slither does not reason about the oracle problem, the admin key, or the inspector's judgment; those are in the threat
model.

## Known limits

- **Signatures prove the key, not the concrete.** See the oracle problem. The physics check is a filter, not proof.
- **One admin key.** The admin can grant any role, including inspector, to any address. A multisig and a timelock would
  be the first change for real use.
- **The inspector is trusted.** The contract checks that the inspector role approved, not that the approval was right.
- **Batches after approval are still accepted.** The approved evidence package lists the roots it covered, so later
  batches do not change what was approved, but the contract does not close the pour.
- **Revocation.** The passport has no `credentialStatus`; a verifier must check the inspector role on chain. Revoking a
  role later does not mark old passports.
- **Strength calibration** comes from one published dataset (class B25 concrete), not from the delivered mix. Mix A and
  Mix B values and both EPDs are labelled samples.
- **AI fields from photos** stay `needs_review` until a person confirms them; the stored AI responses in this repository
  were recorded once from live `claude-haiku-5-5` calls and are replayed, labelled "recorded response".
- **No audit, no mainnet.** Local Anvil and Base Sepolia only.
