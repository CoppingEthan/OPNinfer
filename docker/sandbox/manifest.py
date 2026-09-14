#!/usr/bin/env python3
"""Write /etc/opninfer/packages.json — what this image has PREINSTALLED.

Generated at build time from the installed state (pip, npm -g, dpkg), never
from a hand-kept list, so it cannot drift from the image. sandboxd serves it
to the app, and Admin → Tools marks each package the agent reached for as
already in the image or not — that is how the admin decides what to bake in
next (owner ask, 2026-09-02).
"""
import json
import pathlib
import subprocess


def run(cmd: list[str]) -> str:
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def pep503(name: str) -> str:
    """PEP 503 normalisation: case-insensitive, runs of -_. collapse to -."""
    import re

    return re.sub(r"[-_.]+", "-", name).lower()


python = sorted({pep503(p["name"]) for p in json.loads(run(["pip3", "list", "--format=json"]))})
try:
    node = sorted(json.loads(run(["npm", "ls", "-g", "--json", "--depth=0"])).get("dependencies", {}).keys())
except subprocess.CalledProcessError as e:  # npm ls exits 1 on peer warnings but still prints JSON
    node = sorted(json.loads(e.stdout).get("dependencies", {}).keys()) if e.stdout else []
apt = sorted(run(["dpkg-query", "-W", "-f=${Package}\n"]).split())

out = {
    "python": python,
    "node": node,
    "apt": apt,
    # Commands worth naming on the admin card (not packages, but what people
    # ask "can it do X?" about).
    "tools": ["html2png", "chromium (playwright)", "ffmpeg", "imagemagick", "pandoc", "tesseract", "git", "node", "python3"],
}
pathlib.Path("/etc/opninfer").mkdir(parents=True, exist_ok=True)
pathlib.Path("/etc/opninfer/packages.json").write_text(json.dumps(out, separators=(",", ":")))
print(f"manifest: {len(python)} python, {len(node)} node, {len(apt)} apt packages")
