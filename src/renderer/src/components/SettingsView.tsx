// Full settings panel.  Lives as an overlay over the music carousel; the
// HeadUnit header + nav-bar stay visible above/below.  Sub-pages live in
// a sidebar (same pattern as PhoneView):
//   • General   — theme colours, swatches, picker, presets
//   • Visualizer — viz config sliders with a live preview
//   • Equalizer — sidebar shortcut — opens the EQView overlay directly
//   • CarPlay   — themed dongle config; SAVE reloads only the renderer
//   • Gauges    — define gauges for the dash (CAN-key, min, max, label)

import { useEffect, useState } from 'react'
import {
  useUserSettings,
  applyTheme,
  allThemes,
  BUILTIN_THEMES,
  DEFAULT_VIZ,
  type GaugeDef,
  type VizConfig
} from './userSettings'
import VizCanvas from './VizCanvas'
import { useScrollContainer } from './HeadUnit'
import NameKeyboard from './NameKeyboard'
import { useCarplayStore } from '../store/store'
import type { ExtraConfig } from '../../../main/Globals'

type SubPage = 'general' | 'viz' | 'carplay' | 'gauges'

// EQUALIZER is a shortcut, not a page — tapping it in the sidebar opens the
// EQ overlay directly instead of showing a landing sub-page with a redundant
// "Open equalizer" button.
type SidebarItem =
  | { kind: 'page'; id: SubPage; label: string }
  | { kind: 'action'; id: 'eq'; label: string }

const PAGES: SidebarItem[] = [
  { kind: 'page', id: 'general', label: 'GENERAL' },
  { kind: 'page', id: 'viz', label: 'VISUALIZER' },
  { kind: 'action', id: 'eq', label: 'EQUALIZER' },
  { kind: 'page', id: 'carplay', label: 'CARPLAY' },
  { kind: 'page', id: 'gauges', label: 'GAUGES' }
]

interface SettingsViewProps {
  isActive: boolean
  onOpenEqualizer: () => void
}

