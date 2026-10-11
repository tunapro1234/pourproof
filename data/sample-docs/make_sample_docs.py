#!/usr/bin/env python3
# Copyright (c) 2026 PourProof contributors. MIT License.
"""Builds the sample documents used in the demo: one delivery ticket photo per pour (PNG) and one sample EPD per mix (PDF).

Every value comes from data/scenario/inputs.json (sample values with a source or an 'assumption' label) and the replayed pour
start in data/pours/<pour>/batches.json. Nothing here is a real document: every page and the ticket carry the watermark
"SAMPLE - NOT A REAL DOCUMENT" and the supplier is fictional.

The PDFs are written by a small writer below (base-14 fonts, uncompressed, real text layer, no dates), so the output is
byte-identical on every run and pdftotext reads the text back in order. The ticket uses Pillow with a fixed noise seed.

Usage: python3 data/sample-docs/make_sample_docs.py [--out DIR]
"""

from __future__ import annotations

import argparse
import json
import math
import random
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
WATERMARK = "SAMPLE - NOT A REAL DOCUMENT"
SUPPLIER = "Sample Ready-Mix Co."
TZ = timezone(timedelta(hours=3))  # Turkey time, where the sample site is set

# Liberation Sans has the same advance widths as Helvetica, so it measures text for the PDF's base-14 fonts.
FONT_DIRS = [Path("/usr/share/fonts/truetype/liberation"), Path("/usr/share/fonts/truetype/dejavu")]


def font_file(name: str) -> Path:
    for d in FONT_DIRS:
        if (d / name).exists():
            return d / name
    raise SystemExit(f"font {name} not found in {', '.join(map(str, FONT_DIRS))}")


def load_inputs() -> dict:
    return json.loads((REPO / "data" / "scenario" / "inputs.json").read_text("utf8"))


def pour_start(label: str) -> int:
    return json.loads((REPO / "data" / "pours" / label / "batches.json").read_text("utf8"))["pourStart"]


def fmt_num(x: float) -> str:
    return f"{x:g}"


def fmt_range(r: list) -> str:
    lo, hi = r
    return fmt_num(lo) if lo == hi else f"{fmt_num(lo)} to {fmt_num(hi)}"


# ---------------------------------------------------------------------------------------------------------------------
# Minimal PDF writer
# ---------------------------------------------------------------------------------------------------------------------

PDF_FONTS = {"R": "Helvetica", "B": "Helvetica-Bold", "I": "Helvetica-Oblique"}
MEASURE = {"R": "LiberationSans-Regular.ttf", "B": "LiberationSans-Bold.ttf", "I": "LiberationSans-Italic.ttf"}
_measure_cache: dict[str, ImageFont.FreeTypeFont] = {}


def text_width(s: str, font: str, size: float) -> float:
    if font not in _measure_cache:
        _measure_cache[font] = ImageFont.truetype(str(font_file(MEASURE[font])), 1000)
    return _measure_cache[font].getlength(s) * size / 1000


def pdf_str(s: str) -> str:
    s.encode("ascii")  # base-14 fonts with WinAnsi: keep to ASCII
    return "(" + s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ")"


