#!/usr/bin/env python3
"""html2png — render an HTML file (or URL) to a PNG or PDF at an EXACT size.

Baked into the OPNinfer sandbox image so the agent never has to install a
browser to export a design (the design-graphics skill relies on it).

  html2png IN.html OUT.png --width 1080 --height 1080 [--scale 2]
  html2png IN.html OUT.png --selector "#card"            # just one element
  html2png IN.html OUT.png --full-page --width 1440       # a whole web page
  html2png IN.html OUT.pdf --pdf --paper A4               # print
  html2png IN.html OUT.pdf --pdf --width 2480 --height 3508   # custom px

Waits for network idle AND for web fonts (document.fonts.ready) before the
shot, so Google-Fonts links and @font-face rules render, then a short settle
for CSS animations. --scale 2 doubles the pixel density (a 1080x1080 layout
becomes a 2160x2160 image) without changing the layout.
"""
import argparse
import pathlib
import sys

from playwright.sync_api import sync_playwright


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="HTML file path or http(s) URL")
    ap.add_argument("output", help="output .png (or .pdf with --pdf)")
    ap.add_argument("--width", type=int, default=1080, help="viewport width in CSS px (default 1080)")
    ap.add_argument("--height", type=int, default=1080, help="viewport height in CSS px (default 1080)")
    ap.add_argument("--scale", type=float, default=1.0, help="device scale factor: 2 = retina/double density")
    ap.add_argument("--full-page", action="store_true", help="capture the whole scrollable page, not just the viewport")
    ap.add_argument("--selector", help="capture only the element matching this CSS selector")
    ap.add_argument("--wait", type=int, default=250, help="ms to settle after load (fonts/animations), default 250")
    ap.add_argument("--transparent", action="store_true", help="omit the default white background (PNG only)")
    ap.add_argument("--pdf", action="store_true", help="write a PDF instead of a PNG")
    ap.add_argument("--paper", help="PDF paper size (A4, A3, Letter, …); overrides --width/--height for PDF")
    a = ap.parse_args()

    src = a.input
    if "://" not in src:
        p = pathlib.Path(src)
        if not p.exists():
            print(f"html2png: no such file: {src}", file=sys.stderr)
            return 2
        src = p.resolve().as_uri()

    with sync_playwright() as pw:
        # The container drops every capability, so Chromium's own sandbox cannot
        # start (Playwright already launches with it off); /dev/shm is tiny in
        # Docker, hence the dev-shm flag.
        browser = pw.chromium.launch(args=["--disable-dev-shm-usage", "--font-render-hinting=none"])
        try:
            ctx = browser.new_context(
                viewport={"width": a.width, "height": a.height},
                device_scale_factor=a.scale,
            )
            page = ctx.new_page()
            page.goto(src, wait_until="networkidle")
            # Web fonts: a screenshot taken before fonts arrive shows fallbacks.
            page.evaluate("() => (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => true)")
            if a.wait > 0:
                page.wait_for_timeout(a.wait)

            if a.pdf:
                kw = {"path": a.output, "print_background": True, "prefer_css_page_size": True}
                if a.paper:
                    kw["format"] = a.paper
                else:
                    kw["width"] = f"{a.width}px"
                    kw["height"] = f"{a.height}px"
                page.pdf(**kw)
            elif a.selector:
                el = page.locator(a.selector).first
                el.screenshot(path=a.output, omit_background=a.transparent)
            else:
                page.screenshot(path=a.output, full_page=a.full_page, omit_background=a.transparent)
        finally:
            browser.close()

    kind = "pdf" if a.pdf else "png"
    size = a.paper if (a.pdf and a.paper) else f"{a.width}x{a.height}" + ("" if a.scale == 1 else f" @{a.scale:g}x")
    print(f"html2png: wrote {a.output} ({kind}, {size})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