export default function SettingsView({
  isActive,
  onOpenEqualizer
}: SettingsViewProps) {
  const us = useUserSettings()
  const [page, setPage] = useState<SubPage>('general')
  // Same touch-scroll pattern as the contacts list — no native scrollbar,
  // just a finger-drag with momentum that doesn't fight the global
  // `touch-action: none` on the App root.
  const scroll = useScrollContainer<HTMLDivElement>()
  // Picker lives at the SettingsView level so the slide-in panel anchors
  // to the settings screen only (right side of it — the sidebar stays
  // visible and the phone nav bar / header don't get covered).  Starts
  // closed on every mount so it "hides for next time" automatically.
  const [picker, setPicker] = useState<{ key: ColorKey; label: string } | null>(null)

  return (
    <div className="hu-screen hu-settings-screen">
      <div className="hu-sidebar">
        <div className="hu-panel-label">SETTINGS</div>
        {PAGES.map((p) => {
          const active = p.kind === 'page' && page === p.id
          return (
            <button
              key={p.id}
              className={`hu-list-btn${active ? ' hu-list-btn-active' : ''}`}
              onClick={() => {
                if (p.kind === 'action' && p.id === 'eq') {
                  onOpenEqualizer()
                  return
                }
                if (p.kind === 'page') {
                  setPage(p.id)
                  if (scroll.ref.current) scroll.ref.current.scrollTop = 0
                }
              }}
            >
              <span>{p.label}</span>
            </button>
          )
        })}
      </div>

      <div className="hu-main-area hu-settings-scroll" ref={scroll.ref} {...scroll.handlers}>
        {page === 'general' && <GeneralPage us={us} onOpenPicker={setPicker} />}
        {page === 'viz' && <VizPage us={us} vizActive={isActive} />}
        {page === 'carplay' && <CarplayPage />}
        {page === 'gauges' && <GaugesPage us={us} />}
      </div>

      {picker && (
        <ColorPickerPanel
          label={picker.label}
          value={us.state.theme[picker.key]}
          onChange={(hex) => us.setTheme({ [picker.key]: hex } as any)}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  )
}

// ─── General (colors) ───────────────────────────────────────────────────────

type ColorKey = 'primary' | 'peak' | 'background' | 'warn' | 'miss' | 'shadow' | 'glow'

function GeneralPage({
  us,
  onOpenPicker
}: {
  us: ReturnType<typeof useUserSettings>
  onOpenPicker: (p: { key: ColorKey; label: string }) => void
}) {
  const presets = allThemes(us.state)
  const [kbOpen, setKbOpen] = useState(false)

  const pickPreset = (name: string) => {
    const p = presets.find((x) => x.name === name)
    if (!p) return
    us.setTheme({
      primary: p.primary,
      peak: p.peak,
      background: p.background,
      warn: p.warn,
      miss: p.miss,
      shadow: p.shadow,
      glow: p.glow,
      activePreset: name
    })
  }

  const defaultThemeName = () => {
    let i = 1
    const taken = new Set(us.state.theme.customPresets.map(p => p.name.toLowerCase()))
    while (taken.has(`custom ${i}`)) i++
    return `Custom ${i}`
  }

  const COLORS: { key: ColorKey; label: string; hint: string }[] = [
    { key: 'primary', label: 'PRIMARY', hint: 'Text, borders, icons' },
    { key: 'peak', label: 'PEAK', hint: 'Visualizer peak markers & gauge needles' },
    { key: 'glow', label: 'GLOW', hint: 'Colour bars bloom to at their peak height' },
    { key: 'shadow', label: 'SHADOW', hint: 'Drop-shadow behind bars + call-popup pulse' },
    { key: 'background', label: 'BACKGROUND', hint: 'Screen base color' },
    { key: 'warn', label: 'WARN', hint: 'Over-redline / temp warnings' },
    { key: 'miss', label: 'MISS', hint: 'Missed call indicator' }
  ]

  return (
    <div className="hu-settings-page">
      <div className="hu-panel-label">COLORS</div>

      {COLORS.map((c) => (
        <div key={c.key} className="hu-settings-row">
          <div className="hu-settings-row-label">{c.label}</div>
          <div className="hu-settings-row-body">
            {/* Head-unit-styled swatch — tap to open the centered picker
             *  overlay.  Hex code is intentionally omitted here so the
             *  row stays clean on the small screen. */}
            <button
              className="hu-color-swatch"
              style={{ background: us.state.theme[c.key] }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onOpenPicker({ key: c.key, label: c.label })}
              aria-label={`Pick ${c.label}`}
            />
            <div className="hu-settings-hint">{c.hint}</div>
          </div>
        </div>
      ))}

      <div className="hu-panel-label" style={{ marginTop: 24 }}>
        PRESETS
      </div>
      <div className="hu-theme-swatches">
        {presets.map((p) => {
          const isActive = us.state.theme.activePreset === p.name
          return (
            <button
              key={p.name}
              className={`hu-theme-swatch${isActive ? ' hu-theme-swatch-active' : ''}`}
              onClick={() => pickPreset(p.name)}
              /* Same pointerdown trick as the call buttons — keeps the page
               * scroll container from claiming the touch when finger jitter
               * crosses its 8 px threshold mid-tap. */
              onPointerDown={(e) => e.stopPropagation()}
            >
              {/* Five-band preview: background, primary, peak, glow, shadow —
                  gives the user a real sense of what they'd get before applying. */}
              <div className="hu-theme-swatch-preview">
                <div className="hu-theme-swatch-band" style={{ background: p.background }} />
                <div className="hu-theme-swatch-band" style={{ background: p.primary }} />
                <div className="hu-theme-swatch-band" style={{ background: p.peak }} />
                <div className="hu-theme-swatch-band" style={{ background: p.glow ?? '#ffffff' }} />
                <div
                  className="hu-theme-swatch-band"
                  style={{ background: p.shadow ?? p.primary }}
                />
              </div>
              <div className="hu-theme-swatch-name">{p.name.toUpperCase()}</div>
              {!p.builtin && (
                <button
                  className="hu-theme-swatch-delete"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    us.deleteThemePreset(p.name)
                  }}
                  aria-label="Delete preset"
                >
                  ✕
                </button>
              )}
            </button>
          )
        })}
      </div>

      {/* Picker moved up to SettingsView so it anchors to the settings
       *  screen (right side, sidebar stays visible) instead of covering
       *  the whole app. */}

      <div className="hu-settings-row" style={{ marginTop: 24 }}>
        <button className="hu-eq-action" onClick={() => setKbOpen(true)}>
          Save current as preset
        </button>
      </div>

      {kbOpen && (
        <NameKeyboard
          prompt="THEME NAME"
          initial={defaultThemeName()}
          onCancel={() => setKbOpen(false)}
          onAccept={(name) => {
            us.saveThemePreset(name)
            setKbOpen(false)
          }}
        />
      )}
    </div>
  )
}

