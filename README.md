# PourProof

PourProof gives every concrete pour a signed passport. The ready-mix supplier, the contractor, the building inspector and the owner
all read the same record. In the design, a device cast into the pour logs curing temperature and signs the readings in
batches with a P-256 key, and the ledger contract verifies each batch signature on chain. In this demo the device is simulated:
software replays a published lab dataset (Mendeley nmr8pjx8d8, CC BY 4.0), on a local test chain. Maturity (Nurse-Saul,
ASTM C1074) and an estimated strength range are computed in code from those readings. When a leaner mix is used, the carbon
saving against the baseline mix the contractor declared before the pour can be claimed once per pour record on this ledger, by
its supplier, its contractor or an owner. Claude reads the sample ticket photo and sample EPD PDFs and proposes fields with
source quotes. Code checks each EPD quote against the PDF text; photo fields wait for a person, and the AI approves nothing.

**Live demo (static, recorded on-chain state):** https://pourproof.tunapro.xyz/ . Open a pour, then its verify page; add
`?tamper=reading:42` to the verify URL to see a changed reading fail against the signed root.

> **Testnet demo, no real claim.**
> Everything has run only on a local Anvil chain; Base Sepolia is wired up but has not run. No carbon saving has been claimed,
> sold or registered anywhere. Strength is shown as an estimated range; the inspector decides.

## Status

