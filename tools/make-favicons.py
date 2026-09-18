#!/usr/bin/env python3
"""Generate the docs site's raster favicons from docs/favicon.svg.

docs/favicon.svg is the hand-supplied mascot artwork and is served as-is to
browsers that take SVG favicons. Everything else here is a fallback for the
ones that don't, plus the home-screen and manifest sizes.

The SVG is rasterised by headless Google Chrome (no cairo/rsvg needed), then
downscaled with Pillow.

Run:  python3 tools/make-favicons.py
"""

import os
import subprocess
import tempfile

from PIL import Image

CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
SRC = 'docs/favicon.svg'
OUT = 'docs'
MASTER = 512

PNGS = {
    'favicon-16x16.png': 16,
    'favicon-32x32.png': 32,
    'apple-touch-icon.png': 180,
    'android-chrome-192x192.png': 192,
    'android-chrome-512x512.png': 512,
}


def render_master(tmp):
    page = os.path.join(tmp, 'icon.html')
    shot = os.path.join(tmp, 'icon.png')
    with open(page, 'w') as f:
        f.write('<!doctype html><style>html,body{margin:0}img{display:block;width:100vw;height:100vh}</style>'
                f'<img src="file://{os.path.abspath(SRC)}">')
    subprocess.run([CHROME, '--headless', '--disable-gpu', '--hide-scrollbars',
                    '--force-device-scale-factor=1', f'--window-size={MASTER},{MASTER}',
                    f'--screenshot={shot}', f'file://{page}'],
                   check=True, capture_output=True)
    # The artwork is a full-bleed square, so the result is opaque; drop alpha.
    img = Image.open(shot).convert('RGB')
    assert img.size == (MASTER, MASTER), img.size
    return img


with tempfile.TemporaryDirectory() as tmp:
    master = render_master(tmp)

for name, size in PNGS.items():
    path = os.path.join(OUT, name)
    (master if size == MASTER else master.resize((size, size), Image.LANCZOS)).save(path)
    print(f'wrote {path} ({size}x{size})')

ico = os.path.join(OUT, 'favicon.ico')
master.save(ico, sizes=[(16, 16), (32, 32), (48, 48)])
print(f'wrote {ico} (16, 32, 48)')
