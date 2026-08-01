#!/usr/bin/env bash
#
# Head-unit launcher — used by carplay.service (see setup-pi.sh).
#
# Prefers the packaged AppImage if one is available at
# dist/carplay-latest.AppImage (a stable symlink pointed at whatever
# versioned AppImage was last built by `./update.sh` or the AppImage
# fallback in setup-pi.sh).  Falls back to `npm run start`
# (electron-vite preview against out/) if no AppImage is present —
# which keeps the head unit running even when the AppImage build
# step failed and we only got the out/ bundle.
#
# Any extra CLI args are forwarded to whichever backend is used.

set -e
cd "$(dirname "$0")"

if [[ -x dist/carplay-latest.AppImage ]]; then
  exec dist/carplay-latest.AppImage --no-sandbox "$@"
else
  echo "[run.sh] no AppImage at dist/carplay-latest.AppImage — using npm run start"
  exec npm run start -- "$@"
fi
