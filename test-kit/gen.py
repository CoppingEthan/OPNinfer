# Generates the E2E test kit for OPNinfer. Self-contained: writes every file
# EXCEPT voicemail.wav (needs host text-to-speech — any spoken WAV works).
# Run inside the opninfer-sandbox image with this repo's test-kit mounted at /out:
#   docker run --rm -v "<repo>/test-kit:/out" opninfer-sandbox python3 /out/gen.py
# Every file carries a PLANTED FACT (see docs/E2E_TEST_PLAN.md) so a tester can
# ask the assistant a question and verify the answer came from the file.
import os, sqlite3, subprocess, zipfile

OUT = os.environ.get("OUT_DIR", "/out/files")
os.makedirs(OUT, exist_ok=True)


def p(name):
    return os.path.join(OUT, name)


# ---------- hand-written text files (passthrough / markitdown groups) --------
TEXT_FILES = {
    "data.csv": (
        "product,region,quarter,revenue_gbp,units\n"
        "Blue Widget,North,Q1,31200,780\n"
        "Blue Widget,North,Q2,35950,860\n"
        "Blue Widget,North,Q3,48275,1105\n"
        "Red Widget,North,Q3,22140,590\n"
        "Blue Widget,South,Q3,17400,410\n"
        "Green Widget,South,Q3,9980,260\n"
        "Red Widget,South,Q1,15300,388\n"
        "Green Widget,North,Q2,12750,325\n"
    ),
    "notes.md": (
        "# Team offsite notes\n\n"
        "Venue booked: **The Old Granary, Cambridge** — 14 people confirmed.\n\n"
        "## Decisions\n"
        '- The Q4 theme is "ship less, polish more".\n'
        "- Weekly demo moves to **Thursdays at 15:00**.\n"
        "- The wifi password for the venue is `granary-2026`.\n\n"
        "## Actions\n"
        "- [ ] Sam to circulate the agenda\n"
        "- [ ] Priya to book the tasting menu\n"
    ),
    "fibonacci.py": (
        '"""Tiny module used to test code-file ingestion + sandbox execution."""\n\n\n'
        "def fib(n: int) -> int:\n"
        "    a, b = 0, 1\n"
        "    for _ in range(n):\n"
        "        a, b = b, a + b\n"
        "    return a\n\n\n"
        "MAGIC_CONSTANT = 8675309  # planted fact\n\n"
        'if __name__ == "__main__":\n'
        '    print("fib(20) =", fib(20))\n'
        '    print("magic =", MAGIC_CONSTANT)\n'
    ),
    "config.json": (
        "{\n"
        '  "service": "billing-gateway",\n'
        '  "environment": "staging",\n'
        '  "port": 7443,\n'
        '  "retry": { "maxAttempts": 6, "backoffMs": 250 },\n'
        '  "featureFlags": {\n'
        '    "newInvoiceEngine": true,\n'
        '    "legacyCsvExport": false\n'
        "  },\n"
        '  "apiVersion": "2026-05-01"\n'
        "}\n"
    ),
    "legacy.rtf": (
        "{\\rtf1\\ansi\\deff0\n"
        "{\\fonttbl{\\f0 Times New Roman;}}\n"
        "\\f0\\fs28 \\b Minutes of the Harbour Committee \\b0\\par\n\\par\n"
        "Meeting held 3rd June. Present: R. Turner (chair), M. Okafor, J. Lindqvist.\\par\n\\par\n"
        "Resolved: the east pier repair contract is awarded to \\b Meridian Marine \\b0 "
        "at a cost of \\b 14,750 pounds\\b0 .\\par\n"
        "Next meeting: first Tuesday of September.\\par\n}\n"
    ),
    "message.eml": (
        "From: Dana Whitfield <dana@example-corp.test>\n"
        "To: team@example-corp.test\n"
        "Subject: Quarterly sync - room change\n"
        "Date: Tue, 09 Jun 2026 09:14:00 +0100\n"
        "MIME-Version: 1.0\n"
        'Content-Type: text/plain; charset="utf-8"\n\n'
        "Hi all,\n\n"
        "The quarterly sync on Friday moves from the Boardroom to Meeting Room 4B.\n"
        "Please bring your headcount forecasts. Lunch order deadline is Wednesday noon.\n\n"
        "The dial-in PIN for remote folks is 442-981.\n\n"
        "Thanks,\nDana\n"
    ),
}
for name, body in TEXT_FILES.items():
    with open(p(name), "w", encoding="utf-8") as f:
        f.write(body)


