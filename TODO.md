# Head Unit Project — TODO

Legend: `[x]` done · `[ ]` pending · `[~]` in progress · `[!]` user action needed

---

## Done (most recent first)
- [x] Navbar redesign #2: removed curved line, 5 PNG icons (Mobile/Gauges/Music/Phone/Settings),
       selected icon animates to the center slot with the others shifting around it; selected
       button uses inverted style (bright green bg, dark icon)
- [x] Music screen rework: EQ visualizer moved to top-right with frequency labels under each
       bar; bars are darker green by default, jump to bright green above 85% threshold;
       transport controls + progress bar moved to the bottom of the main area; quick-access
       shortcut buttons (CarPlay, Recent Calls, Contacts, Gauges, Devices) replace the player
       in the left sidebar; album art is now a square shifted down into the info row
- [x] Gauges screen: slimmer sidebar (320px), all gauges same size/color, flex-wrap grid that
       handles more gauges in the future
- [x] Phone screen: tab buttons now show their icons (contacts.png, recent calls.png, phone.png)
- [x] Inverted button style: removed all outlines, hover/active state = bright green
       background with dark icon and text
- [x] Bumped small text sizes for readability on the physical 5.5" screen
- [x] Screen switch slide animation: tapping a screen to the right of current → current slides
       left, new comes from right; tapping a screen to the left → current slides right, new
       comes from left
- [x] Initial HeadUnit prototype (music, devices, gauges, phone screens)
- [x] SAAB ICM2 green phosphor / scan-line visual style
- [x] CRT scan-line overlay, glow effects, Share Tech Mono font
- [x] Exit button overlay on CarPlay screen
- [x] Fix CarPlay blank page on re-entry (MessageChannels were module-level singletons;
       ports got neutered after first mount — moved inside component with useMemo)
- [x] Scale all UI elements to 1920×1080 (fonts, touch targets, gauge SVGs, navbar)
- [x] Fix html/body/root full-height so all screens share the same viewport
- [x] Switch font to VT323 (pixelated ICM2 style, replaces Share Tech Mono)
- [x] Dark green background (#011301) replacing pure black
- [x] Remove all button glows / box-shadows
- [x] Left-sidebar layout on every screen (matches mockup)
- [x] Navbar redesign: curved SVG kept, center peak shows CURRENT screen icon,
       surrounding slots are prev/next views (carousel), settings icon far right
- [x] New pixelated nav icons: sideways phone, speedometer, music note, filled handset, sliders
- [x] No text labels on navbar icons
- [x] Gauges: 3-gauge layout (Oil Temp/Speed/RPM), center gauge larger+bright, sides smaller+dim;
       sidebar shows numeric values for Oil Pressure and Battery
- [x] Settings button moved to navbar far right (was center peak three-dot button)
- [x] Screen scaling: translate+scale approach with resize listener — correct
       proportions at any window size (fullscreen = 1:1, windowed = letterboxed)

---

## Claude's Work Queue
- [ ] CarPlay loading screen — replace MUI spinner with ICM2-styled indicator
       (green animated ring or scan-line wipe effect)
- [ ] OBD-II / CAN live data wired into GaugesView
       (currently shows static mock values; Canbus.ts already exists in main)
- [ ] Devices screen — show real connected BT device name instead of hardcoded "iPhone 14 Pro"
- [ ] Music screen — wire real playback position/duration from MediaSession when available
- [ ] Phone screen — integrate with OS telephony or BT HFP instead of mock contacts
- [ ] Settings screen — restyle to match ICM2 theme (currently uses MUI default)
- [ ] Camera view — restyle overlay to match ICM2 theme
- [ ] Reverse camera modal — ICM2 border/overlay styling

---

## User's Work Queue
- [!] Verify CarPlay re-entry fix on real hardware (plug in, launch CarPlay, exit, re-enter)
- [!] Check 1920×1080 layout on the physical 5.5-inch screen — confirm font sizes feel right
       at dashboard viewing distance; report anything too small or too large
- [!] Confirm window size in config.json matches 1920×1080
       (check %APPDATA%\Electron\config.json — width/height fields)
- [!] Test touch target sizes on the actual screen (buttons, numpad keys, nav items)

---

## Future Ideas
- [ ] Animated boot/splash screen in ICM2 style (horizontal scan line wipe)
- [ ] Climate control screen (temperature, fan speed, seat heat — via CAN)
- [ ] Trip computer screen (odometer, avg speed, fuel economy — via CAN/OBD)
- [ ] Day / night mode toggle (dimmer green palette for night driving)
- [ ] Haptic / audio feedback on button press
- [ ] Wireless CarPlay support (if dongle supports it)
- [ ] GPS / navigation mini-map widget in the header bar
- [ ] Screen brightness control (tied to ambient light or time of day)
- [ ] CarPlay audio now-playing info mirrored to the HeadUnit music screen
       when CarPlay is active