// ─── Custom color picker ────────────────────────────────────────────────────
// Head-unit styled picker.  Slides in from the right on top of the settings
// screen; HSL sliders + hex preview + a strip of theme-relevant preset
// swatches for one-tap picks.  Dismisses on DONE, on the backdrop, or on
// escape — component state is scoped to the caller so the picker starts
// closed the next time the Settings screen mounts.

function hexToHsl(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0, 0, 50]
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 0xff) / 255
  const g = ((n >> 8) & 0xff) / 255
  const b = (n & 0xff) / 255
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  const l = (max + min) / 2
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)]
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360
  s = Math.max(0, Math.min(100, s)) / 100
  l = Math.max(0, Math.min(100, l)) / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0,
    g = 0,
    b = 0
  if (h < 60) {
    r = c
    g = x
  } else if (h < 120) {
    r = x
    g = c
  } else if (h < 180) {
    g = c
    b = x
  } else if (h < 240) {
    g = x
    b = c
  } else if (h < 300) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }
  const to255 = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${to255(r)}${to255(g)}${to255(b)}`
}

// A small strip of built-in-theme colours the user can tap for a one-shot
// pick.  Rendered inside the picker panel below the sliders.
const QUICK_SWATCHES = [
  '#00ff0a',
  '#00e8d0',
  '#00b3ff',
  '#7ad8ff',
  '#dfe7f0',
  '#ffffff',
  '#ffb000',
  '#ffd900',
  '#ff6b1a',
  '#ff4400',
  '#ff2244',
  '#ff3aa0',
  '#ff9ce0',
  '#ffaa33',
  '#005c04',
  '#001500',
  '#0a0e14',
  '#1a0f00'
]

function ColorPickerPanel({
  label,
  value,
  onChange,
  onClose
}: {
  label: string
  value: string
  onChange: (hex: string) => void
  onClose: () => void
}) {
  const [h, s, l] = hexToHsl(value)

  // Escape closes.  Traps the key so we don't fire other global handlers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const swallow = (e: React.PointerEvent) => e.stopPropagation()

  return (
    <div className="hu-picker-overlay" onPointerDown={onClose}>
      <div className="hu-picker-panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="hu-picker-header">
          <div className="hu-panel-label" style={{ marginBottom: 0, borderBottom: 'none' }}>
            {label}
          </div>
          <button className="hu-picker-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="hu-picker-preview" style={{ background: value }} />

        <div className="hu-picker-slider-row">
          <div className="hu-picker-slider-label">HUE</div>
          <input
            type="range"
            min={0}
            max={359}
            step={1}
            value={h}
            className="hu-picker-slider hu-picker-slider-hue"
            onChange={(e) => onChange(hslToHex(+e.target.value, s, l))}
            onPointerDown={swallow}
            onPointerMove={swallow}
            onPointerUp={swallow}
            style={{ touchAction: 'pan-x' }}
          />
          <div className="hu-picker-value">{h}°</div>
        </div>

        <div className="hu-picker-slider-row">
          <div className="hu-picker-slider-label">SAT</div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={s}
            className="hu-picker-slider"
            style={{
              background: `linear-gradient(90deg, ${hslToHex(h, 0, l)}, ${hslToHex(h, 100, l)})`,
              touchAction: 'pan-x'
            }}
            onChange={(e) => onChange(hslToHex(h, +e.target.value, l))}
            onPointerDown={swallow}
            onPointerMove={swallow}
            onPointerUp={swallow}
          />
          <div className="hu-picker-value">{s}%</div>
        </div>

        <div className="hu-picker-slider-row">
          <div className="hu-picker-slider-label">LIGHT</div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={l}
            className="hu-picker-slider"
            style={{
              background: `linear-gradient(90deg, #000, ${hslToHex(h, s, 50)}, #fff)`,
              touchAction: 'pan-x'
            }}
            onChange={(e) => onChange(hslToHex(h, s, +e.target.value))}
            onPointerDown={swallow}
            onPointerMove={swallow}
            onPointerUp={swallow}
          />
          <div className="hu-picker-value">{l}%</div>
        </div>

        <div className="hu-panel-label" style={{ marginTop: 8 }}>
          QUICK PICKS
        </div>
        <div className="hu-picker-quicks">
          {QUICK_SWATCHES.map((c) => (
            <button
              key={c}
              className="hu-picker-quick"
              style={{ background: c }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                onChange(c)
                onClose()
              }}
              aria-label={c}
            />
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <button className="hu-eq-action hu-eq-action-large hu-picker-done" onClick={onClose}>
          DONE
        </button>
      </div>
    </div>
  )
}

