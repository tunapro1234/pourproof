# Threat model (STRIDE)

Scope: the PourProof prototype as built in this repository: simulated device, `PourLedger` (with `DeviceRegistry`),
the chain scenario, the AI layer, the passport credential and the read-only web app. Assets and trust boundaries are in
[SECURITY.md](../SECURITY.md). Status: **mitigated** (a control exists and a test covers it), **partial** (a control
exists with a known gap), **open** (known, not handled in this prototype).

## Actors

- Supplier (ready-mix plant), contractor (site), inspector (building control), owner: each holds a role key.
- Device: holds the P-256 key registered for one pour.
- Relayer: anyone who submits a signed batch. Holds no special right.
- Reader: anyone with the web app, public RPC or a passport file.
- Attacker: an outsider, or one of the parties acting against the others.

## Table

| # | STRIDE | Threat | Target | Control | Test or evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | Spoofing | Someone signs batches without the device key | `appendBatch` | P-256 signature checked on chain against the registered key | `test_RevertWhen_wrongKey`, `testFuzz_RevertWhen_wrongKeyAppends`, `invariant_wrongKeyNeverAppends` | mitigated |
| S2 | Spoofing | A party registers its own device key for a pour | `registerDevice` | Inspector role only; one device per pour; swap only via `replaceDevice` with an event | `test_RevertWhen_nonInspectorRegistersDevice`, `test_RevertWhen_secondDeviceForPour` | mitigated |
| S3 | Spoofing | A non-party claims the saving | `claimSaving` | Only the pour's supplier, its contractor or an owner | `test_RevertWhen_claimByNonParty`, `test_RevertWhen_claimByAnotherSupplier` | mitigated |
| S4 | Spoofing | A passport signed by someone other than the inspector | passport credential | Signer recovered from the EIP-712 signature must equal the issuer DID and the inspector role holder | `packages/core/test/vc.test.ts` ("when someone else signs") | mitigated |
| S5 | Spoofing | Device key copied from the simulated device's file or from ESP32 flash | device key | File mode 600 outside the repo; ESP32 has no secure element. ATECC608A path in SECURITY.md | loader refuses group/other-readable key files | partial |
| T1 | Tampering | A reading is changed after signing | batches.json, web | Merkle root signed by the device and stored on chain; browser recomputes roots and per-reading proofs | `apps/web` tests and e2e (`?tamper=reading:<i>` turns red), `test_RevertWhen_rootTampered` | mitigated |
| T2 | Tampering | Sensor placed outside the concrete (bucket, open air) | curing record | `anomaly()` flags no hydration signature or ambient-following curve; inspector binds device on site; break tests before approval | P-002 in the scenario is flagged and never approved | partial (oracle problem) |
| T3 | Tampering | Baseline mix chosen after the fact to inflate the saving | `declareBaseline` | Contractor only, before `pourStart` and before any batch; once per pour | `test_RevertWhen_baselineAfterPourStart`, `test_RevertWhen_baselineAfterFirstBatch`, `test_RevertWhen_baselineDeclaredTwice` | mitigated |
| T4 | Tampering | Passport content changed after signing | passport credential | JCS hash inside the signed EIP-712 message | `vc.test.ts` ("when a value in the subject changes", "recomputed hash") | mitigated |
| T5 | Tampering | AI invents a field value or a number | AI layer | PDF quotes checked against `pdftotext`; image fields wait for a person; explanation with a number not in the stats is rejected | `packages/ai` tests | mitigated |
| T6 | Tampering | Batches appended after approval | `appendBatch` | Evidence package lists the approved roots and its hash is on chain | evidence package `batches.roots` | partial |
| R1 | Repudiation | A party denies an action | all state changes | Every state change emits an event from the acting address; the web timeline is built from events | scenario log, web timeline | mitigated |
| R2 | Repudiation | Inspector denies what was approved | `approveStrength` | sha256 of the evidence package on chain; passport signed by the inspector key | `scenario/anvil-evidence-P-001.json`, `vc.test.ts` committed passport checks | mitigated |
| I1 | Information disclosure | Readings, documents or names exposed on chain | chain | Only hashes, roots, integers and addresses on chain | contract storage layout, `SECURITY.md` Privacy | mitigated |
| I2 | Information disclosure | Hash of a public EPD reveals which baseline was declared | `baselineMixHash` | none in the prototype; a salted commitment would fix it | | open |
| I3 | Information disclosure | Keys or personal data leak into the repository | repo | Secrets folder outside the repo, `.env.example` only, repository scan in the project's acceptance checks | | mitigated |
| D1 | Denial of service | Spam batches block a pour | `appendBatch` | A batch needs the device signature and the next counter, so junk reverts and costs the sender gas | `test_RevertWhen_counterGap`, `test_RevertWhen_wrongKey` | mitigated |
| D2 | Denial of service | A lost batch stops the record | device, counter | Device must buffer and resend in order; the gap is visible as `gap` | `anomaly()` gap flag, `packages/ai` missing-batch case | partial |
| D3 | Denial of service | Batch dated in the future to block later batches | `appendBatch` | `FutureBatch` revert when `toTs > block.timestamp` | `test_RevertWhen_futureBatch`, `testFuzz_RevertWhen_futureBatch` | mitigated |
| E1 | Elevation of privilege | Second saving claim on one pour (double counting) | `claimSaving` | `AlreadyClaimed(pourId, firstClaimant)` for every later call from any role | `test_RevertWhen_secondClaim_fromEveryRole`, `invariant_atMostOneSavingClaimedPerPour`; scenario's refused contractor claim | mitigated |
| E2 | Elevation of privilege | Admin key grants itself or a friend the inspector role | AccessControl | none beyond events; multisig and timelock are the fix | `RoleGranted` events in the timeline | open |
| E3 | Elevation of privilege | Batch or passport replayed on another chain, ledger or pour | signatures | chainId, ledger and pourId inside the signed batch digest and the EIP-712 domain | `test_RevertWhen_signatureFromOtherChain`, `test_RevertWhen_signatureReusedFromOtherPour`, `vc.test.ts` ("moved to another chain") | mitigated |
| E4 | Elevation of privilege | Malleable signature accepted as a new one | `appendBatch`, passport | Low-s required on both | `test_RevertWhen_highS`, `vc.test.ts` ("high-s twin") | mitigated |

## What would change for real use

1. Secure element (ATECC608A) on the device and key attestation at registration (S5).
2. Multisig plus timelock for the admin role (E2).
3. Salted commitments for document hashes that could be public (I2).
4. Close a pour for new batches at approval, and a status list for passports (T6, revocation).
5. A second, independent sensor or random spot checks on site for pours that claim a saving (T2).
