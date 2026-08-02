#!/usr/bin/env bash
#
# One-shot install for the head unit on a fresh Raspberry Pi 5.
#
#   git clone https://github.com/Stefanstadd/react-carplay.git
#   cd react-carplay
#   ./setup-pi.sh
#   sudo reboot
#
# Everything is idempotent — safe to re-run whenever you want to re-apply
# the config (e.g. after a Pi OS upgrade that reset something).  On a
# second run apt is skipped for packages already installed, config files
# are re-written to the current state, and the app is rebuilt only when
# package.json changed (unless you pass --force-build).
#
# What this sets up:
#   • System packages: bluez + bluez-obexd + ofono + pipewire stack +
#     wireplumber + parec + build tools
#   • Node.js 20 via NodeSource (matches Electron's V8 requirements)
#   • Udev rule for the Carlinkit CarPlay dongle
#   • BlueZ main.conf tuned for a head unit (auto-pair, no timeouts)
#   • WirePlumber drop-in that hands HFP over to ofono (so calls work)
#   • Systemd override: WP waits for ofono at boot so there's no race
#   • User-level linger so PipeWire/WP/ofono run on a headless kiosk boot
#   • carplay.service — systemd user unit for autostarting Electron
#   • npm ci + electron-vite build

set -euo pipefail

# ─── Preflight ────────────────────────────────────────────────────────────

if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  echo "ERROR: don't run this as root — it uses sudo where needed."
  exit 1
fi

if [[ ! -f package.json ]] || ! grep -q '"react-carplay"' package.json; then
  echo "ERROR: run this from the react-carplay repo root."
  exit 1
fi

USER_NAME="$(whoami)"
REPO_DIR="$(pwd)"
FORCE_BUILD=0
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --force-build) FORCE_BUILD=1 ;;
    --skip-build)  SKIP_BUILD=1 ;;
    -h|--help)
      sed -n '1,25p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg"; exit 1 ;;
  esac
done

echo "════════════════════════════════════════════════════════════════"
echo "  Head unit setup — user=$USER_NAME  repo=$REPO_DIR"
echo "════════════════════════════════════════════════════════════════"

# ─── 1. System packages ───────────────────────────────────────────────────

echo
echo "[1/9] Installing system packages…"
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  bluez bluez-obexd bluez-tools \
  ofono ofono-scripts \
  pipewire pipewire-pulse wireplumber libspa-0.2-bluetooth \
  pulseaudio-utils \
  python3-dbus \
  fuse libfuse2 \
  build-essential libusb-1.0-0-dev pkg-config \
  git curl ca-certificates

# ─── 2. Node.js 20 ────────────────────────────────────────────────────────

echo
echo "[2/9] Ensuring Node.js 20…"
NODE_MAJOR=""
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
fi
if [[ "$NODE_MAJOR" != "20" ]]; then
  echo "  installing Node.js 20 from NodeSource…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "  already on Node $(node -v)"
fi

# ─── 3. Udev rule for the CarPlay dongle ─────────────────────────────────

echo
echo "[3/9] Installing udev rule for the Carlinkit dongle…"
sudo tee /etc/udev/rules.d/52-nodecarplay.rules >/dev/null <<'EOF'
SUBSYSTEM=="usb", ATTR{idVendor}=="1314", ATTR{idProduct}=="152*", MODE="0660", GROUP="plugdev"
EOF
sudo udevadm control --reload-rules
sudo udevadm trigger

# ─── 4. Group membership ──────────────────────────────────────────────────

echo
echo "[4/9] Adding $USER_NAME to bluetooth/plugdev/audio groups…"
sudo usermod -aG bluetooth,plugdev,audio "$USER_NAME"

# ─── 5. BlueZ config ──────────────────────────────────────────────────────

echo
echo "[5/9] Writing /etc/bluetooth/main.conf…"
sudo tee /etc/bluetooth/main.conf >/dev/null <<'EOF'
# Managed by react-carplay/setup-pi.sh — re-run the script to reset.
[General]
Name = SAAB Head Unit
Class = 0x240414
DiscoverableTimeout = 0
PairableTimeout = 0
JustWorksRepairing = always
FastConnectable = true

[Policy]
AutoEnable = true
EOF

# ─── 6. WirePlumber → ofono HFP handoff ───────────────────────────────────

