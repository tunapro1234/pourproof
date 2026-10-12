# PourProof

PourProof gives every concrete pour a signed passport. The ready-mix supplier, the contractor, the building inspector and the owner
all read the same record. A device inside the pour logs curing temperature and signs the readings in batches with a P-256 key, and
the ledger contract verifies each batch signature on chain. Maturity (Nurse-Saul, ASTM C1074) and an estimated strength range are
computed in code from those readings. When a lower-clinker mix is used, the carbon saving against the baseline mix the contractor
declared before the pour can be claimed on chain exactly once, by one party. Claude reads the delivery ticket photo and the EPD PDF
and proposes field values with their source, and a person confirms them. The AI flags; it never approves.

> **Testnet demo, no real claim.**
> Everything in this repository runs on a local Anvil chain or on Base Sepolia testnet. No carbon saving has been claimed, sold or
> registered anywhere. Strength is shown as an estimated range; the inspector decides.

## Status

Working: the contracts with their tests, the dataset import and the maturity, strength range, CO2 and anomaly calculations
(`packages/core`), the device message format in TypeScript (checked against the Solidity vectors) and the simulated device
replay with its tamper cases (`packages/device`), and the end-to-end chain scenario on a local Anvil (`packages/chain`), whose
recorded state the web app reads, the sample delivery tickets and EPDs (`data/sample-docs`), and the AI layer with its
deterministic checks (`packages/ai`), the web passport with in-browser verification (`apps/web`) and its static snapshot build, and the
passport export as a W3C Verifiable Credential 2.0 signed by the inspector ([Security](#security)).
Base Sepolia is wired up but has not run yet: the role accounts have no test ETH. No live Claude call has been made yet, so the
stored AI responses are handwritten fixtures and say so (see [AI layer](#ai-layer)).

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
- **The parties.** Supplier, contractor, inspector and owner are test accounts on a testnet or local chain.
- **AI responses.** Without an `ANTHROPIC_API_KEY`, the AI package answers from `packages/ai/recorded_responses/` and every
  output says "recorded response". Until the first live call those files are handwritten fixtures, labelled
  "recorded response (handwritten fixture)", with no model named as their author.
- **The carbon saving.** It is a testnet event that shows the single-claim rule. It is not a credit and has no market value.
- **Mixes, volumes and tickets.** The two mixes (GWP ranges from a published cement EPD plus labelled assumptions), the 8 m3
  volumes and the fictional "Sample Ready-Mix Co." tickets are sample values in `data/scenario/inputs.json`; each value names its
  source or says "assumption". The curing curve is the dataset's own concrete (class B25), not the sample mix.

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
docs              STRIDE threat model, Slither output
```

## Contracts

`contracts/src/PourLedger.sol` (inherits `DeviceRegistry.sol`) keeps one record per pour. Roles use OpenZeppelin AccessControl:
`SUPPLIER`, `CONTRACTOR`, `INSPECTOR`, `OWNER`.

| Step | Who | Rule |
|---|---|---|
| `declareBaseline` | contractor | the mix it would have used (GWP range, kg CO2e/m3); only before the pour starts and before any batch (`NotBeforePour`); once |
| `createPour` | supplier | ticket hash, EPD hash, volume (dm3), GWP range of the delivered mix, pour start |
| `acceptPour` | contractor | if a baseline exists, only the contractor who declared it |
| `registerDevice` / `replaceDevice` | inspector only | one P-256 key per pour, kind `esp32` or `simulated` (carried in the event) |
| `appendBatch` | anyone (relay) | device signature checked on chain (`BadSignature`), counter must be the next one (`CounterGap`), batch window inside the pour (`BadBatchWindow`), last reading not after the block time (`FutureBatch`) |
| `approveStrength` | inspector | evidence hash (maturity calculation, break tests if any); needs at least one batch |
| `claimSaving` | the pour's supplier, its contractor, or an owner | needs approval (`StrengthNotApproved`); once per pour, every later call reverts `AlreadyClaimed(pourId, firstClaimant)` |

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

Gas (`forge test --gas-report`, happy path and device tests, solc 0.8.28, optimizer 200 runs). The local test EVM has no P-256
precompile, so `appendBatch` here pays for OpenZeppelin's Solidity P-256 verification. `P256.verify` uses the RIP-7212 precompile
at 0x100 where the chain has one; we have not measured that path yet.

| Function | Median gas | Max gas |
|---|---:|---:|
| declareBaseline | 74,787 | 74,787 |
| createPour | 118,594 | 118,594 |
| acceptPour | 35,587 | 35,587 |
| registerDevice | 98,756 | 98,756 |
| replaceDevice | 45,721 | 45,721 |
| appendBatch (12 readings, Solidity P-256) | 312,446 | 333,022 |
| approveStrength | 55,940 | 55,940 |
| claimSaving | 40,429 | 40,429 |

Contract size: PourLedger 10,603 bytes runtime, 10,893 bytes initcode.

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
| P-001 | contractor declares the baseline mix, supplier creates the pour, inspector registers the simulated device, contractor accepts, 112 batches, inspector approves strength, supplier claims the saving, the contractor's second claim reverts `AlreadyClaimed` |
| P-002 | poured the next day: create, register, accept, batch 0; when batch 1 closes, a batch 1 signed by the P-001 device reverts `BadSignature`; when batch 2 closes, batch 2 sent with batch 1 withheld reverts `CounterGap`; then the honest batch 1 and the other 110 batches. The curing check flags the record, so it gets no approval and no claim |

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
| `scenario/<network>-passport-P-001.json` | the approved pour as a W3C Verifiable Credential 2.0, signed by the inspector (`npm run passport`, below) |
| `apps/web/public/snapshot/<network>.json` | what the web app needs without an RPC: all ledger events, both pours' on-chain state, their signed batches and readings, refused (reverted) transactions, block number |

On Anvil the scenario starts a private node on a free local port at a fixed genesis time (2026-09-10 05:00 UTC) with 12 s per
block, and sets the next block's time (`evm_setNextBlockTimestamp`) to fixed offsets from the readings, so a re-run writes the
same files byte for byte. The log and the snapshot both carry `timeMode` and `timeNote`, and the log has each pour's `pourStart`
and the timing constants. Anvil's default hardfork has the P-256 precompile, so `appendBatch` costs
about 73,000 to 90,000 gas there instead of about 310,000 with the Solidity fallback measured in the contract tests.

On Base Sepolia (public RPC `https://sepolia.base.org` or `BASE_SEPOLIA_RPC`) the scenario first checks that every role account can
pay its share at twice the current gas price. If one cannot, it stops before the first transaction and lists each address with its
shortfall; it does not fall back to Anvil. `npm run roles-keygen -w packages/chain` writes a new `roles.json` (mode 600) when none
exists. Mainnet is not supported.

### Passport credential (W3C VC 2.0)

```sh
npm run passport -w packages/chain -- --network anvil    # after the scenario; writes scenario/anvil-passport-P-001.json
```

`packages/core/src/vc.ts` turns an approved pour into a Verifiable Credential 2.0 (`@context`
`https://www.w3.org/ns/credentials/v2`, type `VerifiableCredential` and `ConcretePourPassport`). The subject holds the pour id,
both mixes, the volume, the embodied CO2 range, the saving range and who claimed it, a curing summary (batches, maturity, strength
checkpoints as ranges labelled "estimated range, inspector decides") and the chain references: chain id, ledger, and the
transaction hashes from baseline to claim. Every value is read from the deployment record, the scenario log and the evidence
package. The inspector signs it with EIP-712 typed data whose domain is the chain and the ledger, the same signature a wallet
makes with `eth_signTypedData_v4`; `verifyPassport` checks it. The method is described in [SECURITY.md](SECURITY.md#passport-credential-w3c-vc-20).

## Security

[SECURITY.md](SECURITY.md) covers assets, trust boundaries, the oracle problem (a signature says "this device measured this",
not "this sensor was in the concrete") with three measures, key management, replay protection, the counter, privacy, a
post-quantum note, the Slither results with a decision for each, and the known limits. [docs/threat-model.md](docs/threat-model.md)
is the STRIDE table.

## AI layer

`packages/ai` asks Claude (`claude-sonnet-5-5`, official `@anthropic-ai/sdk`) to read documents and explain flags. Code checks
every answer, and a person approves it. The AI never approves anything and never produces a number that goes on chain.

| Function | Input | What code checks |
|---|---|---|
| `extractTicket(png)` | delivery ticket photo | each field is `{value, unit, source: {page, quote}}`; the value must sit inside its quote. A photo has no text layer, so a field is at best `needs_review`: a person compares it with the image |
| `extractEpd(pdf)` | EPD PDF | the quote must appear verbatim (whitespace aside) in the `pdftotext` output of the cited page, and the value inside the quote; otherwise the field is `unverified` and its approve button stays locked |
| `explainAnomaly(flags, stats)` | flags and stats from the rule-based check in `packages/core` | text only; every number in it must appear in the stats sent to the model, written the same way, or the explanation is rejected and not shown |

Every output carries `model`, `prompt_sha256` and `mode` (`live` or `recorded`) plus the label the UI shows. `prompt_sha256` is
the sha256 of the canonical request (instructions, output schema, model and the sha256 of the attached file), so it names exactly
what produced an answer. Requests use structured output (a JSON schema) and the API's server-side refusal fallback; when a
fallback model answers, `model` names it.

Without `ANTHROPIC_API_KEY` (read only from the environment) the package answers from `recorded_responses/<prompt_sha256>.json`
and the tests run that way. No live call has been made yet, so the six files there (two tickets, two EPDs, two flag
explanations) are written by hand from the documents and the computed stats, carry `"recording": "handwritten fixture"`, and
name no model as their author. With a key, `npm run record -w packages/ai` sends the same requests once and replaces them with
the real responses. If a document changes, its `prompt_sha256` changes and the tests point out the missing recording.

The two flag explanations use curing records computed by `packages/core`: pour P-002 (its device logged the dataset's air
temperature, flag `no_hydration_signature`) and a constructed case, P-001's signed readings with batch 3 left out (flag `gap`).

```sh
npm test -w packages/ai                      # recorded mode, no key needed
ANTHROPIC_API_KEY=... npm run record -w packages/ai
```

## Web app

`apps/web` (Vite, plain TypeScript, no framework) shows each pour's passport and lets anyone check it in the browser, without a
wallet.

| Page | What it shows |
|---|---|
| `/` | the pours, their curing record, strength approval and claim status |
| `/pour/:id` | the passport: delivered and baseline mix, volume, embodied CO2 range and its EPD source, saving range (baseline vs delivered, next to the ledger's `savingRange`), curing curve, maturity and strength ranges ("estimated range, inspector decides"), the rule-based curing flags with the AI explanation, saving claim status ("Already claimed by supplier" and the refused second claim), roles and signatures timeline, document hashes, AI fields with their source quotes, and a QR code for the page URL |
| `/verify/:id` | every batch: root rebuilt from the readings vs the root on chain, and the P-256 signature |

Verification runs in the browser with `packages/core`. It downloads the published device batches
(`data/pours/<id>/batches.json`), rebuilds each batch's Merkle root from the readings and compares it with the root in the
ledger's `BatchAppended` event, checks every reading on its own with its Merkle proof against that root, rebuilds the signed digest
from on-chain values and checks the P-256 signature against the device key registered on chain. It also hashes the ticket photo,
the EPDs and the evidence package and compares them with `ticketHash`, `epdHash`, the baseline `mixHash` and `evidenceHash`.
Maturity and strength are computed again from the verified readings, and nothing is computed from a record that fails.

`?tamper=reading:<i>` adds 5 degC to reading `i` (counted over the whole pour from 0) after the download, as someone editing the
file would. The page turns red: "Reading <time> does not match the signed root".

Every screen shows the network (local Anvil or Base Sepolia), where the chain state comes from, the device label
("simulated device · replayed from published dataset (Mendeley nmr8pjx8d8, CC BY 4.0)" or "measured by our sensor"), the
"Testnet demo, no real claim" card, and on AI outputs "live" or "recorded response" (today "recorded response (handwritten
fixture)"). On Base Sepolia the page says "readings time-shifted into the past from the published dataset".

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
npm run e2e -w apps/web          # build + Playwright smoke test (passport green, tamper red, second claim refused)
```

### Running it: live mode and snapshot mode

**Live mode** reads a running chain over JSON-RPC. Against a local Anvil:

```sh
anvil --chain-id 31337 --timestamp 1789016400 --accounts 6          # terminal 1, http://127.0.0.1:8545
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
Playwright cache (`PLAYWRIGHT_CHROMIUM_EXECUTABLE` overrides).

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

## License

MIT, see [LICENSE](LICENSE). Dataset content remains under CC BY 4.0 with attribution to its authors.
