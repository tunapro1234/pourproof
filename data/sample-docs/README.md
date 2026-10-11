# Sample documents

These files stand in for the paperwork that arrives with a concrete pour. They are **samples made for this project**, and
each one carries the watermark "SAMPLE - NOT A REAL DOCUMENT".

| File | What it is |
|---|---|
| `delivery-ticket-P-001.png` | Delivery ticket for pour P-001, made to look like a phone photo (Mix B, 8.0 m3, plate 34 XX 0000) |
| `delivery-ticket-P-002.png` | Same for pour P-002, the tamper case (plate 34 XX 0001) |
| `sample-epd-mix-a.pdf` | Sample EPD for Mix A, the contractor's declared baseline (Portland cement Type I/II, 380 kg/m3) |
| `sample-epd-mix-b.pdf` | Sample EPD for Mix B, the delivered low-clinker mix (Portland-limestone cement Type IL, 320 kg/m3) |
| `make_sample_docs.py` | Builds all four files from the values below |
| `test_sample_docs.py` | Checks that the files match the generator and carry the watermark on every page |

## Why samples

PourProof reads a delivery ticket and an EPD with AI, shows where each field came from, and puts the hash of each file on
chain. Showing that with a real producer's paperwork would put their name on claims they never made. So the supplier
("Sample Ready-Mix Co."), the plant, the ticket and document numbers and the mix codes are invented, and no real company name
or logo appears on the documents. The numbers on them come from a published source or carry an "assumption" label.

Do not use these values for design, procurement, carbon reporting or any claim.

## Where each value comes from

All values are read from [`data/scenario/inputs.json`](../scenario/inputs.json), the repository copy of the project's
sample-values.json. Each entry there names its source or says "assumption".

| Value | Mix A (baseline) | Mix B (delivered) | Source |
|---|---|---|---|
| Cement GWP per tonne | 974.92 kg CO2e/t (Type I/II) | 892.95 kg CO2e/t (Type IL) | Akcansa cement EPD, NRMCA EPD No. 20243, pages 5 and 6 (link below) |
| Cement content | 380 kg/m3 | 320 kg/m3 | assumption: typical over-designed C30/37 mix (A); optimized mix (B) |
| Cement GWP per m3 | 370.5 kg CO2e/m3 | 285.7 kg CO2e/m3 | cement content x GWP per tonne |
| Other constituents | 20 to 40 kg CO2e/m3 | 20 to 40 kg CO2e/m3 | assumption: aggregates, water, admixture, batching; not modeled |
| **GWP-total, A1-A3** | **390 to 411 kg CO2e/m3** | **306 to 326 kg CO2e/m3** | sum of the two rows above, in the whole kg declared on chain |
| Volume (ticket) | | 8.0 m3 | assumption, `inputs.json` pour P-001 |
| Ticket times | | load, arrival, discharge | aligned to the pour start in `data/pours/P-001/batches.json` (UTC+3) |

Source EPD: Akcansa cement EPD covering Type I/II and Type IL cement, NRMCA EPD No. 20243, valid 26 Nov 2024 to
26 Nov 2029, declared unit 1 metric ton of cement:
<https://www.nrmca.org/wp-content/uploads/NRMCAEPD_20243_HM-Cement-Akcansa-Import-Cement.pdf>.
It is a Turkish cement made for the US market under a US product category rule (NRMCA program), not EN 15804. We use it only
to anchor the cement share of the sample range; it does not describe these mixes. The documents cite it by EPD number only,
so the producer's name does not appear on a fictional supplier's paperwork.

For pour P-001 the saving range is 8 m3 x (390 - 326 .. 411 - 306) = 512 to 840 kg CO2e. That is a testnet demo of the
single-claim rule, no real claim.

## How the files are made

```
python3 data/sample-docs/make_sample_docs.py          # writes the four files here
python3 -m unittest discover -s data/sample-docs -p 'test_*.py'
```

The PDFs come from a small writer inside the script: standard PDF fonts, a real text layer (pdftotext reads every line,
including the watermark), no timestamps. The ticket is drawn with Pillow (perspective, shadow, uneven light and fixed-seed
noise). Both are byte-identical on every run, so the sha256 of each file on chain stays stable. Requires Python 3.10+, Pillow
and the Liberation fonts (`fonts-liberation`), whose widths match the PDF's Helvetica.
