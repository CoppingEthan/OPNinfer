# OPNinfer sandbox image — the toolchain the assistant's code runs inside.
# FAT by design: the sandbox may have no network (admin toggle), so everything
# useful must be preinstalled. Built once per host (deploy.sh / compose build).
#
#   docker build -t opninfer-sandbox docker/sandbox
#
# 2026-09-02 (owner ask): a good handful of the most common libraries is baked
# in so the agent is not forever waiting on installs — it can still pip/npm
# anything else at runtime (egress network), and every such install is
# TRACKED (Admin → Tools shows the top ones, so the next bake-in is a
# decision made from data). A headless Chromium (Playwright) + fonts + the
# `html2png` renderer make HTML→PNG/PDF export a one-liner: the
# design-graphics skill builds adverts, posts and posters as HTML/CSS and
# exports them at exact sizes — editable, unlike generated images.
#
# /etc/opninfer/packages.json is written LAST from the installed state
# (manifest.py) — never a hand-kept list — and served by sandboxd.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Core system toolchain: Python, media, documents, data, VCS, compression, OCR.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
      ffmpeg imagemagick ghostscript poppler-utils pandoc \
      tesseract-ocr tesseract-ocr-eng \
      libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf-2.0-0 \
      jq csvkit sqlite3 \
      curl wget ca-certificates git openssh-client \
      zip unzip tar gzip bzip2 xz-utils p7zip-full \
      ripgrep less nano tree file \
      build-essential pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Fonts for design work. Each is optional: a package that is missing from the
# archive prints a line instead of failing the build (names differ between
# releases).
RUN apt-get update && for p in \
      fonts-inter fonts-roboto fonts-open-sans fonts-lato fonts-ubuntu \
      fonts-noto-core fonts-noto-color-emoji fonts-liberation2 fonts-dejavu-core \
      fonts-crosextra-carlito fonts-crosextra-caladea fonts-firacode fonts-cantarell \
      fonts-freefont-ttf fonts-noto-mono; do \
      apt-get install -y --no-install-recommends "$p" || echo "font package unavailable: $p"; \
    done && fc-cache -f && rm -rf /var/lib/apt/lists/*

# Node.js 22 (nodesource) + globals the agent reaches for. NODE_PATH lets
# `require()` see the global modules from any script in the workspace.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --no-fund --no-audit \
      pnpm yarn typescript tsx esbuild prettier \
      tailwindcss @tailwindcss/cli \
      sharp marked serve http-server
ENV NODE_PATH=/usr/lib/node_modules

# Python data/document/imaging/web stack (system-wide so the read-only rootfs
# doesn't matter; user installs go to ~/.local on tmpfs).
RUN pip3 install --no-cache-dir --break-system-packages \
      numpy pandas polars pyarrow duckdb scipy scikit-learn statsmodels networkx \
      matplotlib seaborn plotly \
      pillow opencv-python-headless imageio scikit-image qrcode cairosvg svglib fonttools \
      openpyxl xlrd xlsxwriter odfpy \
      python-docx docxtpl pypdf pdfplumber pdf2image python-pptx reportlab markdown jinja2 pytesseract \
      requests httpx beautifulsoup4 lxml html5lib \
      pyyaml toml xmltodict chardet ftfy rapidfuzz \
      tqdm rich tabulate python-dateutil pytz pydantic typer click \
      sqlalchemy fastapi uvicorn flask \
      pytest black ruff \
      mutagen ffmpeg-python moviepy py7zr \
      playwright

# Headless Chromium for Playwright (Python AND Node share one browser dir).
# --with-deps pulls the system libraries Chromium needs. The Node package is
# pinned to the same version as the Python one so both find the same build.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN playwright install --with-deps chromium \
    && PW_VER="$(python3 -c 'from importlib.metadata import version; print(version("playwright"))')" \
    && (npm install -g --no-fund --no-audit "playwright@${PW_VER}" || npm install -g --no-fund --no-audit playwright) \
    && npx --yes playwright install chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache \
    && chmod -R a+rX /opt/ms-playwright

# The renderer the design-graphics skill calls.
COPY html2png.py /usr/local/bin/html2png
RUN chmod 755 /usr/local/bin/html2png && ln -s /usr/local/bin/html2png /usr/local/bin/html2pdf

# Non-root user. ubuntu:24.04 ships a uid-1000 "ubuntu" user — repurpose it.
RUN usermod -l sandbox -d /home/sandbox -m ubuntu && groupmod -n sandbox ubuntu

# What this image has — generated from the installed state, last.
COPY manifest.py /usr/local/lib/opninfer-manifest.py
RUN python3 /usr/local/lib/opninfer-manifest.py && chmod 644 /etc/opninfer/packages.json

ENV MPLCONFIGDIR=/tmp/matplotlib \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    HOME=/home/sandbox

USER sandbox
WORKDIR /workspace
CMD ["sleep", "infinity"]
