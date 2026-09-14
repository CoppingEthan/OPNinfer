---
name: design-graphics
description: For ANY design request — adverts, social posts, banners, posters, flyers, business cards, slides, website or app mockups, print pieces. Load this FIRST. On the first design request in a conversation you MUST then ask the user (ask_user) which they want — a built, editable graphic (HTML/CSS → exact-size PNG, recommended) or a quick AI concept image — before any work starts. It also carries the build recipe the Sandbox follows.
---

# Design graphics — build them, don't generate them

Two ways exist to make a graphic, and they are NOT interchangeable:

| | **Built graphic** (HTML/CSS → PNG/PDF) | **AI-generated image** |
|---|---|---|
| Text, logos, layout | Exact — every word, size and colour as asked | Approximate; text often garbled |
| Editable later | Yes — "make it blue" changes the same file | No — a new image, differently wrong |
| Exact dimensions | Yes (1080×1080, A4, 1200×628…) | Only rough aspect ratios |
| Good for | Real social posts, adverts, posters, print, web & app mockups, anything with words | Photos, illustrations, mood/concept art, textures, a picture INSIDE a design |

**Roughly 90% of design requests want a built graphic.** The image tools are for
photographs and illustrations — including ones used as backgrounds *within* a
built design.

## Step 1 — ASK on the first design request (mandatory), then remember

On the FIRST design request in a conversation you MUST call `ask_user` before
doing anything else — even when the request looks clear, even when it names a
format like "PNG". This is not asking permission (which you must never do): it
is a genuine fork between two DIFFERENT deliverables the user cannot see
coming, and the wrong one wastes their time. One question, two options, the
build first and marked recommended:

- **"Build it properly (recommended)"** — a real, editable design at the exact size; takes a few minutes.
- **"Quick AI concept image"** — fast, not editable, text may come out wrong; good for a rough idea.

Only skip the question when the user has ALREADY chosen in this conversation
(an earlier answer to this question, or words like "editable", "proper", "real
design", "for print", "exact size" → build; "quick", "rough", "concept", "just
an idea" → generate). Never ask twice in one conversation — reuse the answer.

## Step 2a — build (the normal path)

Hand the job to the **Sandbox** (`sandbox_task`). Tell it, in the task text, to
**use its `design-graphics` skill**, and pass on EVERYTHING the user said
(brand, colours, wording, sizes, how many variations, target platform). The
Sandbox follows the build recipe below; it renders with the bundled
`html2png` command and presents the PNGs itself. Then summarise what the user
now has and remind them they can ask for changes.

## Step 2b — generate (concepts only)

Use `image_generation` with a rich prompt. Say in the reply that the text in
generated images is unreliable and offer to build a proper version.

---

# Build recipe (for the Sandbox agent)

You are producing finished graphics as **PNG** (or **PDF** for print) from
**HTML/CSS**. Work in the chat workspace (`/workspace`).

1. **Pick the size** from the table below (or the user's). One HTML file per
   design: `ad-1.html`, `ad-2.html`, … Keep the sources — they are the
   editable originals and the user may ask for changes next turn.
2. **Write the HTML** using the template. The root `.canvas` element is the
   exact pixel size; everything lives inside it. No scrolling, no overflow.
3. **Design well**: one clear message per graphic; a strong hierarchy (one
   headline, one supporting line, one call to action); generous margins
   (≥5% of the short edge); at most two typefaces; a small palette (one
   accent); real contrast (WCAG AA); align to a grid. Use `clamp()`-free
   fixed sizes — the canvas is fixed, so fixed px is right here.
4. **Fonts**: Inter, Roboto, Open Sans, Lato, Ubuntu, Noto (incl. colour
   emoji), Liberation, DejaVu, Fira Code, Cantarell, Carlito (Calibri
   metrics) and Caladea (Cambria metrics) are installed. Google Fonts
   `<link>` tags also work (the renderer waits for fonts to load).
5. **Imagery**: CSS gradients, shapes and emoji cover most needs. For a
   photo or illustration INSIDE the design, ask the assistant beforehand
   to generate one, or draw with SVG/CSS. Use the user's uploaded logo or
   photos from `/workspace` when present (`<img src="logo.png">`, relative
   paths work).
6. **Render**: `html2png ad-1.html ad-1.png --width 1080 --height 1080`
   (add `--scale 2` for a retina/print-sharp PNG at the same layout;
   `--pdf --paper A4` or `--pdf --width W --height H` for print). It waits
   for fonts and network, then writes the file.
7. **Check your work**: view the PNG (the `Read` tool shows images). Fix
   clipped text, overflow, bad contrast or empty space, re-render.
8. **Present** every finished PNG/PDF with `present_files`. Present the
   HTML sources too when the user asked for editable/source files;
   otherwise mention they exist.
9. **Variations**: when asked for N adverts, make N genuinely different
   layouts/angles (offer, product, testimonial, seasonal…), not one design
   with the colour swapped.

## Sizes (px)

| Use | Size |
|---|---|
| Facebook/Instagram feed square | 1080 × 1080 |
| Instagram portrait feed | 1080 × 1350 |
| Facebook/Instagram/TikTok story or reel cover | 1080 × 1920 |
| Facebook link ad / shared image | 1200 × 628 |
| Facebook cover | 820 × 312 (render 1640 × 624) |
| LinkedIn post | 1200 × 627 · company banner 1128 × 191 |
| X (Twitter) post | 1600 × 900 · header 1500 × 500 |
| YouTube thumbnail | 1280 × 720 |
| Pinterest pin | 1000 × 1500 |
| Website hero / desktop mockup | 1440 × 900 (full page: `--full-page`) |
| Mobile app screen | 390 × 844 (`--scale 3` for device-sharp) |
| Presentation slide 16:9 | 1920 × 1080 |
| Email header | 600 × 200 |
| A4 poster/flyer (print, 300 dpi) | 2480 × 3508 — or `--pdf --paper A4` |
| A5 flyer | 1748 × 2480 |
| Business card (300 dpi) | 1050 × 600 (85 × 55 mm) |

## Template

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 1080px; height: 1080px; overflow: hidden; background: #fff; }
  .canvas {
    position: relative; width: 1080px; height: 1080px; overflow: hidden;
    font-family: "Inter", "Roboto", system-ui, sans-serif; color: #1a1a1a;
    background: linear-gradient(135deg, #f7efe6, #e8d5c0);
    padding: 72px; display: flex; flex-direction: column; justify-content: space-between;
  }
  .eyebrow { font-size: 26px; letter-spacing: .18em; text-transform: uppercase; opacity: .7; }
  h1 { font-size: 104px; line-height: .98; font-weight: 800; max-width: 12ch; }
  .sub { font-size: 36px; line-height: 1.3; max-width: 26ch; margin-top: 24px; }
  .cta { align-self: flex-start; background: #1a1a1a; color: #fff; font-size: 34px; font-weight: 700;
         padding: 22px 40px; border-radius: 999px; }
  .brand { position: absolute; right: 72px; bottom: 72px; font-weight: 700; font-size: 28px; }
</style>
</head>
<body>
<div class="canvas">
  <div>
    <div class="eyebrow">Grand opening · This Saturday</div>
    <h1>Your first cup is on us.</h1>
    <p class="sub">Fresh-roasted, hand-poured, five minutes from the station.</p>
  </div>
  <div class="cta">Find us on Mill Street →</div>
  <div class="brand">☕ Maple &amp; Bean</div>
</div>
</body>
</html>
```

Change the two `width/height` pairs together when using another size.