// ─── Visualizer ─────────────────────────────────────────────────────────────

function VizPage({
  us,
  vizActive
}: {
  us: ReturnType<typeof useUserSettings>
  vizActive: boolean
}) {
  const v = us.state.viz
  const set = (patch: Partial<VizConfig>) => us.setViz(patch)

  return (
    <div className="hu-settings-page">
      {/* Preview sticks to the top of the scroll area so tweaking sliders
       *  further down the page keeps the live bars visible.  Solid backdrop
       *  hides the sliders that scroll behind it. */}
      <div className="hu-viz-preview-sticky">
        <div className="hu-panel-label">LIVE PREVIEW</div>
        <VizPreview enabled={vizActive} />
      </div>

      <div className="hu-panel-label" style={{ marginTop: 24 }}>
        VISUALIZER
      </div>

      <Slider
        label="BARS"
        min={8}
        max={64}
        step={2}
        value={v.bars}
        format={(x) => String(x)}
        onChange={(x) => set({ bars: Math.round(x) })}
      />

      <Slider
        label="GAIN"
        min={0.5}
        max={5}
        step={0.05}
        value={v.gain}
        format={(x) => x.toFixed(2)}
        onChange={(x) => set({ gain: x })}
      />

      <Slider
        label="GAMMA"
        min={0.6}
        max={5}
        step={0.05}
        value={v.gamma}
        format={(x) => x.toFixed(2)}
        onChange={(x) => set({ gamma: x })}
      />

      <Slider
        label="ATTACK"
        min={0.1}
        max={1}
        step={0.01}
        value={v.attackSpeed}
        format={(x) => x.toFixed(2)}
        onChange={(x) => set({ attackSpeed: x })}
      />

      <Slider
        label="RELEASE"
        min={0.01}
        max={0.5}
        step={0.005}
        value={v.releaseSpeed}
        format={(x) => x.toFixed(3)}
        onChange={(x) => set({ releaseSpeed: x })}
      />

      <Slider
        label="BASS BOOST"
        min={0.8}
        max={2.5}
        step={0.05}
        value={v.bassBoost}
        format={(x) => x.toFixed(2)}
        onChange={(x) => set({ bassBoost: x })}
      />

      <Slider
        label="HIGH DAMP"
        min={0.4}
        max={1.2}
        step={0.05}
        value={v.highFrequencyDamping}
        format={(x) => x.toFixed(2)}
        onChange={(x) => set({ highFrequencyDamping: x })}
      />

      <Slider
        label="SMOOTHING"
        min={0}
        max={0.9}
        step={0.01}
        value={v.smoothing}
        format={(x) => x.toFixed(2)}
        onChange={(x) => set({ smoothing: x })}
      />

      <Slider
        label="SHADOW"
        min={0}
        max={1.5}
        step={0.05}
        value={v.glowStrength}
        format={(x) => x.toFixed(2)}
        onChange={(x) => set({ glowStrength: x })}
      />

      <Slider
        label="COLOR CURVE"
        min={0.6}
        max={3}
        step={0.05}
        value={v.colorCurve}
        format={(x) => x.toFixed(2)}
        onChange={(x) => set({ colorCurve: x })}
      />

      <Slider
        label="NOISE GATE"
        min={0}
        max={0.1}
        step={0.002}
        value={v.noiseGate}
        format={(x) => x.toFixed(3)}
        onChange={(x) => set({ noiseGate: x })}
      />

      <Slider
        label="PEAK HOLD ms"
        min={0}
        max={500}
        step={10}
        value={v.peakHoldTime}
        format={(x) => String(Math.round(x))}
        onChange={(x) => set({ peakHoldTime: x })}
      />

      <Slider
        label="PEAK FALL"
        min={0}
        max={0.02}
        step={0.00005}
        value={v.peakFallSpeed}
        format={(x) => x.toFixed(3)}
        onChange={(x) => set({ peakFallSpeed: x })}
      />

      <div className="hu-settings-row" style={{ marginTop: 16 }}>
        <button className="hu-eq-action" onClick={us.resetViz}>
          Reset to defaults
        </button>
        <div className="hu-settings-hint">
          Current: {Object.keys(DEFAULT_VIZ).length} parameters
        </div>
      </div>
    </div>
  )
}

