#!/usr/bin/env bash
# App Store screenshot capture. Boots the 6.9" simulator (1320 x 2868 — the
# size Apple requires), cleans up the status bar, and builds the app with demo
# mode on so it shows a staged photo instead of the camera the simulator lacks.
#
#   ./scripts/screenshots.sh          # boot, prep, build, launch
#   ./scripts/screenshots.sh shot 01-viewfinder
#
# Screenshots land in ~/Desktop/appstore/.
set -euo pipefail

DEVICE="${DEVICE:-iPhone 17 Pro Max}"
OUT="${OUT:-$HOME/Desktop/appstore}"

prep() {
  xcrun simctl boot "$DEVICE" 2>/dev/null || true
  open -a Simulator
  # Wait for the device to finish booting before overriding the status bar.
  xcrun simctl bootstatus "$DEVICE" -b >/dev/null 2>&1 || true
  xcrun simctl status_bar "$DEVICE" override \
    --time "9:41" \
    --batteryState charged --batteryLevel 100 \
    --cellularMode active --cellularBars 4 \
    --dataNetwork wifi --wifiMode active --wifiBars 3
  mkdir -p "$OUT"
}

case "${1:-run}" in
  shot)
    name="${2:?usage: $0 shot <name>}"
    xcrun simctl io booted screenshot "$OUT/$name.png"
    sips -g pixelWidth -g pixelHeight "$OUT/$name.png" | tail -2
    ;;
  prep)
    prep
    ;;
  run)
    prep
    EXPO_PUBLIC_DEMO=1 npx expo run:ios --device "$DEVICE"
    ;;
  *)
    echo "usage: $0 [run|prep|shot <name>]" >&2; exit 1
    ;;
esac
