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

BUILD_CMD="npm run build"
LOG=build.log

if [[ "$MODE" == "fg" ]]; then
  echo
  echo "▶ $BUILD_CMD (foreground)"
  $BUILD_CMD 2>&1 | tee "$LOG"
  restart_service_if_enabled
  exit $?
fi

# Background build.  nohup + setsid so it survives the shell closing,
# writes to build.log, and we print the PID so the user can kill it or
# tail the log.
if pgrep -f "electron-vite build" >/dev/null; then
  echo
  echo "A build is already running (see build.log).  Aborting to avoid clashes."
  exit 1
fi

echo
echo "▶ $BUILD_CMD (background, logging to $LOG)"
: > "$LOG"

nohup bash -c '
  set -o pipefail
  npm run build 2>&1
  code=$?
  if [[ $code -eq 0 ]] && systemctl --user is-enabled carplay.service >/dev/null 2>&1; then
    echo ""
    echo "── build succeeded, restarting carplay.service ──"
    systemctl --user restart carplay.service || true
  elif [[ $code -ne 0 ]]; then
    echo ""
    echo "── build FAILED (exit $code) — carplay.service not touched ──"
  fi
  exit $code
' >>"$LOG" 2>&1 &
BUILD_PID=$!
disown "$BUILD_PID" || true

echo
echo "Background build started, PID $BUILD_PID."
echo "  Tail progress:   tail -f $LOG"
echo "  Kill it:         kill $BUILD_PID"
echo
echo "You can now run:   npm run dev"
echo "The packaged app will restart automatically once the build finishes"
echo "(if carplay.service is enabled)."