# ---------- spreadsheet group ----------------------------------------------
import openpyxl

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Stock"
ws.append(["SKU", "Product", "Warehouse", "Quantity", "Reorder level", "Unit cost"])
rows = [
    ["LMP-001", "Emerald Lamp", "Hitchin", 142, 77, 18.50],
    ["LMP-002", "Amber Lamp", "Hitchin", 61, 25, 17.20],
    ["CHR-010", "Oak Chair", "Baldock", 305, 60, 42.00],
    ["TBL-004", "Walnut Table", "Baldock", 27, 10, 199.99],
    ["RUG-009", "Persian Rug", "Luton", 12, 5, 349.00],
]
for r in rows:
    ws.append(r)
ws2 = wb.create_sheet("Suppliers")
ws2.append(["Supplier", "Country", "Lead time (days)"])
ws2.append(["Brightline Ltd", "UK", 7])
ws2.append(["Nordica AB", "Sweden", 21])
wb.save(p("inventory.xlsx"))

# ---------- docx / pptx (markitdown group) ----------------------------------
from docx import Document

doc = Document()
doc.add_heading("Project Nightingale — Launch Plan", 0)
doc.add_paragraph(
    "Project Nightingale is the internal codename for the spring product launch. "
    "The launch budget approved by the steering committee is £91,400."
)
doc.add_heading("Milestones", level=1)
for m in ["Beta freeze — 14 March", "Press briefing — 2 April", "Public launch — 16 April"]:
    doc.add_paragraph(m, style="List Bullet")
doc.add_heading("Risks", level=1)
doc.add_paragraph("Primary risk: supplier lead times from Nordica AB (21 days).")
doc.save(p("report.docx"))

from pptx import Presentation

prs = Presentation()
s = prs.slides.add_slide(prs.slide_layouts[0])
s.shapes.title.text = "Operation Update"
s.placeholders[1].text = "Codename: OSPREY"
s2 = prs.slides.add_slide(prs.slide_layouts[1])
s2.shapes.title.text = "Headline numbers"
s2.placeholders[1].text = "Pipeline: 37 deals\nWin rate: 24%\nTarget region: East Anglia"
prs.save(p("slides.pptx"))

# ---------- PDFs -------------------------------------------------------------
# Text PDF (markitdown extracts text directly).
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

fig = plt.figure(figsize=(8.27, 11.69))
fig.text(0.1, 0.9, "INVOICE — Brightline Ltd", fontsize=20, weight="bold")
fig.text(0.1, 0.82, "Invoice number: INV-2091", fontsize=12)
fig.text(0.1, 0.78, "Line items:", fontsize=12)
fig.text(0.12, 0.74, "Emerald Lamp x 40 ......... $740.00", fontsize=11, family="monospace")
fig.text(0.12, 0.71, "Oak Chair x 120 ........... $5,040.00", fontsize=11, family="monospace")
fig.text(0.12, 0.68, "Walnut Table x 36 ......... $7,207.65", fontsize=11, family="monospace")
fig.text(0.1, 0.60, "Invoice total: $12,987.65", fontsize=14, weight="bold")
fig.savefig(p("report.pdf"))
plt.close(fig)

# Image-only "scanned" PDF > 50 KB so the worker escalates it to Docling OCR.
from PIL import Image, ImageDraw, ImageFont
import numpy as np
from matplotlib import font_manager

