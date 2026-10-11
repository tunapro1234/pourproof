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
replay with its tamper cases (`packages/device`). Not built yet: AI extraction, the deploy scenario and the web passport.

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
- **EPD values (GWP A1-A3):** published EPD ranges, listed with links in `data/sample-docs/README.md`.
- **Delivery ticket and EPD documents in the demo:** sample documents made for this project, watermarked
  "SAMPLE - NOT A REAL DOCUMENT". No real company is named.

## What is simulated

- **The device.** Unless a screen says "measured by our sensor", the readings come from a software device that replays the
  published Mendeley dataset and signs it with a key generated on this machine. Every screen labels it:
  "simulated device · replayed from published dataset (Mendeley nmr8pjx8d8, CC BY 4.0)".
- **Time.** Replay runs faster than real time. Each reading's timestamp is the pour's recorded start plus the hour in the dataset.
- **The parties.** Supplier, contractor, inspector and owner are test accounts on a testnet or local chain.
- **AI responses.** Without an `ANTHROPIC_API_KEY`, the AI package uses responses recorded from an earlier real call, and the UI
  says "recorded response".
- **The carbon saving.** It is a testnet event that shows the single-claim rule. It is not a credit and has no market value.

## Repository layout

```
contracts/        Foundry project (Solidity 0.8.28, OpenZeppelin Contracts v5)
packages/core     maturity, strength range, CO2 ranges, message hashing
packages/device   simulated device: dataset replay, P-256 batch signing
packages/ai       Claude extraction for tickets and EPDs, anomaly explanation
packages/chain    deploy and demo scenario scripts (viem)
apps/web          pour passport and in-browser verification
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
| `appendBatch` | anyone (relay) | device signature checked on chain (`BadSignature`), counter must be the next one (`CounterGap`) |
| `approveStrength` | inspector | evidence hash (maturity calculation, break tests if any); needs at least one batch |
| `claimSaving` | the pour's supplier, its contractor, or an owner | needs approval (`StrengthNotApproved`); once per pour, every later call reverts `AlreadyClaimed(pourId, firstClaimant)` |

Saving on chain: low = (baselineLow - gwpHigh) x m3, high = (baselineHigh - gwpLow) x m3, in kg CO2e, rounded down, negative ends
shown as 0 (volume is stored in dm3, 1 m3 = 1000 dm3). The off-chain `saving()` in `packages/core` keeps a negative low end
so the screen can show when the ranges overlap.

Device message (same in Solidity and TypeScript):

- reading leaf: `keccak256(abi.encode(uint64 t_unix, int32 temp_milliC))`
- batch root: OpenZeppelin `MerkleProof`-compatible tree (pairs hashed sorted), leaves in reading order, an odd last node is carried up
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
| appendBatch (12 readings, Solidity P-256) | 312,753 | 332,279 |
| approveStrength | 55,940 | 55,940 |
| claimSaving | 40,429 | 40,429 |

Contract size: PourLedger 10,866 bytes.

## Simulated device

`packages/core/src/batch.ts` builds the same bytes as `contracts/src/BatchMessage.sol`: reading leaf, batch Merkle root, per-reading
Merkle proof and the signed digest. `packages/core/test/vectors.test.ts` rebuilds `contracts/test/vectors.json` (written by the
Solidity side) value for value, and `contracts/test/proofs.json` (written by the TypeScript side) is checked in Solidity with
OpenZeppelin `MerkleProof.verify`.

`packages/device` is the software device. It does not measure anything; it replays a series from the published dataset.

```sh
npm run keygen -w packages/device -- P-001     # P-256 key -> $POURPROOF_SECRETS/devices/P-001.json, mode 600
npm run keygen -w packages/device -- P-002
npm run replay -w packages/device               # options: --chain-id --ledger --pour-start
```

`replay` writes:

| File | What it holds |
|---|---|
| `data/pours/P-001/batches.json` | Box 1 (50 cm block), 1344 readings in 112 six-hour batches of 12, each batch root signed; per reading its leaf and Merkle proof |
| `data/pours/P-002/batches.json` | the ambient air series replayed as if it were concrete; signatures are valid, the curing check flags `no_hydration_signature` |
| `data/pours/P-002/tamper.json` | two attempts against P-002: batch 1 withheld so batch 2 follows batch 0 (`CounterGap`), and batch 1 signed by the P-001 device (`BadSignature`) |

Each reading's time is `pourStart + dataset hour x 3600` and its temperature is in milli-degC. Every file carries
`deviceKind: "simulated"` and `source: "replayed from published dataset (Mendeley nmr8pjx8d8, CC BY 4.0)"`, plus the public key;
private keys stay in `$POURPROOF_SECRETS`. Chain id and ledger address are part of every signed digest, so the committed files are
signed for a fresh local Anvil (chain 31337, first deployed contract `0x5FbDB2315678afecb367f032d93F642f64180aa3`); the deploy
scenario re-runs the replay with the address it actually deploys. `predictAppend` mirrors the ledger's checks offline to say which
revert to expect; the chain decides.

## Setup

Requirements: Node 22, npm, git, Foundry.

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
| `POURPROOF_SECRETS` | directory outside the repo holding role and device private keys |

Private keys never go into the repository.

## License

MIT, see [LICENSE](LICENSE). Dataset content remains under CC BY 4.0 with attribution to its authors.
