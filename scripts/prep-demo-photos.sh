#!/usr/bin/env bash
# Turns camera-roll photos into the bundled demo scenes.
#
#   1. AirDrop / copy any number of photos into assets/demo/src/
#   2. ./scripts/prep-demo-photos.sh
#
# Handles HEIC (which Metro cannot bundle), center-crops to the phone's exact
# 1320x2868, strips EXIF, and writes scene-1.jpg .. scene-5.jpg. If you supply
# fewer than five, they repeat to fill the slots.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/assets/demo/src"
OUT="$ROOT/assets/demo"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

shopt -s nullglob nocaseglob
FILES=("$SRC"/*.{jpg,jpeg,png,heic,heif,tif,tiff})
shopt -u nocaseglob

if [ ${#FILES[@]} -eq 0 ]; then
  echo "No images found in $SRC" >&2
  echo "Drop photos there first, then re-run." >&2
  exit 1
fi

echo "Found ${#FILES[@]} image(s); normalizing to JPEG…"
i=0
for f in "${FILES[@]}"; do
  i=$((i + 1))
  # sips reads HEIC natively on macOS; PIL does not without extra packages.
  sips -s format jpeg "$f" --out "$TMP/$(printf '%02d' $i).jpg" >/dev/null
done

python3 "$ROOT/scripts/crop_demo_photos.py" "$TMP" "$OUT"