font_path = font_manager.findfont("DejaVu Sans")
noise = (np.random.default_rng(7).integers(215, 250, (1600, 1200, 3))).astype("uint8")
img = Image.fromarray(noise)
d = ImageDraw.Draw(img)
big = ImageFont.truetype(font_path, 64)
med = ImageFont.truetype(font_path, 40)
d.text((90, 200), "SCANNED ARCHIVE 1974", font=big, fill=(20, 20, 20))
d.text((90, 340), "REF: KESTREL-42", font=big, fill=(20, 20, 20))
d.text((90, 520), "Retrieved from microfilm reel 9,", font=med, fill=(40, 40, 40))
d.text((90, 590), "county records office.", font=med, fill=(40, 40, 40))
img.save(p("scanned.pdf"), "PDF", resolution=150)

# ---------- images -----------------------------------------------------------
photo = Image.new("RGB", (900, 600), (245, 222, 89))
d = ImageDraw.Draw(photo)
d.ellipse((330, 130, 570, 370), fill=(120, 78, 20))
for ang in range(0, 360, 30):
    import math

    cx, cy = 450, 250
    x = cx + 170 * math.cos(math.radians(ang))
    y = cy + 170 * math.sin(math.radians(ang))
    d.ellipse((x - 45, y - 45, x + 45, y + 45), fill=(250, 190, 30))
d.text((280, 470), "SUNFLOWER", font=ImageFont.truetype(font_path, 72), fill=(30, 30, 30))
photo.save(p("photo.png"))

chart = Image.new("RGB", (640, 400), (28, 32, 40))
d = ImageDraw.Draw(chart)
for i, h in enumerate([120, 210, 90, 300, 180]):
    d.rectangle((60 + i * 110, 360 - h, 140 + i * 110, 360), fill=(90, 140, 220))
d.text((60, 20), "Weekly sales", font=ImageFont.truetype(font_path, 28), fill=(230, 230, 230))
chart.save(p("chart.webp"), "WEBP")

frames = []
for i in range(8):
    f = Image.new("RGB", (200, 200), (250, 250, 250))
    fd = ImageDraw.Draw(f)
    fd.ellipse((80 - i * 8, 80 - i * 8, 120 + i * 8, 120 + i * 8), outline=(200, 40, 90), width=6)
    frames.append(f)
frames[0].save(p("sticker.gif"), save_all=True, append_images=frames[1:], duration=120, loop=0)

# ---------- database group ---------------------------------------------------
dbfile = p("contacts.db")
if os.path.exists(dbfile):
    os.remove(dbfile)
con = sqlite3.connect(dbfile)
cur = con.cursor()
cur.execute("CREATE TABLE companies (id INTEGER PRIMARY KEY, name TEXT, city TEXT)")
cur.execute(
    "CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT,"
    " company_id INTEGER REFERENCES companies(id))"
)
cur.executemany(
    "INSERT INTO companies VALUES (?,?,?)",
    [(1, "Analytical Engines Ltd", "London"), (2, "Wireless & Co", "Bologna")],
)
cur.executemany(
    "INSERT INTO customers VALUES (?,?,?,?)",
    [
        (1, "Ada Lovelace", "ada@analyticalengines.example", 1),
        (2, "Charles Babbage", "charles@analyticalengines.example", 1),
        (3, "Guglielmo Marconi", "g.marconi@wireless.example", 2),
    ],
)
con.commit()
con.close()

# ---------- video (ffprobe metadata group) -----------------------------------
subprocess.run(
    [
        "ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-shortest", "-pix_fmt", "yuv420p", p("clip.mp4"),
    ],
    check=True,
    capture_output=True,
)

# ---------- nested archive (markitdown zip walk) -----------------------------
with zipfile.ZipFile(p("archive.zip"), "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr(
        "readme-inside-zip.txt",
        "This text file lives inside archive.zip. The hidden keyword is COPPERFIELD.\n",
    )
    z.writestr(
        "shopping-list.txt",
        "eggs\nflour\nsaffron (planted fact: most expensive item)\nmilk\n",
    )

print("Generated:", sorted(os.listdir(OUT)))
print("NOTE: voicemail.wav is NOT generated here — add any spoken WAV whose")
print('      audio says the magic word "turquoise elephant" for the STT test.')