function VizPreview({ enabled }: { enabled: boolean }) {
  const us = useUserSettings()
  const v = us.state.viz
  // Canvas-based renderer — see VizCanvas.tsx.  Passes all three
  // colour channels so the preview reacts live to primary/peak/glow
  // changes made in the color pickers directly above.
  return (
    <div className="hu-viz-preview">
      <VizCanvas
        cfg={v}
        themePrimary={us.state.theme.primary}
        peakColor={us.state.theme.peak}
        glowColor={us.state.theme.glow}
        shadowColor={us.state.theme.shadow}
        enabled={enabled}
        className="hu-viz-canvas"
        style={{ height: 260, width: '100%', display: 'block' }}
      />
    </div>
  )
}

// ─── CarPlay page ───────────────────────────────────────────────────────────
// Themed replacement for the legacy Rhys settings screen.  Same underlying
// config fields (ExtraConfig / DongleConfig) but in ICM2 style, and saving
// no longer relaunches the app — main-process saveSettings reloads only the
// renderer so BT / audio / EQ state stays intact.

function CarplayPage() {
  const settings = useCarplayStore((s) => s.settings)
  const saveSettings = useCarplayStore((s) => s.saveSettings)
  const [draft, setDraft] = useState<ExtraConfig | null>(settings)
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])

  // Keep the draft in sync when the store's settings change (e.g. on
  // startup or after a save round-trip).
  useEffect(() => {
    if (settings) setDraft(settings)
  }, [settings])

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    navigator.mediaDevices.enumerateDevices().then((devs) => {
      setCameras(devs.filter((d) => d.kind === 'videoinput'))
      setMics(devs.filter((d) => d.kind === 'audioinput'))
    })
  }, [])

  if (!draft) {
    return (
      <div className="hu-settings-page">
        <div className="hu-panel-label">CARPLAY</div>
        <div className="hu-settings-hint">Loading dongle settings…</div>
      </div>
    )
  }

  const patch = <K extends keyof ExtraConfig>(k: K, v: ExtraConfig[K]) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d))

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)

  return (
    <div className="hu-settings-page">
      <div className="hu-panel-label">CARPLAY</div>
      <div className="hu-settings-hint" style={{ margin: '12px 0 20px', maxWidth: 900 }}>
        Dongle-specific settings.  SAVE reloads the head unit UI only —
        the app itself, your Bluetooth pairing and equalizer state stay
        connected.
      </div>

      <div className="hu-settings-row">
        <NumberField label="WIDTH"  value={draft.width}  onChange={(v) => patch('width',  v)} />
        <NumberField label="HEIGHT" value={draft.height} onChange={(v) => patch('height', v)} />
        <NumberField label="FPS"    value={draft.fps}    onChange={(v) => patch('fps',    v)} />
      </div>
      <div className="hu-settings-row">
        <NumberField label="DPI"    value={draft.dpi}    onChange={(v) => patch('dpi',    v)} />
        <NumberField label="FORMAT" value={draft.format} onChange={(v) => patch('format', v)} />
        <NumberField label="IBOX"   value={draft.iBoxVersion} onChange={(v) => patch('iBoxVersion', v)} />
      </div>
      <div className="hu-settings-row">
        <NumberField label="MEDIA DELAY" value={draft.mediaDelay} onChange={(v) => patch('mediaDelay', v)} />
        <NumberField label="PHONE MODE"  value={draft.phoneWorkMode} onChange={(v) => patch('phoneWorkMode', v)} />
      </div>

      <div className="hu-panel-label" style={{ marginTop: 20 }}>MODE</div>
      <div className="hu-settings-row">
        <ToggleField label="KIOSK"      value={draft.kiosk}          onChange={(v) => patch('kiosk',  v)} />
        <ToggleField label="CAN BUS"    value={!!draft.canbus}       onChange={(v) => patch('canbus', v)} />
      </div>

      <div className="hu-panel-label" style={{ marginTop: 20 }}>RADIO</div>
      <div className="hu-settings-row">
        <ChoiceField
          label="WIFI"
          value={draft.wifiType}
          options={[{ value: '2.4ghz', label: '2.4 GHz' }, { value: '5ghz', label: '5 GHz' }]}
          onChange={(v) => patch('wifiType', v as any)}
        />
        <ChoiceField
          label="MIC"
          value={draft.micType}
          options={[{ value: 'os', label: 'OS' }, { value: 'box', label: 'BOX' }]}
          onChange={(v) => patch('micType', v as any)}
        />
      </div>

      {(cameras.length > 0 || mics.length > 0) && (
        <>
          <div className="hu-panel-label" style={{ marginTop: 20 }}>DEVICES</div>
          {cameras.length > 0 && (
            <ChoiceField
              label="CAMERA"
              value={draft.camera}
              options={[{ value: '', label: '(none)' }, ...cameras.map((c) => ({ value: c.deviceId, label: c.label || c.deviceId }))]}
              onChange={(v) => patch('camera', v)}
            />
          )}
          {mics.length > 0 && (
            <ChoiceField
              label="MICROPHONE"
              value={draft.microphone}
              options={[{ value: '', label: '(none)' }, ...mics.map((m) => ({ value: m.deviceId, label: m.label || m.deviceId }))]}
              onChange={(v) => patch('microphone', v)}
            />
          )}
        </>
      )}

      <div className="hu-settings-row" style={{ marginTop: 30 }}>
        <button
          className="hu-eq-action hu-eq-action-large"
          onClick={() => saveSettings(draft)}
          disabled={!dirty}
        >
          SAVE
        </button>
        <button
          className="hu-eq-action"
          onClick={() => setDraft(settings)}
          disabled={!dirty}
        >
          REVERT
        </button>
        {dirty && (
          <div className="hu-settings-hint" style={{ color: 'var(--hu-warn)' }}>
            Unsaved changes — SAVE reloads the head unit.
          </div>
        )}
      </div>
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div className="hu-settings-row-inline">
      <div className="hu-settings-row-label">{label}</div>
      <input
        className="hu-text-input hu-text-input-narrow"
        type="number"
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => {
          const n = Number(e.target.value)
          onChange(Number.isFinite(n) ? n : 0)
        }}
      />
    </div>
  )
}

