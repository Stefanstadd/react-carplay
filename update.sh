#!/usr/bin/env bash
#
# Pull latest, update deps if needed, and rebuild in the background so you
# can keep iterating with `npm run dev` while the packaged build cooks.
#
# Usage:
#   ./update.sh                 # pull + npm ci (if needed) + background build
#   ./update.sh --no-build      # just pull + npm ci, don't rebuild
#   ./update.sh --fg            # rebuild in foreground (block until done)
#
# Log lives at build.log; check progress with:
#   tail -f build.log
#
# When the background build finishes it restarts carplay.service (if
# enabled) so the packaged app picks up the new bits automatically.

set -euo pipefail

if [[ ! -f package.json ]] || ! grep -q '"react-carplay"' package.json; then
  echo "ERROR: run this from the react-carplay repo root."
  exit 1
fi

MODE=bg
for arg in "$@"; do
  case "$arg" in
    --no-build) MODE=none ;;
    --fg)       MODE=fg   ;;
    -h|--help)  sed -n '1,17p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg"; exit 1 ;;
  esac
done

echo "▶ git pull"
LOCKFILE_BEFORE="$(sha1sum package-lock.json 2>/dev/null | cut -d' ' -f1 || true)"
git pull --ff-only
LOCKFILE_AFTER="$(sha1sum package-lock.json 2>/dev/null | cut -d' ' -f1 || true)"

if [[ "$LOCKFILE_BEFORE" != "$LOCKFILE_AFTER" ]]; then
  echo
  echo "▶ package-lock.json changed — running npm ci"
  npm ci
else
  echo "  (deps unchanged, skipping npm ci)"
fi

if [[ "$MODE" == "none" ]]; then
  echo
  echo "Done.  --no-build passed, not rebuilding."
  exit 0
fi

LOG=build.log
# Full ARM Linux AppImage build — matches setup-pi.sh so update.sh
# refreshes the exact artifact carplay.service execs.  We wrap it in a
# small shell fragment that, on success, updates the stable symlink
# dist/carplay-latest.AppImage → the freshly-built versioned file so
# run.sh keeps working across version bumps.
BUILD_SCRIPT='
set -o pipefail
npm run build:armLinux
code=$?
if [[ $code -eq 0 ]]; then
  APPIMAGE="$(ls -1 dist/react-carplay-*-arm64.AppImage 2>/dev/null | sort -V | tail -1 || true)"
  if [[ -n "$APPIMAGE" ]]; then
    chmod +x "$APPIMAGE"
    ln -sf "$(basename "$APPIMAGE")" dist/carplay-latest.AppImage
    echo "── new AppImage: $APPIMAGE ──"
  fi
  if systemctl --user is-enabled carplay.service >/dev/null 2>&1; then
    echo "── restarting carplay.service ──"
    systemctl --user restart carplay.service || true
  fi
else
  echo "── build FAILED (exit $code) — carplay.service not touched ──"
fi
exit $code
'

ensure_service() {
  # Write (or rewrite) the service unit so that a plain `./update.sh` on an
  # existing Pi installation also fixes a broken/missing service — no need to
  # re-run the full setup-pi.sh just to get autostart working.
  local repo_dir
  repo_dir="$(cd "$(dirname "$0")" && pwd)"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/carplay.service" <<EOF
[Unit]
Description=React-Carplay head unit (Electron)
After=network.target wireplumber.service ofono.service
Wants=wireplumber.service ofono.service

[Service]
Type=simple
WorkingDirectory=$repo_dir
Environment=DISPLAY=:0
ExecStartPre=/usr/bin/xsetroot -solid black
ExecStart=$repo_dir/run.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable carplay.service
  # Ensure linger is on so user services survive without a login session.
  sudo loginctl enable-linger "$(whoami)" 2>/dev/null || true
}

if [[ "$MODE" == "fg" ]]; then
  echo
  echo "▶ npm run build:armLinux (foreground)"
  ensure_service
  bash -c "$BUILD_SCRIPT" 2>&1 | tee "$LOG"
  exit "${PIPESTATUS[0]}"
fi

# Background build.  nohup + disown so it survives the shell closing,
# writes to build.log, and we print the PID so the user can tail or kill.
if pgrep -f "electron-vite build\|electron-builder" >/dev/null; then
  echo
  echo "A build is already running (see build.log).  Aborting to avoid clashes."
  exit 1
fi

echo
echo "▶ ensuring carplay.service is installed and enabled…"
ensure_service

echo
echo "▶ npm run build:armLinux (background, logging to $LOG)"
: > "$LOG"
nohup bash -c "$BUILD_SCRIPT" >>"$LOG" 2>&1 &
BUILD_PID=$!
disown "$BUILD_PID" || true

echo
echo "Background build started, PID $BUILD_PID."
echo "  Tail progress:   tail -f $LOG"
echo "  Kill it:         kill $BUILD_PID"
echo
echo "You can now run:   npm run dev"
echo "The packaged AppImage will replace itself + restart carplay.service"
echo "automatically once the build finishes (if the service is enabled)."