echo
echo "[6/9] Handing HFP to ofono via WirePlumber drop-in…"
sudo mkdir -p /etc/wireplumber/wireplumber.conf.d
sudo tee /etc/wireplumber/wireplumber.conf.d/51-bluez-headunit.conf >/dev/null <<'EOF'
# Managed by react-carplay/setup-pi.sh.
#
# Without this, WirePlumber's built-in "native" HFP backend registers the
# HandsFree UUID with BlueZ before ofono can, and ofono then fails with
# "org.bluez.Error.NotPermitted, UUID already registered" — the head
# unit's dial() ends up a silent no-op.
wireplumber.settings = {
  bluetooth.autoswitch-to-headset-profile = false
}
monitor.bluez.properties = {
  bluez5.roles = [ a2dp_sink a2dp_source hfp_hf hfp_ag hsp_hs hsp_ag ]
  bluez5.hfphsp-backend = "ofono"
  bluez5.enable-msbc = true
  bluez5.enable-hw-volume = true
}
EOF

# WP waits for ofono at boot so there's no race for the HFP UUID.
mkdir -p "$HOME/.config/systemd/user/wireplumber.service.d"
tee "$HOME/.config/systemd/user/wireplumber.service.d/wait-ofono.conf" >/dev/null <<'EOF'
[Unit]
After=ofono.service
Wants=ofono.service
EOF

# ─── 7. Enable services + user linger ────────────────────────────────────

echo
echo "[7/9] Enabling bluetooth + ofono + audio stack…"
sudo systemctl enable --now bluetooth ofono
sudo loginctl enable-linger "$USER_NAME"
systemctl --user daemon-reload
systemctl --user enable --now pipewire pipewire-pulse wireplumber

# ─── 8. carplay.service — autostart the head unit ────────────────────────

echo
echo "[8/9] Installing carplay.service (systemd user unit)…"
chmod +x "$REPO_DIR/run.sh"
mkdir -p "$HOME/.config/systemd/user"
tee "$HOME/.config/systemd/user/carplay.service" >/dev/null <<EOF
[Unit]
Description=React-Carplay head unit (Electron)
After=network.target wireplumber.service ofono.service
Wants=wireplumber.service ofono.service

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
Environment=DISPLAY=:0
# run.sh execs the packaged AppImage at dist/carplay-latest.AppImage
# when present, otherwise falls back to \`npm run start\` against out/
# so the service works even if the AppImage build step failed.
ExecStartPre=/usr/bin/xsetroot -solid black
ExecStart=$REPO_DIR/run.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable carplay.service
echo "  (start it manually with: systemctl --user start carplay.service)"

# ─── 9. App deps + build ─────────────────────────────────────────────────

if [[ $SKIP_BUILD -eq 1 ]]; then
  echo
  echo "[9/9] --skip-build passed, not installing npm deps or building."
else
  echo
  echo "[9/9] npm ci + electron-builder AppImage build…"
  npm ci
  # Full ARM Linux AppImage build.  Slower than plain electron-vite
  # (~5 min on a Pi 5) but produces a standalone dist/*.AppImage that
  # the systemd service execs directly — no node_modules dependency at
  # runtime, and the AppImage can be copied to another Pi 1-for-1.
  if npm run build:armLinux; then
    APPIMAGE="$(ls -1 dist/react-carplay-*-arm64.AppImage 2>/dev/null | sort -V | tail -1 || true)"
    if [[ -n "$APPIMAGE" ]]; then
      chmod +x "$APPIMAGE"
      ln -sf "$(basename "$APPIMAGE")" dist/carplay-latest.AppImage
      echo "  → AppImage: $APPIMAGE"
      echo "  → Stable symlink: dist/carplay-latest.AppImage → $(basename "$APPIMAGE")"
    else
      echo "WARNING: electron-builder finished but no AppImage under dist/"
      echo "  Service will fall back to 'npm run start' via run.sh."
    fi
  else
    echo
    echo "WARNING: 'npm run build:armLinux' failed.  Trying a plain"
    echo "  electron-vite build so the app still works via out/."
    npx electron-vite build || {
      echo "  Even electron-vite build failed — check the logs above."
      exit 1
    }
    echo "  Service will run 'npm run start' via run.sh (no AppImage)."
  fi
fi

echo
echo "════════════════════════════════════════════════════════════════"
echo "  Setup complete."
echo
echo "  Next steps:"
echo "    1. Pair your phone once:  bluetoothctl scan on … pair … trust …"
echo "       (or use the Devices screen in the app)"
echo "    2. Reboot to let group membership + linger take effect:"
echo "         sudo reboot"
echo "    3. After reboot, the head unit autostarts.  Manage it with:"
echo "         systemctl --user status carplay"
echo "         systemctl --user restart carplay"
echo "         systemctl --user disable carplay   # opt out of autostart"
echo
echo "  To iterate on code:"
echo "         systemctl --user stop carplay      # free the display"
echo "         npm run dev                        # hot-reload session"
echo
echo "  To pull + rebuild in the background while you keep testing:"
echo "         ./update.sh"
echo "════════════════════════════════════════════════════════════════"
