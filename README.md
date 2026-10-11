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

Repository skeleton. Contracts, device replay, calculations, AI extraction and the web passport are not built yet; this
README will say what works once each part lands.

## Data sources

- **Curing temperature and strength data:** Mendeley Data, dataset `nmr8pjx8d8`, version 1
  (https://data.mendeley.com/datasets/nmr8pjx8d8, DOI 10.17632/nmr8pjx8d8.1), licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Half-hourly temperature history of cylinders and 50 x 50 x 50 cm boxes,
  relative humidity, ambient temperature, lab strength tests by age and the authors' ASTM C1074 maturity columns.
  The raw `Data.xlsx` is not stored here; a script downloads it and writes a normalized JSON file
  (`data/dataset/mendeley-nmr8pjx8d8.json`) that carries the attribution inside it. We changed the format, not the values.
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