class Page:
    W, H = 595.28, 841.89  # A4 in points

    def __init__(self) -> None:
        self.ops: list[str] = []

    def text(self, x: float, y: float, s: str, size: float = 10, font: str = "R", rgb=(0.1, 0.12, 0.15)) -> None:
        r, g, b = rgb
        self.ops.append(f"BT /F{font} {size:g} Tf {r:.3f} {g:.3f} {b:.3f} rg 1 0 0 1 {x:.2f} {y:.2f} Tm {pdf_str(s)} Tj ET")

    def text_right(self, x: float, y: float, s: str, size: float = 10, font: str = "R", rgb=(0.1, 0.12, 0.15)) -> None:
        self.text(x - text_width(s, font, size), y, s, size, font, rgb)

    def wrap(self, x: float, y: float, s: str, width: float, size: float = 9.5, font: str = "R", leading: float = 1.35, rgb=(0.1, 0.12, 0.15)) -> float:
        """Writes s wrapped to width; each output line is one text run. Returns the y below the last line."""
        line = ""
        for word in s.split(" "):
            cand = word if not line else f"{line} {word}"
            if line and text_width(cand, font, size) > width:
                self.text(x, y, line, size, font, rgb)
                y -= size * leading
                line = word
            else:
                line = cand
        if line:
            self.text(x, y, line, size, font, rgb)
            y -= size * leading
        return y

    def rect(self, x: float, y: float, w: float, h: float, fill=None, stroke=None, lw: float = 0.6) -> None:
        ops = []
        if fill:
            ops.append("{:.3f} {:.3f} {:.3f} rg".format(*fill))
        if stroke:
            ops.append("{:.3f} {:.3f} {:.3f} RG {:g} w".format(*stroke, lw))
        paint = "B" if fill and stroke else "f" if fill else "S"
        self.ops.append(" ".join(ops + [f"{x:.2f} {y:.2f} {w:.2f} {h:.2f} re {paint}"]))

    def line(self, x1: float, y1: float, x2: float, y2: float, rgb=(0.6, 0.62, 0.65), lw: float = 0.5) -> None:
        r, g, b = rgb
        self.ops.append(f"{r:.3f} {g:.3f} {b:.3f} RG {lw:g} w {x1:.2f} {y1:.2f} m {x2:.2f} {y2:.2f} l S")

    def watermark(self) -> None:
        """Large diagonal stamp at low opacity, drawn last so no content hides it. It is an image, not text, so text
        extraction keeps the reading order of the page; the header and footer carry the same words as text."""
        iw, ih = watermark_size()
        w = 640.0
        h = w * ih / iw
        a = math.radians(38)
        c, s = math.cos(a), math.sin(a)
        x0 = self.W / 2 - (w / 2) * c + (h / 2) * s
        y0 = self.H / 2 - (w / 2) * s - (h / 2) * c
        self.ops.append(f"q /GSW gs {w * c:.4f} {w * s:.4f} {-h * s:.4f} {h * c:.4f} {x0:.2f} {y0:.2f} cm /WM Do Q")

    def content(self) -> bytes:
        return ("\n".join(self.ops) + "\n").encode("ascii")


WM_FONT_PX = 100


def watermark_size() -> tuple[int, int]:
    f = ImageFont.truetype(str(font_file(MEASURE["B"])), WM_FONT_PX)
    return math.ceil(f.getlength(WATERMARK)) + 40, 140


def watermark_image() -> tuple[bytes, bytes]:
    """Red stamp image and its soft mask (the words), both Flate-compressed."""
    size = watermark_size()
    mask = Image.new("L", size, 0)
    f = ImageFont.truetype(str(font_file(MEASURE["B"])), WM_FONT_PX)
    ImageDraw.Draw(mask).text((size[0] / 2, size[1] / 2), WATERMARK, font=f, fill=255, anchor="mm")
    red = bytes((199, 26, 26)) * (size[0] * size[1])
    return zlib.compress(red, 9), zlib.compress(mask.tobytes(), 9)


