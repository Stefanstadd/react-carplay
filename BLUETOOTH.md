# Bluetooth on the Raspberry Pi

This head unit talks to your phone via the standard Linux Bluetooth stack:

| Stack piece | What it gives us |
|-------------|------------------|
| **BlueZ** (`bluetoothd`) | device discovery, pairing, A2DP audio routing, AVRCP metadata + transport, Battery percentage |
| **ofono** (`ofonod`) | HFP — making/receiving calls over Bluetooth, mute |
| **obexd** + PBAP | contact sync from the phone's phonebook |
| **PulseAudio** with `module-bluetooth-policy` | actually routes A2DP audio out the Pi's analog/HDMI output |

You only have to set this up **once**.  After that the head unit auto-detects
your phone every time you start the car.

---

## 1. Install packages

```bash
sudo apt update
sudo apt install -y \
  bluez bluez-obexd bluez-tools \
  ofono \
  pulseaudio pulseaudio-module-bluetooth \
  python3-dbus
```

> If you're on Pi OS Bookworm with PipeWire instead of PulseAudio, install
> `pipewire pipewire-pulse wireplumber libspa-0.2-bluetooth` instead of the
> two `pulseaudio*` packages above.

## 2. Enable + start the services

```bash
sudo systemctl enable --now bluetooth
sudo systemctl enable --now ofono
# obexd is a session-bus service, started on demand by dbus-activation — no enable needed
```

User-side PulseAudio is started by your desktop session; on a headless kiosk
boot, run it as the `pi` user:

```bash
systemctl --user enable --now pulseaudio
```

## 3. Allow the `pi` user to talk to BlueZ + ofono

```bash
sudo usermod -aG bluetooth pi
sudo usermod -aG audio pi
# log out + back in (or reboot) for groups to take effect
```

If you see "Rejected send message" in `journalctl -u bluetooth`, the BlueZ
D-Bus policy is denying the kiosk user — that's what the `bluetooth` group
fixes.

## 4. Make the Pi discoverable + auto-accept pairings

Open `/etc/bluetooth/main.conf` with sudo (it's a root-owned system file, so a
plain editor will report it read-only):

```bash
sudo nano /etc/bluetooth/main.conf
```

Set:

```
[General]
Name = SAAB Head Unit
Class = 0x240414        # audio + carkit + handsfree
DiscoverableTimeout = 0
PairableTimeout = 0
JustWorksRepairing = always
FastConnectable = true

[Policy]
AutoEnable = true
```

Then:

```bash
sudo systemctl restart bluetooth
bluetoothctl power on
bluetoothctl discoverable on
bluetoothctl pairable on
bluetoothctl agent NoInputNoOutput
bluetoothctl default-agent
```

## 5. Pair your phone (one time)

On the phone, open Bluetooth settings and pick **SAAB Head Unit**.  Accept
the pairing prompt.  Then in `bluetoothctl` mark it trusted so it
auto-connects next time:

```bash
bluetoothctl trust XX:XX:XX:XX:XX:XX   # your phone's MAC
bluetoothctl connect XX:XX:XX:XX:XX:XX
```

You can also do this from the head unit's **Devices** screen: tap **SCAN**,
then tap the device to connect.

## 6. Phonebook (PBAP) — give the head unit access

When the head unit's **Phone → CONTACTS → SYNC** is pressed, it asks your
phone for the address book over PBAP.  Your phone will show a one-time
"Allow contact sharing" prompt — **accept it** and tick "always allow".

On iPhone: Settings → Bluetooth → tap the (i) next to **SAAB Head Unit** →
enable **Sync Contacts**.

On Android: a notification appears the first time you sync.

## 7. Calls (HFP via ofono)

ofono auto-attaches to any connected HF/AG-capable device.  Verify with:

```bash
/usr/lib/ofono/test/list-modems
```

You should see your phone's MAC as a modem with `VoiceCallManager` online.

Audio routing during a call goes through `module-bluetooth-policy` — when
HFP becomes active, PulseAudio switches the phone to the HSP/HFP profile
automatically.  Nothing to configure manually.

If calls work but there's no audio, check:

```bash
pactl list cards short
pactl list sinks short
```

…and make sure the bluez card profile is `handsfree_head_unit` while in
a call.

## 8. A2DP music + AVRCP metadata

Once the phone connects and the head unit's `MusicView` shows the track
title, you're golden.  Position/duration come from the phone's media player;
play/pause/next/previous on the head unit send AVRCP commands back.

If track info is blank but audio plays, the phone's app isn't publishing
AVRCP metadata — most apps do, but some streaming apps don't.

## 9. Auto-start everything at boot

The head unit Electron app starts via your existing kiosk service.  Just
make sure these are also enabled:

```bash
sudo systemctl enable bluetooth
sudo systemctl enable ofono
systemctl --user enable pulseaudio
```

## 10. EQ visualiser — capture the speaker output

The head unit's EQ bars come from `getUserMedia({audio: true})`, which captures
the system's *default input*.  By default that's the microphone — so the bars
will react to ambient room sound instead of the music.  To make them track
what's actually playing, set the default input to the **monitor source** of
whichever sink is being used for music output.

For a USB DAC (e.g. C-Media USB Audio Device):

```bash
pactl set-default-source alsa_output.usb-C-Media_Electronics_Inc._USB_Audio_Device-00.analog-stereo.monitor
```

Substitute your own sink name — `pactl list sources short | grep monitor`
shows what's available.

**Make it persistent across reboots** with a one-shot user service:

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/pa-default-monitor.service <<'EOF'
[Unit]
Description=Set default audio source to the speaker monitor
After=pipewire-pulse.service
Requires=pipewire-pulse.service

[Service]
Type=oneshot
ExecStart=/usr/bin/pactl set-default-source alsa_output.usb-C-Media_Electronics_Inc._USB_Audio_Device-00.analog-stereo.monitor
RemainAfterExit=yes

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now pa-default-monitor.service
```

**Once A2DP is working** and music is streaming from the phone *through the
Pi*, switch the default to the BT monitor (the head unit's source-selection
regex `/monitor|bluez|bluetooth/i` will then auto-pick it from
enumerateDevices):

```bash
pactl set-default-source bluez_output.4C_79_75_69_EF_9D.1.monitor
```

If the bars only pulse weakly in the bass when music is playing, the head
unit is running its **idle simulation** because `getUserMedia` either failed
or returned a silent source — check the renderer DevTools console for
`[eq]` log lines telling you which input was picked.

## 11. PipeWire bluez profile gotchas

On Bookworm with PipeWire, WirePlumber's default policy treats phones as
*audio sources* (Pi as the A2DP source) and never exposes an `a2dp-sink`
profile — `pactl list cards` shows only `audio-gateway` for the phone's
`bluez_card`.  And if you run ofono, WirePlumber's native HFP backend
collides with ofono on the same D-Bus path.

Drop this file in to fix both:

```bash
sudo mkdir -p /etc/wireplumber/wireplumber.conf.d
sudo nano /etc/wireplumber/wireplumber.conf.d/51-bluez-headunit.conf
```

```
monitor.bluez.properties = {
  bluez5.roles = [ a2dp_sink a2dp_source hfp_hf hfp_ag hsp_hs hsp_ag ]
  bluez5.codecs = [ sbc sbc_xq aac ]
  bluez5.enable-sbc-xq = true
  bluez5.enable-msbc = true
  bluez5.enable-hw-volume = true
  bluez5.hfphsp-backend = "ofono"
}
```

```bash
systemctl --user restart wireplumber pipewire pipewire-pulse
bluetoothctl disconnect <mac> && bluetoothctl connect <mac>
```

Then `pactl list cards` should show `a2dp-sink-aac` / `a2dp-sink-sbc` /
`headset-head-unit` profiles, and `pactl set-card-profile bluez_card.<mac> a2dp-sink-aac`
will activate A2DP audio routing.  On the iPhone, Control Center → audio
widget → AirPlay → **SAAB Head Unit** to start streaming.

If `pactl list cards` shows no bluez card *after* the restart, check
`systemctl --user status wireplumber` — `RegisterProfile() failed:
org.bluez.Error.NotPermitted` means WirePlumber's HFP backend collided with
ofono (check `bluez5.hfphsp-backend = "ofono"` is set above), or ofono is
running but wasn't started cleanly.

## 12. Troubleshooting

| Symptom | Check |
|--------|-------|
| Devices list empty, no scan results | `systemctl status bluetooth`, `bluetoothctl power on` |
| Phone pairs but disconnects instantly | wrong agent — re-run `bluetoothctl agent NoInputNoOutput && bluetoothctl default-agent` |
| Music plays via the Pi but no track info | the phone's media app doesn't publish AVRCP; try another app |
| Track info shows but transport buttons do nothing | AVRCP TG profile not bound — `bluetoothctl info <mac>` should list `0000110e` (A/V Remote Control) under UUIDs |
| `Dial` returns immediately, no call | ofono modem missing — `/usr/lib/ofono/test/list-modems` should list your phone |
| Sync contacts errors | obexd not running, or PBAP permission denied on the phone (re-pair + accept the prompt) |
| `bt:phone connected: false` even though paired | the phone is connected but doesn't advertise a phone icon/HFP UUID — open `bluetoothctl info <mac>` and confirm |

The head unit prints `[bt]` log lines to the Electron main-process console;
run with `npm run dev` to see them live during setup.
