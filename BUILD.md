# Building + running the head unit

## Fresh Pi 5 — first time setup

```bash
git clone https://github.com/Stefanstadd/react-carplay.git
cd react-carplay
./setup-pi.sh
sudo reboot
```

That one script installs everything: system packages (bluez, ofono,
pipewire/wireplumber, parec), Node 20 via NodeSource, the udev rule
for the Carlinkit dongle, the BlueZ + WirePlumber configs that make
HFP calling actually work, user-level linger so services survive a
kiosk boot, a `carplay.service` systemd user unit, `npm ci`, and a
full ARM Linux AppImage build (packaged under
`dist/react-carplay-*-arm64.AppImage`).  A stable symlink
`dist/carplay-latest.AppImage` always points at the newest one so the
systemd service doesn't need editing when the version bumps.

After the reboot the app autostarts.  Pair your phone once from the
Devices screen and calling / music / contacts work out of the box —
see `BLUETOOTH.md` §5-7 for phone-side prompts (PBAP, HFP toggle).

Re-running `./setup-pi.sh` any time is safe — it's idempotent.  Pass
`--skip-build` if you just want to re-apply the OS/BT config without
touching the app, or `--force-build` to rebuild regardless.

## Iterating on code

Stop the packaged app so it doesn't fight the dev server for the
display, then run the Vite dev server:

```bash
systemctl --user stop carplay
npm run dev
```

Editing anything under `src/` hot-reloads.  When you're done, either
`systemctl --user start carplay` to bring the packaged version back, or
just close the dev window (autostart resumes on next boot).

## Pulling latest + rebuilding

```bash
./update.sh
```

This does `git pull`, runs `npm ci` only if `package-lock.json`
changed, then kicks off `npm run build:armLinux` **in the background**
so you can immediately run `npm run dev` while the packaged AppImage
cooks (~5 min on a Pi 5).  When the background build succeeds it
refreshes `dist/carplay-latest.AppImage` → the freshly-built versioned
file and restarts `carplay.service` automatically so the packaged app
picks up the new version.

Flags:
- `./update.sh --no-build` — pull + deps only, don't rebuild.
- `./update.sh --fg` — rebuild in the foreground (blocking).

Progress lives in `build.log`:

```bash
tail -f build.log
```

## Autostart controls

```bash
systemctl --user status  carplay      # is it running?
systemctl --user restart carplay      # after a manual edit
systemctl --user disable carplay      # opt out of autostart
systemctl --user enable  carplay      # opt back in
```

## Manual build targets

The one-shot `setup-pi.sh` and `update.sh` are enough for day-to-day
use, but if you need something specific:

```bash
npm run build            # full: typecheck + electron-vite build
npx electron-vite build  # renderer + main only, skip typecheck
npm run build:armLinux   # produce an AppImage under dist/
npm run typecheck        # tsc, no output
npm run lint             # eslint --fix
```

## Testing on a Windows / macOS laptop

Bluetooth (calls, contacts, AVRCP metadata) is Linux-only — the head unit
talks to BlueZ / ofono / obex over D-Bus, which only exists on Linux.  On
Windows or macOS the Bluetooth manager falls back to a no-op stub so the
app still runs, but the phone / call / contacts screens show empty
states.

CarPlay itself does work off-Pi — it's a WebUSB dongle, no OS-specific
plumbing:

```powershell
# Windows
npm install
npm run dev
```

If the Carlinkit dongle doesn't show up under `navigator.usb`, install a
WinUSB driver with Zadig (https://zadig.akeo.ie/) for the CarPlay device:
VID `0x1314`, PID `0x1520`-`0x1529`.  After that CarPlay works exactly
like on the Pi — video, audio, touch.

### Simulating a paired phone on Windows

To exercise the phone / call / contacts UI without real Bluetooth, set
`CARPLAY_BT_MOCK=1` before starting dev:

```powershell
$env:CARPLAY_BT_MOCK = "1"
npm run dev
```

That surfaces a dev "Dev iPhone" as connected, seeds two dummy contacts,
and drives the media progress bar so the header + music view populate.
No real calls of course — dial() is a no-op without ofono.

## Troubleshooting

- **`git pull` conflict on a locally-edited file**: `git checkout --theirs <file>` takes the remote version.  For tunable knobs, prefer editing them via the Settings screen so config lives in `localStorage` and doesn't collide with the repo.
- **Build fails on typecheck**: pre-existing errors in `src/main/Canbus.ts` / worker files that are unrelated to app functionality.  `setup-pi.sh` and `update.sh` fall back to `npx electron-vite build` (skips typecheck) so the packaged app still ships.
- **Calling doesn't work**: check `BLUETOOTH.md` §7 and the HFP-NOT-READY banner in the app for the exact reason.  Almost always ofono / WirePlumber / BlueZ handoff — `setup-pi.sh` configures all three but a Pi OS upgrade can revert them; re-run the script.
- **Visualizer silent**: `pactl list sources short | grep monitor` should list at least one `.monitor` source that has audio flowing.  See `BLUETOOTH.md` §10.