def write_pdf(path: Path, pages: list[Page], title: str) -> None:
    objs: list[bytes] = []

    def add(body: bytes | str) -> int:
        objs.append(body.encode("ascii") if isinstance(body, str) else body)
        return len(objs)

    catalog = add("")  # filled in below
    pages_id = add("")
    font_ids = {k: add(f"<< /Type /Font /Subtype /Type1 /BaseFont /{v} /Encoding /WinAnsiEncoding >>") for k, v in PDF_FONTS.items()}
    gs = add("<< /Type /ExtGState /ca 0.2 /CA 0.2 >>")
    rgb, alpha = watermark_image()
    iw, ih = watermark_size()
    smask = add(b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length %d >>\nstream\n" % (iw, ih, len(alpha)) + alpha + b"\nendstream")
    wm = add(b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask %d 0 R /Filter /FlateDecode /Length %d >>\nstream\n" % (iw, ih, smask, len(rgb)) + rgb + b"\nendstream")
    fonts = " ".join(f"/F{k} {i} 0 R" for k, i in font_ids.items())
    resources = f"<< /Font << {fonts} >> /ExtGState << /GSW {gs} 0 R >> /XObject << /WM {wm} 0 R >> >>"
    kids = []
    for p in pages:
        data = p.content()
        stream = add(b"<< /Length %d >>\nstream\n" % len(data) + data + b"endstream")
        kids.append(add(f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {Page.W} {Page.H}] /Resources {resources} /Contents {stream} 0 R >>"))
    objs[catalog - 1] = f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode("ascii")
    objs[pages_id - 1] = f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>".encode("ascii")
    info = add(f"<< /Title {pdf_str(title)} /Subject {pdf_str(WATERMARK)} /Producer (PourProof sample-docs generator) >>")

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, catalog, info, xref)
    path.write_bytes(bytes(out))


# ---------------------------------------------------------------------------------------------------------------------
# Sample EPD (one per mix)
# ---------------------------------------------------------------------------------------------------------------------

INK = (0.1, 0.12, 0.15)
MUTED = (0.33, 0.36, 0.4)
ACCENT = (0.12, 0.35, 0.3)
RED = (0.7, 0.1, 0.1)

EPD_META = {
    "mix_a_baseline": {"file": "sample-epd-mix-a.pdf", "code": "MIX-A-PC380", "no": "SAMPLE-EPD-A", "role": "Baseline mix (standard spec)", "cement_key": "Type I/II"},
    "mix_b_actual": {"file": "sample-epd-mix-b.pdf", "code": "MIX-B-IL320", "no": "SAMPLE-EPD-B", "role": "Low-clinker mix (delivered)", "cement_key": "Type IL"},
}


def page_frame(p: Page, page_no: int, pages: int, doc_no: str) -> None:
    p.rect(0, Page.H - 34, Page.W, 34, fill=(0.97, 0.9, 0.9))
    p.text(40, Page.H - 22, WATERMARK, 10, "B", RED)
    p.text_right(Page.W - 40, Page.H - 22, f"{doc_no} | page {page_no} of {pages}", 9, "R", RED)
    p.line(40, 52, Page.W - 40, 52)
    p.text(40, 38, f"{WATERMARK}. Made for the PourProof testnet demo. Fictional supplier; not a verified EPD.", 8, "R", RED)
    p.text(40, 26, "Values and sources: data/sample-docs/README.md and data/scenario/inputs.json in the PourProof repository.", 8, "R", MUTED)


def build_epd(mix_key: str, mix: dict, sources: dict) -> list[Page]:
    meta = EPD_META[mix_key]
    src = sources["akcansa_nrmca_epd"]
    cement_t = src["gwp_kgco2e_per_t"][meta["cement_key"]]
    cement_page = src["pages"][meta["cement_key"]]
    total = fmt_range(mix["gwp_total_kg_per_m3"])
    cement = fmt_range(mix["cement_gwp_kg_per_m3"])
    other = fmt_range(mix["other_constituents_kg_per_m3"])
    L, R = 40, Page.W - 40

    p1 = Page()
    page_frame(p1, 1, 2, meta["no"])
    y = Page.H - 78
    p1.text(L, y, "SAMPLE ENVIRONMENTAL PRODUCT DECLARATION", 17, "B", ACCENT)
    y -= 20
    p1.text(L, y, "Ready-mixed concrete, declared unit 1 m3, cradle to gate (modules A1-A3)", 11, "R", INK)
    y -= 30

    rows = [
        ("Declared by", f"{SUPPLIER} (fictional company)"),
        ("Product", f"Ready-mixed concrete, mix code {meta['code']}"),
        ("Mix", mix["label"]),
        ("Role in the demo", meta["role"]),
        ("Cement", f"{mix['cement_type']}, {fmt_num(mix['cement_kg_per_m3'])} kg per m3 [1]"),
        ("Declared unit", "1 m3 of ready-mixed concrete at the plant gate"),
        ("Document number", f"{meta['no']} (sample, not registered with any program operator)"),
        ("Status", "Sample for software testing. Not third-party verified. Not for procurement or reporting."),
    ]
    for k, v in rows:
        p1.text(L, y, k, 9.5, "B", MUTED)
        y = p1.wrap(L + 120, y, v, R - L - 120, 9.5)
        y -= 4
    y -= 10

    p1.text(L, y, "Results per declared unit (1 m3)", 12, "B", ACCENT)
    y -= 8
    cols = [L, L + 220, L + 345, L + 450]
    p1.rect(L, y - 18, R - L, 18, fill=(0.92, 0.95, 0.94))
    for x, h in zip(cols, ["Indicator", "Value", "Unit", "Source"]):
        p1.text(x + 6, y - 13, h, 9, "B", INK)
    y -= 18
    table = [
        ("GWP of cement (A1-A3)", cement, "kg CO2e/m3", "[1]"),
        ("GWP of other constituents", other, "kg CO2e/m3", "[2]"),
        ("GWP-total (A1-A3)", total, "kg CO2e/m3", "[3]"),
    ]
    for i, row in enumerate(table):
        bold = i == len(table) - 1
        p1.line(L, y, R, y)
        for x, cell in zip(cols, row):
            p1.text(x + 6, y - 14, cell, 9.5, "B" if bold else "R", INK)
        y -= 20
    p1.line(L, y, R, y)
    y -= 22

    p1.text(L, y, "Result in one line", 10, "B", INK)
    y -= 14
    y = p1.wrap(L, y, f"GWP-total, modules A1-A3: {total} kg CO2e per m3 of concrete.", R - L, 10.5, "B")
    y -= 2
    y = p1.wrap(L, y, "The result is a range, not a single number: the cement share is computed from a published EPD and the rest is an assumed band.", R - L, 9.5)
    y -= 14

    p1.text(L, y, "Notes", 10, "B", INK)
    y -= 14
    notes = [
        f"[1] Cement: {mix['cement_gwp_basis'].replace('akcansa_nrmca_epd', 'published cement EPD, NRMCA EPD No. 20243')}. "
        f"That EPD gives {fmt_num(cement_t)} kg CO2e per tonne for {meta['cement_key']} cement on page {cement_page}. "
        f"Cement content {fmt_num(mix['cement_kg_per_m3'])} kg per m3 is an assumption ({mix['cement_basis'].removeprefix('assumption: ')}).",
        f"[2] Other constituents: assumption ({mix['other_basis'].removeprefix('assumption: ')}).",
        "[3] GWP-total = [1] + [2], in whole kg as declared on chain by the contractor (baseline) and the supplier (delivered mix).",
        "The cement EPD follows a US product category rule (NRMCA program), not EN 15804. It is used only to anchor the sample range.",
    ]
    for n in notes:
        y = p1.wrap(L, y, n, R - L, 8.8, "R", rgb=MUTED)
        y -= 3
    p1.watermark()

    p2 = Page()
    page_frame(p2, 2, 2, meta["no"])
    y = Page.H - 78
    p2.text(L, y, "Why this document is a sample", 14, "B", ACCENT)
    y -= 22
    paras = [
        "PourProof records each concrete pour on chain and lets software read the delivery ticket and the EPD. To show that step "
        "without using a real company's paperwork, this project made its own documents. The supplier, plant, document number and "
        "mix code are invented.",
        "The numbers are not invented. The cement share comes from a published EPD for a Turkish cement (NRMCA EPD No. 20243). "
        "The cement content per m3 and the band for aggregates, water, admixture and batching are assumptions, labelled as such "
        "here and in data/scenario/inputs.json.",
        "On chain, the sha256 of this PDF file is recorded in a signed transaction. Change one byte and the hash no longer matches.",
        "Do not use these values for design, procurement, carbon reporting or any claim. Real projects need the EPD of the actual "
        "mix from its producer, verified under a recognized program.",
    ]
    for t in paras:
        y = p2.wrap(L, y, t, R - L, 10)
        y -= 8
    y -= 6
    p2.text(L, y, "Calculation", 11, "B", ACCENT)
    y -= 16
    calc = [
        f"Cement: {fmt_num(mix['cement_kg_per_m3'])} kg/m3 x {fmt_num(cement_t)} kg CO2e/t = {cement} kg CO2e/m3",
        f"Other constituents: {other} kg CO2e/m3 (assumption)",
        f"GWP-total (A1-A3): {total} kg CO2e/m3",
    ]
    for c in calc:
        p2.text(L + 10, y, c, 10, "R", INK)
        y -= 15
    y -= 12
    p2.text(L, y, "Source", 11, "B", ACCENT)
    y -= 16
    y = p2.wrap(L, y, "Published cement EPD: NRMCA EPD No. 20243, valid 26 Nov 2024 to 26 Nov 2029, declared unit 1 metric ton of cement.", R - L, 9.5)
    y = p2.wrap(L, y, "Link: data/sample-docs/README.md", R - L, 9.5)
    p2.watermark()
    return [p1, p2]


# ---------------------------------------------------------------------------------------------------------------------
# Delivery ticket photo
# ---------------------------------------------------------------------------------------------------------------------


def ttf(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(font_file(name)), size)


def ticket_paper(label: str, pour: dict, mix: dict, start: int) -> Image.Image:
    W, H = 1000, 1400
    paper = Image.new("RGB", (W, H), (248, 245, 236))
    d = ImageDraw.Draw(paper)
    ink = (28, 40, 72)  # printer ink
    pre = (22, 92, 80)  # preprinted form colour
    f_head = ttf("LiberationSans-Bold.ttf", 46)
    f_sub = ttf("LiberationSans-Regular.ttf", 24)
    f_lab = ttf("LiberationSans-Bold.ttf", 19)
    f_val = ttf("LiberationMono-Bold.ttf", 30)
    f_small = ttf("LiberationSans-Regular.ttf", 19)

    # Header: an abstract mark (three bars) and the fictional name
    for i, h in enumerate([44, 62, 80]):
        d.rectangle([60 + i * 22, 140 - h, 76 + i * 22, 140], fill=pre)
    d.text((150, 62), SUPPLIER, font=f_head, fill=pre)
    d.text((152, 116), "Fictional supplier for the PourProof demo", font=f_sub, fill=pre)
    d.rectangle([60, 162, W - 60, 166], fill=pre)
    d.text((60, 182), "DELIVERY TICKET", font=ttf("LiberationSans-Bold.ttf", 36), fill=pre)
    no = f"SRM-{label}"
    d.text((W - 60, 186), f"No. {no}", font=ttf("LiberationMono-Bold.ttf", 32), fill=ink, anchor="ra")

    t_start = datetime.fromtimestamp(start, TZ)
    t_load = t_start - timedelta(minutes=55)
    t_arrive = t_start - timedelta(minutes=15)
    plate = pour["ticket"]["truck_plate"].replace(" (fictional)", "")
    fields = [
        ("DATE", t_start.strftime("%d.%m.%Y")),
        ("TRUCK PLATE", plate),
        ("POUR ID", label),
        ("MIX CODE", pour["ticket"]["mix_code"]),
        ("CEMENT TYPE", mix["cement_type"].replace("Portland-limestone cement", "Portland-limestone").replace("Portland cement", "Portland")),
        ("CEMENT CONTENT", f"{fmt_num(mix['cement_kg_per_m3'])} kg/m3"),
        ("VOLUME", f"{pour['volume_m3']:.1f} m3"),
        ("LOADED AT PLANT", t_load.strftime("%H:%M")),
        ("ARRIVED ON SITE", t_arrive.strftime("%H:%M")),
        ("DISCHARGE START", t_start.strftime("%H:%M")),
    ]
    y = 260
    for k, v in fields:
        d.rectangle([60, y, W - 60, y + 74], outline=pre, width=2)
        d.line([360, y, 360, y + 74], fill=pre, width=2)
        d.text((76, y + 27), k, font=f_lab, fill=pre)
        d.text((380, y + 20), v, font=f_val, fill=ink)
        y += 74
    y += 30
    d.text((60, y), "Times in Turkey time (UTC+3), aligned to the replayed pour start.", font=f_small, fill=pre)
    y += 28
    d.text((60, y), "Values: data/scenario/inputs.json (sample values, see README).", font=f_small, fill=pre)
    y += 70
    for x, cap in [(60, "Driver signature"), (540, "Received by (site)")]:
        d.line([x, y + 60, x + 400, y + 60], fill=pre, width=2)
        d.text((x, y + 70), cap, font=f_small, fill=pre)

    # Watermark across the ticket, drawn on its own layer and blended
    wm = Image.new("L", (W, H), 0)
    wd = ImageDraw.Draw(wm)
    f_wm = ttf("LiberationSans-Bold.ttf", 64)
    for cy in (H * 0.36, H * 0.72):
        tile = Image.new("L", (1500, 120), 0)
        ImageDraw.Draw(tile).text((750, 60), WATERMARK, font=f_wm, fill=255, anchor="mm")
        tile = tile.rotate(32, resample=Image.BICUBIC, expand=True)
        wm.paste(tile, (int(W / 2 - tile.width / 2), int(cy - tile.height / 2)), tile)
    red = Image.new("RGB", (W, H), (190, 30, 30))
    paper = Image.composite(red, paper, wm.point(lambda v: v * 52 // 100))
    d = ImageDraw.Draw(paper)
    d.rectangle([60, H - 92, W - 60, H - 44], fill=(190, 30, 30))
    d.text((W / 2, H - 68), WATERMARK, font=ttf("LiberationSans-Bold.ttf", 30), fill=(255, 255, 255), anchor="mm")
    return paper


def perspective_coeffs(dst: list[tuple[float, float]], src: list[tuple[float, float]]) -> list[float]:
    """Coefficients for Image.transform(PERSPECTIVE) mapping output points dst to input points src."""
    a, b = [], []
    for (x, y), (u, v) in zip(dst, src):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        b.append(u)
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        b.append(v)
    n = 8
    m = [row[:] + [bb] for row, bb in zip(a, b)]
    for c in range(n):  # Gaussian elimination with partial pivoting
        piv = max(range(c, n), key=lambda r: abs(m[r][c]))
        m[c], m[piv] = m[piv], m[c]
        for r in range(n):
            if r != c:
                f = m[r][c] / m[c][c]
                m[r] = [rv - f * cv for rv, cv in zip(m[r], m[c])]
    return [m[i][n] / m[i][i] for i in range(n)]


def ticket_photo(paper: Image.Image, seed: int) -> Image.Image:
    rng = random.Random(seed)
    W, H = 1080, 1440
    # Background: a dark clipboard-like surface with soft grain
    bg = Image.new("RGB", (W, H), (58, 54, 50))
    small = Image.new("L", (W // 8, H // 8))
    small.putdata([rng.randint(0, 255) for _ in range((W // 8) * (H // 8))])
    grain = small.resize((W, H), Image.BICUBIC).filter(ImageFilter.GaussianBlur(3))
    bg = Image.composite(Image.new("RGB", (W, H), (78, 72, 66)), bg, grain)

    # Paper corners in the photo: slight keystone and tilt, as if held at a small angle
    corners = [(118, 92), (968, 120), (1000, 1352), (86, 1330)]
    sw, sh = paper.size
    coeffs = perspective_coeffs(corners, [(0, 0), (sw, 0), (sw, sh), (0, sh)])
    warped = paper.transform((W, H), Image.PERSPECTIVE, coeffs, Image.BICUBIC)
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).polygon(corners, fill=255)
    shadow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(shadow).polygon([(x + 14, y + 18) for x, y in corners], fill=150)
    shadow = shadow.filter(ImageFilter.GaussianBlur(16))
    photo = Image.composite(Image.new("RGB", (W, H), (20, 18, 16)), bg, shadow)
    photo = Image.composite(warped, photo, mask)

    # Uneven light: brighter top left, darker bottom right, warm indoor tint
    light = Image.new("L", (W // 8, H // 8))
    lw, lh = light.size
    light.putdata([int(255 - 70 * min(1.0, math.hypot(x / lw - 0.3, y / lh - 0.25) / 0.95)) for y in range(lh) for x in range(lw)])
    light = light.resize((W, H), Image.BICUBIC)
    photo = Image.composite(photo, Image.new("RGB", (W, H), (32, 28, 22)), light)
    r, g, b = photo.split()
    photo = Image.merge("RGB", (r.point(lambda v: min(255, int(v * 1.02))), g, b.point(lambda v: int(v * 0.95))))

    # Sensor noise and a touch of softness; text stays readable
    noise = Image.new("L", (W // 2, H // 2))
    noise.putdata([128 + int(rng.gauss(0, 9)) for _ in range((W // 2) * (H // 2))])
    noise = noise.resize((W, H), Image.BILINEAR)
    photo = Image.blend(photo, Image.merge("RGB", (noise, noise, noise)), 0.06)
    return photo.filter(ImageFilter.GaussianBlur(0.5))


# ---------------------------------------------------------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=HERE)
    out: Path = ap.parse_args().out
    out.mkdir(parents=True, exist_ok=True)
    inputs = load_inputs()

    for mix_key, meta in EPD_META.items():
        mix = inputs["mixes"][mix_key]
        write_pdf(out / meta["file"], build_epd(mix_key, mix, inputs["sources"]), f"Sample EPD {meta['code']} ({WATERMARK})")
        print(f"wrote {out / meta['file']}")

    for i, (label, pour) in enumerate(sorted(inputs["pours"].items())):
        mix = inputs["mixes"][pour["delivered_mix"]]
        photo = ticket_photo(ticket_paper(label, pour, mix, pour_start(label)), seed=20261011 + i)
        path = out / f"delivery-ticket-{label}.png"
        photo.save(path, format="PNG", optimize=False)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