Working: the contracts with their tests, the dataset import and the maturity, strength range, CO2 and anomaly calculations
(`packages/core`), the device message format in TypeScript (checked against the Solidity vectors) and the simulated device
replay with its tamper cases (`packages/device`), and the end-to-end chain scenario on a local Anvil (`packages/chain`), whose
recorded state the web app reads, the sample delivery tickets and EPDs (`data/sample-docs`), and the AI layer with its
deterministic checks (`packages/ai`), the web passport with in-browser verification (`apps/web`) and its static snapshot build, and the
passport export, which uses the W3C VC 2.0 data model with our own EIP-712 proof, signed with the inspector test account's key
([Passport credential](#passport-credential-w3c-vc-20)).
Base Sepolia is wired up but has not run yet: the role accounts have no test ETH. The demo's AI answers were taken once from
`claude-haiku-5-5` in live calls and stored; the app replays them without a key and labels them "recorded response" (see
[AI layer](#ai-layer)).

## Data sources

- **Curing temperature and strength data:** Mendeley Data, dataset `nmr8pjx8d8`, version 1
  (https://data.mendeley.com/datasets/nmr8pjx8d8, DOI 10.17632/nmr8pjx8d8.1), licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Half-hourly temperature history of cylinders and 50 x 50 x 50 cm boxes,
  relative humidity, ambient temperature, lab strength tests by age and the authors' ASTM C1074 maturity columns.
  The raw `Data.xlsx` is not stored here; a script downloads it and writes a normalized JSON file
  (`data/dataset/mendeley-nmr8pjx8d8.json`) that carries the attribution inside it. We changed the format, not the values.
  Regenerate it with `npm run fetch-dataset -w packages/core` (the xlsx is cached in `~/.cache/pourproof`, checked by sha256).
  Paper: Utepov et al., "Complex Maturity Method for Estimating the Concrete Strength Based on Curing Temperature, Ambient
  Temperature and Relative Humidity", Applied Sciences 11(16):7712, 2021 (CC BY 4.0). What the paper states about the mix
  (class B25 / grade M350, specimen sizes, sensors) is in `data/dataset/paper-mix.json` with page and quote; it does not give
  cement type, cement content, water or aggregate, and we do not guess them.
  The box strengths in the dataset are rebound hammer readings; our strength calibration uses the lab cylinder tests.
- **EPD values (GWP A1-A3):** the cement share comes from a published cement EPD (NRMCA EPD No. 20243); cement content and
  the other constituents are labelled assumptions. Every value and its link: `data/sample-docs/README.md`.
- **Delivery ticket and EPD documents in the demo:** sample documents made for this project (`data/sample-docs`), watermarked
  "SAMPLE - NOT A REAL DOCUMENT", from a fictional "Sample Ready-Mix Co.". No real company is named on them. On chain,
  `ticketHash`, `epdHash` and the baseline's `mixHash` are the sha256 of these files.

## What is simulated

- **The device.** Unless a screen says "measured by our sensor", the readings come from a software device that replays the
  published Mendeley dataset and signs it with a key generated on this machine. Every screen labels it:
  "simulated device · replayed from published dataset (Mendeley nmr8pjx8d8, CC BY 4.0)".
- **Time.** Replay runs faster than real time. Each reading's timestamp is the pour's recorded start plus the hour in the dataset.
  On local Anvil the scenario moves the chain clock forward; on Base Sepolia the readings are time-shifted into the past (see
  [Chain scenario](#chain-scenario)).
- **The parties.** Supplier, contractor, inspector and owner are test accounts. On Anvil they are Anvil's default dev accounts,
  whose keys are public. One script of ours sent every role's transactions.
- **AI responses.** Without an `ANTHROPIC_API_KEY`, the AI package answers from `packages/ai/recorded_responses/` and every
  output says "recorded response". Those files are real `claude-haiku-5-5` answers, recorded once from live calls with
  `npm run record -w packages/ai`; the demo makes no live call.
- **The carbon saving.** It is a testnet event that shows the single-claim rule. It is not a credit and has no market value.
- **Mixes, volumes and tickets.** The two mixes (GWP ranges from a published cement EPD plus labelled assumptions), the 8 m3
  volumes and the fictional "Sample Ready-Mix Co." tickets are sample values in `data/scenario/inputs.json`; each value names its
  source or says "assumption". The curing curve is from the published dataset, class B25, not the delivered mix.

## Carbon accounting

- Inventory, delivered mix: absolute A1-A3 footprint (cradle-to-gate).
- The saving is an avoided-emissions estimate against the contractor's declared baseline (A1-A3 only, not checked against a
  market-average mix), reported separately from the inventory and never subtracted from it.
- What must not be counted twice is a saving that gets sold or awarded: the saving against baseline in a tender, an award or a
  certificate. The ledger records that claim once. (This is our rule; WBCSD's 2023 guidance allows several value-chain companies
  to report the same avoided emissions.)
- If the saving is ever issued as a certificate, the buyer of the concrete reports the delivered mix at the baseline value
  (Isometric draft protocol rule).

## Repository layout

```
contracts/        Foundry project (Solidity 0.8.28, OpenZeppelin Contracts v5)
packages/core     maturity, strength range, CO2 ranges, message hashing, passport credential (VC 2.0)
packages/device   simulated device: dataset replay, P-256 batch signing
packages/ai       Claude extraction for tickets and EPDs, anomaly explanation
packages/chain    deploy and demo scenario scripts (viem)
apps/web          pour passport and in-browser verification; build:snapshot writes the static site
data/dataset      normalized Mendeley dataset (CC BY 4.0) and what the paper states about its mix
data/scenario     sample values for the two demo pours, each with a source or an "assumption" label
data/sample-docs  sample delivery tickets (PNG) and EPDs (PDF), with the script that builds them
data/pours        the simulated device's signed batches per pour
docs              STRIDE threat model, Slither output, forge gas report
```

## Contracts

`contracts/src/PourLedger.sol` (inherits `DeviceRegistry.sol`) keeps one record per pour. Roles use OpenZeppelin AccessControl:
`SUPPLIER`, `CONTRACTOR`, `INSPECTOR`, `OWNER`.

| Step | Who | Rule |
|---|---|---|
| `declareBaseline` | contractor | the mix it would have used (GWP range, kg CO2e/m3); only before the pour starts and before any batch (`NotBeforePour`); once |
| `createPour` | supplier | ticket hash, EPD hash, volume (dm3), GWP range of the delivered mix, pour start; a ticket hash already used by another pour reverts `TicketReused(ticketHash, firstPourId)` |
| `acceptPour` | contractor | if a baseline exists, only the contractor who declared it |
| `registerDevice` / `replaceDevice` | inspector only | one P-256 key per pour, kind `esp32` or `simulated` (carried in the event) |
| `appendBatch` | anyone (relay) | device signature checked on chain (`BadSignature`), counter must be the next one (`CounterGap`), batch window inside the pour (`BadBatchWindow`), last reading not after the block time (`FutureBatch`) |
| `approveStrength` | inspector | evidence hash (maturity calculation, break tests if any); needs at least one batch |
| `claimSaving` | the pour's supplier, its contractor, or an owner | needs approval (`StrengthNotApproved`); once per pour record, every later call reverts `AlreadyClaimed(pourId, firstClaimant)` |

Saving on chain: low = (baselineLow - gwpHigh) x m3, high = (baselineHigh - gwpLow) x m3, in kg CO2e, rounded down, negative ends
shown as 0 (volume is stored in dm3, 1 m3 = 1000 dm3). The off-chain `saving()` in `packages/core` keeps a negative low end
so the screen can show when the ranges overlap.

Device message (same in Solidity and TypeScript):

- reading leaf: `keccak256(bytes.concat(0x00, abi.encode(uint64 t_unix, int32 temp_milliC)))`
- internal node: `keccak256(bytes.concat(0x01, min(a, b), max(a, b)))`; leaves in reading order, an odd last node is carried up.
  Proofs verify with OpenZeppelin `MerkleProof.verify(proof, root, leaf, BatchMessage.node)`.
  Why the 0x00 / 0x01 prefixes (as in RFC 6962): without them a leaf and an internal node are both keccak of 64 bytes, so an internal node could be presented as a reading.
- signed digest: `sha256(abi.encode("POURPROOF_BATCH_V1", chainId, ledger, pourId, counter, fromTs, toTs, root))`, P-256, low-s.
  The chain id, ledger address and pour id are inside the digest, so a batch signed for one pour or chain is rejected on another.

`contracts/test/vectors.json` holds 3 signed batches built from the first 36 Box 1 readings of the dataset. They are signed with a
**test-only key**: sha256 of a public seed string that is written in the file, so anyone can rebuild it. It is never used for
real data. The signatures are deterministic (RFC 6979); `forge script script/GenVectors.s.sol` (run inside `contracts/`)
regenerates the file and `test/Vectors.t.sol` fails if it is out of date.

Tests: unit tests for every revert above, fuzz tests (random wrong keys cannot append, saving range is ordered and exact) and
handler-based invariants (`invariant_atMostOneSavingClaimedPerPour`, `invariant_counterMonotone`, `invariant_wrongKeyNeverAppends`).

Gas per function, from the contract tests and from the Anvil scenario: [Gas](#gas).

## Simulated device

`packages/core/src/batch.ts` builds the same bytes as `contracts/src/BatchMessage.sol`: reading leaf, batch Merkle root, per-reading
Merkle proof and the signed digest. `packages/core/test/vectors.test.ts` rebuilds `contracts/test/vectors.json` (written by the
Solidity side) value for value, and `contracts/test/proofs.json` (written by the TypeScript side) is checked in Solidity with
OpenZeppelin `MerkleProof.verify` and the prefixed node hash.

`packages/device` is the software device. It does not measure anything; it replays a series from the published dataset.

```sh
npm run keygen -w packages/device -- P-001     # P-256 key -> $POURPROOF_SECRETS/devices/P-001.json, mode 600
npm run keygen -w packages/device -- P-002
npm run replay -w packages/device               # options: --chain-id --ledger --block-time | --pour-start
```

`replay` writes:

| File | What it holds |
|---|---|
| `data/pours/P-001/batches.json` | Box 1 (50 cm block), 1344 readings in 112 six-hour batches of 12, each batch root signed; per reading its leaf and Merkle proof |
| `data/pours/P-002/batches.json` | the ambient air series replayed as if it were concrete; signatures are valid, the curing check flags `no_hydration_signature` |
| `data/pours/P-002/tamper.json` | two attempts against P-002: batch 1 withheld so batch 2 follows batch 0 (`CounterGap`), and batch 1 signed by the P-001 device (`BadSignature`) |

Each reading's time is `pourStart + dataset hour x 3600` and its temperature is in milli-degC. The ledger refuses a batch whose
last reading is after the block time (`FutureBatch`), so on a chain whose clock cannot be moved a replay puts the pour in the past:
`pourStart = block time - dataset duration (28 days) - 1 h`, using `--block-time` (the Base Sepolia scenario passes its latest
block) or the clock at replay time. Each file records the block time it used (`replayBlockTime`, null when the chain clock was
advanced instead) and the rule (`pourStartRule`). Every file carries
`deviceKind: "simulated"` and `source: "replayed from published dataset (Mendeley nmr8pjx8d8, CC BY 4.0)"`, plus the public key;
private keys stay in `$POURPROOF_SECRETS`. Chain id and ledger address are part of every signed digest; the committed files are
the batches the Anvil scenario below signed and sent (chain 31337, ledger `0x5FbDB2315678afecb367f032d93F642f64180aa3`, time
advanced, P-002 poured 27 h after P-001).
`predictAppend` mirrors the ledger's checks offline to say which revert to expect; the chain decides.

## Chain scenario

```sh
npm run scenario -w packages/chain -- --network anvil          # starts its own Anvil, runs everything, stops it
npm run scenario -w packages/chain -- --network baseSepolia    # role keys from $POURPROOF_SECRETS/roles.json
```

One run deploys `PourLedger`, grants the four roles, replays both devices for that ledger and then sends, as real transactions:

- **Time, two modes:** on local Anvil the scenario moves the chain clock forward (`timeMode: "advanced"`: baseline, pour record,
  device and acceptance before `pourStart`, each batch 120 s after its last reading, approval after the last batch); on Base
  Sepolia the clock cannot be moved, so the readings are time-shifted into the past (`timeMode: "backdated"`) and the chain order
  (`NotBeforePour`) shows the baseline came before the pour.


| Pour | Steps |
|---|---|
| P-001 | contractor declares the baseline mix, supplier creates the pour, inspector registers the simulated device, contractor accepts; a second pour record (P-003) carrying P-001's delivery ticket reverts `TicketReused`; 112 batches, inspector approves strength, supplier claims the saving, the contractor's second claim reverts `AlreadyClaimed` |
| P-002 | poured the next day: the contractor declares the same baseline mix, then create, register, accept, batch 0; when batch 1 closes, a batch 1 signed by the P-001 device reverts `BadSignature`; when batch 2 closes, batch 2 sent with batch 1 withheld reverts `CounterGap`; then the honest batch 1 and the other 110 batches. The curing check flags the record, so it gets no approval, and the supplier's claim reverts `StrengthNotApproved` |

Calls meant to fail are simulated first and then sent anyway, so the revert is on chain with its own transaction hash. The
inspector's `evidenceHash` is the sha256 of `scenario/<network>-evidence-P-001.json`: maturity and the strength range computed by
`packages/core` from the signed readings, the calibration behind it, the anomaly result, the saving range, and the AI outputs
behind the ticket and EPD fields (model, `prompt_sha256`, mode and how many fields passed each check; read in recorded mode so
the file is the same on every run). `sha256sum` the file to check it.

Output:

| File | What it holds |
|---|---|
| `deployments/<network>.json` | ledger address, deploy tx and block, role addresses |
| `scenario/<network>-log.json` | every step: role, account, function, arguments, tx hash, block, time, gas, decoded events, revert name and arguments |
| `scenario/<network>-evidence-P-001.json` | the evidence package behind `approveStrength` |
| `scenario/<network>-passport-P-001.json` | the approved pour as a credential in the W3C VC 2.0 data model with our own EIP-712 proof, signed with the inspector test account's key (`npm run passport`, below) |
| `apps/web/public/snapshot/<network>.json` | what the web app needs without an RPC: all ledger events, both pours' on-chain state, their signed batches and readings, refused (reverted) transactions, block number |

On Anvil the scenario starts a private node on a free local port at a fixed genesis time (2026-09-10 05:00 UTC) with 12 s per
block, and sets the next block's time (`evm_setNextBlockTimestamp`) to fixed offsets from the readings, so a re-run writes the
same files byte for byte. The log and the snapshot both carry `timeMode` and `timeNote`, and the log has each pour's `pourStart`
and the timing constants. What each transaction cost is in [Gas](#gas).

On Base Sepolia (public RPC `https://sepolia.base.org` or `BASE_SEPOLIA_RPC`) the scenario first checks that every role account can
pay its share at twice the current gas price. If one cannot, it stops before the first transaction and lists each address with its
shortfall; it does not fall back to Anvil. `npm run roles-keygen -w packages/chain` writes a new `roles.json` (mode 600) when none
exists. Mainnet is not supported.

### Passport credential (W3C VC 2.0)

```sh
npm run passport -w packages/chain -- --network anvil    # after the scenario; writes scenario/anvil-passport-P-001.json
```

`packages/core/src/vc.ts` turns an approved pour into a credential that uses the W3C VC 2.0 data model with our own EIP-712 proof
(`@context` `https://www.w3.org/ns/credentials/v2`, type `VerifiableCredential` and `ConcretePourPassport`). The subject holds the
pour id, both mixes, the volume, the embodied CO2 range, the saving range and who claimed it, a curing summary (batches, maturity,
strength checkpoints as ranges labelled "estimated range, inspector decides") and the chain references: chain id, ledger, and the
transaction hashes from baseline to claim. Every value is read from the deployment record, the scenario log and the evidence
package. It is signed with the inspector test account's key as EIP-712 typed data whose domain is the chain and the ledger, the
same signature a wallet makes with `eth_signTypedData_v4`; `verifyPassport` checks it. The method is described in
[SECURITY.md](SECURITY.md#passport-credential-w3c-vc-20).

In the committed Anvil run the inspector is Anvil dev account 0x90f7...b906, whose key comes from Anvil's public test mnemonic, so
anyone can make this signature. It shows the credential format, not who approved.

## Gas

Two measurements, neither from a public chain.

**Local Anvil scenario, P-256 precompile.** The scenario starts Anvil with `--hardfork osaka`, which has the P-256 verification
precompile at address 0x100 (EIP-7951). OpenZeppelin's `P256.verify` calls the precompile first and falls back to its Solidity
implementation when the precompile is absent. The scenario stops if its first `appendBatch` uses more than 150,000 gas, so a run
on a chain without the precompile does not pass quietly. `gasUsed` of every transaction in `scenario/anvil-log.json` (the
committed run, 244 transactions):

| Function | Transactions | Median gas | Max gas |
|---|---:|---:|---:|
| deploy PourLedger | 1 | 2,404,351 | 2,404,351 |
| grantRole | 4 | 51,543 | 51,543 |
| declareBaseline | 2 | 74,787 | 74,787 |
| createPour | 2 | 140,880 | 140,880 |
| createPour, reverts `TicketReused` | 1 | 30,939 | 30,939 |
| registerDevice | 2 | 98,750 | 98,756 |
| acceptPour | 2 | 35,565 | 35,565 |
| appendBatch (12 readings) | 224 | 73,064 | 90,152 |
| appendBatch, reverts `BadSignature` | 1 | 52,569 | 52,569 |
| appendBatch, reverts `CounterGap` | 1 | 36,235 | 36,235 |
| approveStrength | 1 | 55,985 | 55,985 |
| claimSaving | 1 | 40,221 | 40,221 |
| claimSaving, reverts `AlreadyClaimed` | 1 | 26,473 | 26,473 |
| claimSaving, reverts `StrengthNotApproved` | 1 | 26,457 | 26,457 |

The first batch of a pour costs the most because it writes the pour's counter for the first time. A refused transaction still
pays for the work done before the revert.

**Contract tests, Solidity P-256.** `forge test --gas-report` on the happy path and device tests (forge 1.5.1, solc 0.8.28,
optimizer 200 runs); the command and its full output are in [docs/gas-report.txt](docs/gas-report.txt). The contract tests
compile and run for the Prague hardfork (`evm_version = "prague"` in contracts/foundry.toml), which has no P-256 precompile, so
they take OpenZeppelin's Solidity path. `appendBatch` here costs about four times the precompile cost above.

| Function | Median gas | Max gas |
|---|---:|---:|
| declareBaseline | 74,787 | 74,787 |
| createPour | 140,856 | 140,856 |
| acceptPour | 35,565 | 35,565 |
| registerDevice | 98,756 | 98,756 |
| replaceDevice | 45,721 | 45,721 |
| appendBatch (12 readings, Solidity P-256) | 313,124 | 333,000 |
| approveStrength | 55,985 | 55,985 |
| claimSaving | 40,407 | 40,407 |

Contract size: PourLedger 10,739 bytes runtime, 11,029 bytes initcode (the report's deployment size, 11,061 bytes, adds the
32-byte constructor argument).

## Security

[SECURITY.md](SECURITY.md) covers assets, trust boundaries, the oracle problem (a signature says "this device measured this",
not "this sensor was in the concrete") with three measures, key management, replay protection, the counter, privacy, a
post-quantum note, the Slither results with a decision for each, and the known limits. [docs/threat-model.md](docs/threat-model.md)
is the STRIDE table.

## AI layer

`packages/ai` asks Claude (`claude-haiku-5-5`, official `@anthropic-ai/sdk`) to read documents and explain flags. Code checks
every answer, and a person approves it. The AI never approves anything and never produces a number that goes on chain.

| Function | Input | What code checks |
|---|---|---|
| `extractTicket(png)` | delivery ticket photo | each field is `{value, unit, source: {page, quote}}`; the value must sit inside its quote. A photo has no text layer, so a field is at best `needs_review`: a person compares it with the image |
| `extractEpd(pdf)` | EPD PDF | the quote must appear verbatim (whitespace aside) in the `pdftotext` output of the cited page, and the value inside the quote; otherwise the field is `unverified` and its approve button stays locked |
| `explainAnomaly(flags, stats)` | flags and stats from the rule-based check in `packages/core` | text only; every number in it must appear in the stats sent to the model, written the same way, or the explanation is rejected and not shown |

Every output carries `model`, `prompt_sha256` and `mode` (`live` or `recorded`) plus the label the UI shows. `prompt_sha256` is
the sha256 of the canonical request (instructions, output schema, model and the sha256 of the attached file), so it names exactly
what produced an answer. Requests use structured output (a JSON schema) and adaptive thinking. The fixed part of each task's
request (instructions, then the output schema) comes first and ends in a prompt cache breakpoint, so repeated calls read it from
the cache. Haiku 5.5 has no server-side refusal fallback: a declined request stops with `AiRefused` and no other model answers.

Without `ANTHROPIC_API_KEY` (read only from the environment) the package answers from `recorded_responses/<prompt_sha256>.json`
and the tests run that way. The six files there (two tickets, two EPDs, two flag explanations) are what `claude-haiku-5-5`
returned when `npm run record -w packages/ai` sent the demo's requests once with a key; each carries `"recording": "live call"`
and the model that answered. The record script runs under the spending cap below (8 USD a month, 1 USD a day) and stops when
it is reached. If a document changes, its `prompt_sha256` changes and the tests point out the missing recording.

The two flag explanations use curing records computed by `packages/core`: pour P-002 (its device logged the dataset's air
temperature, flag `no_hydration_signature`) and a constructed case, P-001's signed readings with batch 3 left out (flag `gap`).

```sh
npm test -w packages/ai                      # recorded mode, no key needed, no network
ANTHROPIC_API_KEY="$(cat <key file>)" npm run record -w packages/ai
```

**Spending cap, in code.** Each live call is priced from `response.usage` (Haiku 5.5: 0.10 USD per million input tokens and
0.50 per million output tokens for prompts up to 100K tokens, 0.50 and 2.50 above; cache reads 0.1x and 5 minute cache writes
1.25x the input rate) and added to a counter outside the repository: `~/.cache/pourproof/ai-spend.json`, or the path in
`POURPROOF_AI_SPEND` (a path inside the repository is refused). The counter keeps a total per UTC month and per UTC day and one
line per call (task, `prompt_sha256`, token counts, cost). Before every call the totals are checked: at 8 USD for the month or
1 USD for the day the call is not made and `BudgetExceeded` is thrown. Nothing falls back to recorded responses; `npm run record`
prints the spend so far and stops there, leaving the requests not yet sent with their current recordings. The caps are constants
in `packages/ai/src/budget.ts`; `POURPROOF_AI_MONTH_CAP_USD` and `POURPROOF_AI_DAY_CAP_USD` can lower them, never raise them.
The key is read only from `ANTHROPIC_API_KEY`; it is not written to the counter, the recordings or any log, and an error that
carries it is shown with `[redacted]` in its place.

## Web app

`apps/web` (Vite, plain TypeScript, no framework) shows each pour's passport and lets anyone check it in the browser, without a
wallet.

| Page | What it shows |
|---|---|
| `/` | the pours, their curing record, strength approval and claim status |
| `/pour/:id` | the passport: delivered and baseline mix, volume, embodied CO2 range and its EPD source, saving range (baseline vs delivered, next to the ledger's `savingRange`), curing curve (published dataset, class B25, not the delivered mix), maturity and strength ranges ("estimated range, inspector decides"), the rule-based curing flags with the AI explanation, saving claim status ("Already claimed by supplier" and the refused second claim), roles and signatures timeline, document hashes, AI fields with their source quotes, and a QR code for the page URL |
| `/verify/:id` | every batch: root rebuilt from the readings vs the root on chain, and the P-256 signature |

Verification runs in the browser with `packages/core`. It downloads the published device batches
(`data/pours/<id>/batches.json`), rebuilds each batch's Merkle root from the readings and compares it with the root in the
ledger's `BatchAppended` event, checks every reading on its own with its Merkle proof against that root, rebuilds the signed digest
from on-chain values and checks the P-256 signature against the device key registered on chain. It also hashes the ticket photo,
the EPDs and the evidence package and compares them with `ticketHash`, `epdHash`, the baseline `mixHash` and `evidenceHash`.
Maturity and strength are computed again from the verified readings, and nothing is computed from a record that fails.

`?tamper=reading:<i>` adds 5 degC to reading `i` (counted over the whole pour from 0) after the download, as someone editing the
file would. The page turns red: "Reading <time> does not match the signed root". `?tamper=reading:<i>:<d>` changes it by `d`
degC, and `?tamper=night:<n>:<d>` changes every reading of the pour's n-th night (18:00 to 06:00 local time); `d` is a whole
number from -10 to 10, not 0, and anything else opens the page untouched. The passport's "Fake a warm night" card builds these
links: it shows what the edited copy would claim (the same strength code on the edited readings, next to the signed ones),
that the record then supports no saving, and that nothing on chain changed. Its trust note names the snapshot block and the
snapshot file's sha256, computed when the site is built: on the static site the chain state and the readings come from the
same server, so the check shows that an edited reading cannot match its signed root, not that the server is honest
([Trust model](#trust-model)).

Every screen shows the network (local Anvil or Base Sepolia), where the chain state comes from, the device label
("simulated device · replayed from published dataset (Mendeley nmr8pjx8d8, CC BY 4.0)" or "measured by our sensor"), the
"Testnet demo, no real claim" card, and on AI outputs "live" or "recorded response" (the demo shows "recorded response":
answers recorded from `claude-haiku-5-5`, replayed without a key). On Base Sepolia the page says "readings time-shifted into the past from the published dataset".

Two modes:

- **snapshot** (default): chain state from `public/snapshot/<network>.json`, labelled "recorded on-chain state, block N".
- **live**: `?mode=live` (optionally `&rpc=<url>&ledger=<address>`, or `VITE_POURPROOF_MODE`, `VITE_POURPROOF_RPC` at build
  time) reads events and state over JSON-RPC with viem. A reverted transaction leaves no log, so live mode asks the node what a
  second `claimSaving` by the other parties would do (`eth_call`, nothing is sent) and labels it as a simulated call.

The published files the chain commits to are served under `/published/<repo path>` and copied into the build. The AI outputs on
screen are `public/ai/outputs.json`, written by `npm run export-ai -w apps/web` from `packages/ai` in recorded mode.

```sh
npm run dev -w apps/web          # http://localhost:5173
npm test -w apps/web             # verification, tamper, ABI vs forge output, AI file, and a live read of a fresh Anvil run
npm run build -w apps/web
npm run e2e -w apps/web          # build + Playwright: passport green, tamper red, second claim refused, "Fake a warm night" card
```

### Running it: live mode and snapshot mode

**Live mode** reads a running chain over JSON-RPC. Against a local Anvil:

```sh
anvil --chain-id 31337 --timestamp 1789016400 --hardfork osaka --accounts 6   # terminal 1, http://127.0.0.1:8545
npm run scenario -w packages/chain -- --network anvil --rpc http://127.0.0.1:8545   # terminal 2
npm run dev -w apps/web
# open http://localhost:5173/?mode=live
```

With `--rpc` the scenario runs on that node and keeps it, and it rewrites `deployments/anvil.json`, `scenario/anvil-log.json`,
the evidence package and the snapshot for that run (`git checkout -- deployments scenario apps/web/public/snapshot` brings back the
committed ones). The ledger address comes from `deployments/anvil.json`; `?rpc=<url>&ledger=<address>` points the page at another node or
ledger, and `?network=baseSepolia&mode=live` reads Base Sepolia through `https://sepolia.base.org`. To make live the default
in a build, set `VITE_POURPROOF_MODE=live` (and `VITE_POURPROOF_NETWORK`, `VITE_POURPROOF_RPC`) before `npm run build`.

**Snapshot mode** needs no node. In dev and in the normal build it is the default (`/?mode=snapshot`). The static site is a
snapshot-only build:

```sh
npm run build:snapshot -w apps/web     # writes apps/web/dist-snapshot/
npm run preview:snapshot -w apps/web   # serves it on http://localhost:4317
npm run e2e:snapshot -w apps/web       # builds it and runs the Playwright tests against it
```

`dist-snapshot/` is a plain folder of files for any static host, served at `/` (the site uses root paths such as
`/assets/`, `/snapshot/`, `/published/`). It reads only `snapshot/<network>.json` and the published files copied next to it, and
it shows AI outputs only as recorded responses: the build stops if `public/ai/outputs.json` holds a live one. `?mode=live`,
`?rpc` and `?ledger` are ignored there. Every HTML file (`index.html`, `pour/<id>/index.html`, `verify/<id>/index.html` and
`404.html` for any other path) says "recorded on-chain state, block N" in its markup before any script runs, and the app
shows the same label on every page. The build also scans its output and fails on anything that looks like an API key or a
private key. Nothing in it needs a secret: verification runs in the reader's browser against the recorded chain state.

The live test starts a private Anvil, runs the scenario on it and checks that the live reader sees exactly the snapshot's events
and state. The e2e test uses Playwright's Chromium; if that exact build is not installed, it uses the newest headless shell in the
Playwright cache (`PLAYWRIGHT_CHROMIUM_EXECUTABLE` overrides). It runs one worker and starts Chromium with `--disable-gpu` and
`--disable-software-rasterizer`, because it runs on a shared server without a GPU and the app draws no WebGL.

## Trust model

What you have to trust depends on where the page gets the chain state.

- **The static demo (snapshot mode).** The readings, the batch roots and the device key all come from the same server: the
  snapshot file (`snapshot/anvil.json`) and the published batch files next to it. The browser rebuilds every Merkle root and
  checks every P-256 signature against the key registered on chain, so it proves that the readings on screen are the ones that
  key signed. Change one reading and its batch no longer matches its signed root; the "Fake a warm night" card shows this. It does
  not prove that the server is honest: whoever serves the site could replace readings, roots and key together with a fake that
  agrees with itself. The page names the snapshot's block and sha256, so the file can be compared with the one in this repository:
  the committed `apps/web/public/snapshot/anvil.json` is block 244, sha256
  `bcd77819fc08e3318d195b4e0eaaf545b30f04444684021728c7ba9a7a6cde42`.
- **Re-running it yourself.** `npm run scenario` on your own Anvil, then `npm run dev` with `?mode=live`, re-runs the whole
  pipeline with your own device and role keys. It checks that the code does what this README says. It does not check our
  recorded record, which came from a local Anvil node that is now stopped. Only a run on a public chain (Base Sepolia: wired up,
  not run yet) would give a reader a record we cannot swap. The commands are in
  [Running it](#running-it-live-mode-and-snapshot-mode).
- **In both modes** a valid signature proves the key, not the concrete: see the oracle problem in
  [SECURITY.md](SECURITY.md#the-oracle-problem). Approving strength stays with the inspector, and acceptance with the 28-day
  specimens.

## Known limits

- **Simulated device.** Every reading is replayed by software from the published dataset. No sensor of ours has been in concrete.
- **Calibration is per mix.** The strength fit comes from the dataset's class B25 concrete, not from the delivered mix. ASTM C1074
  calibrates each mix before its maturity says anything about strength, so the range on screen shows the method, not the strength
  of Mix B. Acceptance stays with the 28-day specimens.
- **The saving rests on samples.** Both mixes take their cement factor from one published cement EPD, with an assumed cement content
  (380 and 320 kg/m3) and assumed other constituents. The EPD documents in the demo are watermarked samples.
- **The saving range is not an error bar.** P-001's range on chain, 512 to 840 kg CO2e, comes from the other constituents counted
  at their low and high ends on both sides. It says nothing about measurement uncertainty.
- **The record backs only part of the saving.** Using less cement is the part a strength record can back, once the mix is
  calibrated. The cement type (Type IL instead of Type I/II) is declared by the supplier's EPD; no curing record can prove it.
- **US-PCR, not EN 15804.** The cement factors come from an EPD under ISO 21930 and the NSF PCR, including transport to the US
  market. A European claim would need EN 15804 EPDs.
- **Local chain only.** Everything has run on a local Anvil chain. Base Sepolia is wired up but has not run, so there is no
  public testnet record yet.
- **Once per pour record.** A second pour carrying the same ticket hash is refused (`TicketReused`), but any owner-role account
  can claim any pour, and claims made in other registries are invisible to it.
- **No delivery deadline.** A batch can be appended any time after its readings, so the chain shows when a batch was committed,
  not when it was measured. A maximum-delay check is a next step.
- **The curing check is a filter.** The rule-based curing check catches open air, not a heated bucket; nothing on chain reads its
  flag: the inspector decides.

Security limits (one admin key, a trusted inspector, no audit) are in [SECURITY.md](SECURITY.md#known-limits).

## Setup

Requirements: Node 22, npm, git, Foundry, `pdftotext` and `pdfinfo` (poppler-utils, for the EPD check).

```sh
git clone --recurse-submodules <repo-url> pourproof && cd pourproof
# if already cloned: git submodule update --init --recursive
curl -L https://foundry.paradigm.xyz | bash && foundryup
npm install
cp .env.example .env        # all keys are optional for local runs

forge build --root contracts
forge test --root contracts
npm test
```

Environment variables (`.env.example`):

| Name | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | live AI extraction; without it recorded responses are used |
| `BASE_SEPOLIA_RPC` | Base Sepolia RPC, defaults to the public endpoint |
| `POURPROOF_SECRETS` | directory outside the repo holding role keys (`roles.json`) and device keys (`devices/`) |

Private keys never go into the repository.

## How we built it

One npm workspaces monorepo (Node 22, strict TypeScript) and one Foundry project:

- `contracts/`: Solidity 0.8.28 on OpenZeppelin Contracts v5 (AccessControl, `P256`, `MerkleProof`), with Foundry unit, fuzz
  and invariant tests.
- `packages/core`: the parts every other piece shares, as pure functions: Nurse-Saul maturity, the strength fit, CO2 ranges,
  leaf and node hashing, the signed digest, the passport credential.
- `packages/device` and `packages/chain`: the replaying device, and the deploy and scenario scripts, both on viem.
- `packages/ai`: the Claude calls and the deterministic checks around them.
- `apps/web`: Vite and plain TypeScript, tested with Vitest and Playwright.

The code was written with an AI coding assistant; every commit in this repository carries its author name, `pourproof-builder`.
Much of the research, planning and review was also done with AI assistants (Claude).
The student team reviews and approves the submission before it is sent. Every piece of work came with acceptance checks
(tests, page checks, a scan for keys) that had to pass before it counted as done. Inside the product the Claude API (`claude-haiku-5-5`) has two narrow jobs, reading fields from
the delivery ticket and the EPDs and putting a curing flag into words. Its answers were recorded once from live calls and are
replayed ([AI layer](#ai-layer)).

## Next steps

- **Link the 28-day specimens.** Acceptance rests on specimen tests at 28 days. In Turkey, specimens from buildings inspected
  under the building inspection law (Law 4708) are already tracked from site to lab in EBIS, the ministry's electronic concrete
  monitoring system: each specimen carries an electronic tag, and the lab approves its test report in the system. The next step
  is to put that result's hash into the evidence package next to the maturity estimate, not to replace it.
- **Cap the baseline.** Today the contractor's declared baseline is used as is. A regional benchmark for the same strength class
  would cap it, so an inflated baseline cannot inflate the saving.
- **A delivery deadline for batches.** Refuse a batch whose last reading is older than a set delay, so the chain bounds how
  long a record can wait before it is committed.
- **A public testnet run.** Fund the role accounts and run the scenario on Base Sepolia, so anyone can read the record from a
  public chain instead of a snapshot.
- **A real device.** An ESP32 with a DS18B20 probe signing with P-256, then a secure element so the key never leaves the chip
  ([SECURITY.md](SECURITY.md#key-management)).
- **IEEE P3828.** The passport uses the W3C VC 2.0 data model and is kept close to the direction of IEEE P3828
  (Draft Standard for Digital Product Passport - Reference Architecture and Technical Requirements; an active project, not
  yet a published standard). We claim no conformance; that needs the final text and a test against it.

## License

MIT, see [LICENSE](LICENSE). Dataset content remains under CC BY 4.0 with attribution to its authors.