function ToggleField({
  label,
  value,
  onChange
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      className={`hu-eq-action${value ? ' hu-eq-action-on' : ''}`}
      onClick={() => onChange(!value)}
    >
      {label}: {value ? 'ON' : 'OFF'}
    </button>
  )
}

function ChoiceField({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <div className="hu-settings-row-inline">
      <div className="hu-settings-row-label">{label}</div>
      <div className="hu-choice-row">
        {options.map((o) => (
          <button
            key={o.value}
            className={`hu-eq-action${value === o.value ? ' hu-eq-action-on' : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Gauges editor ──────────────────────────────────────────────────────────

function GaugesPage({ us }: { us: ReturnType<typeof useUserSettings> }) {
  const [editing, setEditing] = useState<GaugeDef | null>(null)

  const blank = (): GaugeDef => ({
    id: `g_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    label: '',
    min: 0,
    max: 100,
    unit: '',
    canKey: '',
    warnAbove: undefined
  })

  return (
    <div className="hu-settings-page">
      <div className="hu-panel-label">GAUGES</div>
      <div className="hu-settings-hint" style={{ margin: '12px 0 12px' }}>
        Define dash gauges now so they appear once the CAN-bus wiring is live. Values stay at 0
        until vehicleData arrives for the matching CAN key.
      </div>

      <div className="hu-gauge-list">
        {us.state.gauges.length === 0 && (
          <div className="hu-empty-state">
            <div className="hu-empty-title">NO GAUGES DEFINED</div>
            <div className="hu-empty-sub">
              The default OIL TEMP / SPEED / RPM gauges remain in use.
            </div>
          </div>
        )}
        {us.state.gauges.map((g) => (
          <div key={g.id} className="hu-gauge-list-row">
            <div className="hu-gauge-list-label">{g.label || '(unnamed)'}</div>
            <div className="hu-gauge-list-meta">
              {g.min}–{g.max}
              {g.unit ? ` ${g.unit}` : ''} · key: {g.canKey || '—'}
            </div>
            <button className="hu-eq-action" onClick={() => setEditing(g)}>
              Edit
            </button>
            <button
              className="hu-eq-action hu-device-action-forget"
              onClick={() => us.deleteGauge(g.id)}
            >
              Delete
            </button>
          </div>
        ))}
      </div>

      <div className="hu-settings-row" style={{ marginTop: 16 }}>
        <button className="hu-eq-action hu-eq-action-large" onClick={() => setEditing(blank())}>
          + Add gauge
        </button>
      </div>

      {editing && (
        <GaugeEditor
          gauge={editing}
          onCancel={() => setEditing(null)}
          onSave={(g) => {
            us.upsertGauge(g)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function GaugeEditor({
  gauge,
  onCancel,
  onSave
}: {
  gauge: GaugeDef
  onCancel: () => void
  onSave: (g: GaugeDef) => void
}) {
  const [g, setG] = useState<GaugeDef>(gauge)
  const update = (patch: Partial<GaugeDef>) => setG((p) => ({ ...p, ...patch }))
  const valid = g.label.trim().length > 0 && g.max > g.min

  return (
    <div className="hu-modal-overlay" onPointerDown={onCancel}>
      <div className="hu-modal-panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="hu-panel-label">GAUGE</div>

        <LabeledInput
          label="LABEL"
          value={g.label}
          onChange={(v) => update({ label: v })}
          placeholder="OIL TEMP"
        />
        <LabeledInput
          label="CAN KEY"
          value={g.canKey}
          onChange={(v) => update({ canKey: v })}
          placeholder="oilTempC"
          hint="The key your CAN bridge sends in vehicleData"
        />
        <LabeledInput
          label="UNIT"
          value={g.unit}
          onChange={(v) => update({ unit: v })}
          placeholder="°C / km/h / V"
        />
        <div className="hu-settings-row">
          <NumberInput label="MIN" value={g.min} onChange={(v) => update({ min: v })} />
          <NumberInput label="MAX" value={g.max} onChange={(v) => update({ max: v })} />
          <NumberInput
            label="WARN ABOVE"
            value={g.warnAbove ?? NaN}
            onChange={(v) => update({ warnAbove: Number.isFinite(v) ? v : undefined })}
            placeholder="(none)"
          />
        </div>

        <div className="hu-settings-row" style={{ marginTop: 16 }}>
          <button className="hu-eq-action" onClick={onCancel}>
            CANCEL
          </button>
          <button
            className="hu-eq-action hu-eq-action-large"
            disabled={!valid}
            onClick={() => onSave(g)}
          >
            SAVE
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Small input bits ───────────────────────────────────────────────────────

function Slider({
  label,
  min,
  max,
  step,
  value,
  format,
  onChange
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  format: (x: number) => string
  onChange: (x: number) => void
}) {
  // Stop pointerdown/move from bubbling so the parent page-scroll container
  // never starts its own tracking — without this, even a few px of vertical
  // jitter while dragging the thumb hands the gesture to the scroll
  // container and the slider stops responding.  Touch-action "pan-x" gives
  // the browser permission to handle horizontal pan on the thumb itself.
  const swallow = (e: React.PointerEvent) => e.stopPropagation()
  return (
    <div className="hu-slider-row">
      <div className="hu-slider-label">{label}</div>
      <input
        type="range"
        className="hu-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerDown={swallow}
        onPointerMove={swallow}
        onPointerUp={swallow}
        style={{ touchAction: 'pan-x' }}
      />
      <div className="hu-slider-value">{format(value)}</div>
    </div>
  )
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  hint
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: string
}) {
  return (
    <div className="hu-settings-row">
      <div className="hu-settings-row-label">{label}</div>
      <div className="hu-settings-row-body">
        <input
          className="hu-text-input"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        {hint && <div className="hu-settings-hint">{hint}</div>}
      </div>
    </div>
  )
}

function NumberInput({
  label,
  value,
  onChange,
  placeholder
}: {
  label: string
  value: number
  onChange: (v: number) => void
  placeholder?: string
}) {
  const display = Number.isFinite(value) ? String(value) : ''
  return (
    <div className="hu-settings-row" style={{ width: 'auto', flex: '0 0 auto' }}>
      <div className="hu-settings-row-label">{label}</div>
      <input
        className="hu-text-input hu-text-input-narrow"
        type="number"
        value={display}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.target.value
          onChange(v === '' ? NaN : Number(v))
        }}
      />
    </div>
  )
}

// Keep applyTheme reachable so callers can preview a hex without committing.
export { applyTheme, BUILTIN_THEMES }
