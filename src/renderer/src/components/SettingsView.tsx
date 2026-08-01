// Full settings panel.  Lives as an overlay over the music carousel; the
// HeadUnit header + nav-bar stay visible above/below.  Five sub-pages live
// inside a sidebar (same pattern as PhoneView):
//   • General   — theme colours, swatches, picker, presets
//   • Visualizer — viz config sliders with a live preview
//   • Equalizer — shortcut into the existing EQ overlay
//   • CarPlay   — launches Rhys' original /settings route
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

type SubPage = 'general' | 'viz' | 'eq' | 'carplay' | 'gauges'

const PAGES: { id: SubPage; label: string }[] = [
  { id: 'general', label: 'GENERAL' },
  { id: 'viz', label: 'VISUALIZER' },
  { id: 'eq', label: 'EQUALIZER' },
  { id: 'carplay', label: 'CARPLAY' },
  { id: 'gauges', label: 'GAUGES' }
]

interface SettingsViewProps {
  isActive: boolean
  onOpenEqualizer: () => void
  onOpenCarplaySettings: () => void
}

export default function SettingsView({
  isActive,
  onOpenEqualizer,
  onOpenCarplaySettings
}: SettingsViewProps) {
  const us = useUserSettings()
  const [page, setPage] = useState<SubPage>('general')
  // Same touch-scroll pattern as the contacts list — no native scrollbar,
  // just a finger-drag with momentum that doesn't fight the global
  // `touch-action: none` on the App root.
  const scroll = useScrollContainer<HTMLDivElement>()

  return (
    <div className="hu-screen">
      <div className="hu-sidebar">
        <div className="hu-panel-label">SETTINGS</div>
        {PAGES.map((p) => (
          <button
            key={p.id}
            className={`hu-list-btn${page === p.id ? ' hu-list-btn-active' : ''}`}
            onClick={() => {
              setPage(p.id)
              if (scroll.ref.current) scroll.ref.current.scrollTop = 0
            }}
          >
            <span>{p.label}</span>
          </button>
        ))}
      </div>

      <div className="hu-main-area hu-settings-scroll" ref={scroll.ref} {...scroll.handlers}>
        {page === 'general' && <GeneralPage us={us} />}
        {page === 'viz' && <VizPage us={us} vizActive={isActive} />}
        {page === 'eq' && <EqualizerPage onOpenEqualizer={onOpenEqualizer} />}
        {page === 'carplay' && <CarplayPage onOpen={onOpenCarplaySettings} />}
        {page === 'gauges' && <GaugesPage us={us} />}
      </div>
    </div>
  )
}

// ─── General (colors) ───────────────────────────────────────────────────────

type ColorKey = 'primary' | 'peak' | 'background' | 'warn' | 'miss' | 'glow'

function GeneralPage({ us }: { us: ReturnType<typeof useUserSettings> }) {
  const presets = allThemes(us.state)
  const [renaming, setRenaming] = useState(false)
  const [presetName, setPresetName] = useState('')
  // Which colour row's picker is currently open (null = none).  Starts
  // closed on every mount of the Settings screen so it "hides for next
  // time" automatically.
  const [picker, setPicker] = useState<{ key: ColorKey; label: string } | null>(null)

  const pickPreset = (name: string) => {
    const p = presets.find((x) => x.name === name)
    if (!p) return
    us.setTheme({
      primary: p.primary,
      peak: p.peak,
      background: p.background,
      warn: p.warn,
      miss: p.miss,
      glow: p.glow,
      activePreset: name
    })
  }

  const onSavePreset = () => {
    const clean = presetName.trim()
    if (!clean) return
    us.saveThemePreset(clean)
    setRenaming(false)
    setPresetName('')
  }

  const COLORS: { key: ColorKey; label: string; hint: string }[] = [
    { key: 'primary',    label: 'PRIMARY',    hint: 'Text, borders, icons' },
    { key: 'peak',       label: 'PEAK',       hint: 'Visualizer peaks & gauge needles' },
    { key: 'glow',       label: 'GLOW',       hint: 'Bar/peak shadow + call-popup pulse' },
    { key: 'background', label: 'BACKGROUND', hint: 'Screen base color' },
    { key: 'warn',       label: 'WARN',       hint: 'Over-redline / temp warnings' },
    { key: 'miss',       label: 'MISS',       hint: 'Missed call indicator' },
  ]

  return (
    <div className="hu-settings-page">
      <div className="hu-panel-label">COLORS</div>

      {COLORS.map((c) => (
        <div key={c.key} className="hu-settings-row">
          <div className="hu-settings-row-label">{c.label}</div>
          <div className="hu-settings-row-body">
            {/* Head-unit-styled swatch — tap to open the slide-in picker
             *  on the right side of the screen.  Replaces the browser's
             *  native color input, which looked out of place. */}
            <button
              className="hu-color-swatch"
              style={{ background: us.state.theme[c.key] }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setPicker({ key: c.key, label: c.label })}
              aria-label={`Pick ${c.label}`}
            />
            <div className="hu-hex-label">{us.state.theme[c.key].toUpperCase()}</div>
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
              {/* Four-band preview: background, primary, peak, glow */}
              <div className="hu-theme-swatch-preview">
                <div className="hu-theme-swatch-band" style={{ background: p.background }} />
                <div className="hu-theme-swatch-band" style={{ background: p.primary }} />
                <div className="hu-theme-swatch-band" style={{ background: p.peak }} />
                <div className="hu-theme-swatch-band" style={{ background: p.glow ?? p.primary }} />
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

      {picker && (
        <ColorPickerPanel
          label={picker.label}
          value={us.state.theme[picker.key]}
          onChange={(hex) => us.setTheme({ [picker.key]: hex } as any)}
          onClose={() => setPicker(null)}
        />
      )}

      <div className="hu-settings-row" style={{ marginTop: 24 }}>
        {!renaming ? (
          <button className="hu-eq-action" onClick={() => setRenaming(true)}>
            Save current as preset
          </button>
        ) : (
          <>
            <input
              className="hu-text-input"
              autoFocus
              placeholder="Preset name"
              value={presetName}
              maxLength={24}
              onChange={(e) => setPresetName(e.target.value)}
            />
            <button className="hu-eq-action" onClick={onSavePreset} disabled={!presetName.trim()}>
              SAVE
            </button>
            <button
              className="hu-eq-action"
              onClick={() => {
                setRenaming(false)
                setPresetName('')
              }}
            >
              CANCEL
            </button>
          </>
        )}
      </div>
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
  const g = ((n >> 8)  & 0xff) / 255
  const b = ( n        & 0xff) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  const l = (max + min) / 2
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  if (d !== 0) {
    if      (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else                h = (r - g) / d + 4
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
  let r = 0, g = 0, b = 0
  if      (h < 60)  { r = c; g = x }
  else if (h < 120) { r = x; g = c }
  else if (h < 180) { g = c; b = x }
  else if (h < 240) { g = x; b = c }
  else if (h < 300) { r = x; b = c }
  else              { r = c; b = x }
  const to255 = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return `#${to255(r)}${to255(g)}${to255(b)}`
}

// A small strip of built-in-theme colours the user can tap for a one-shot
// pick.  Rendered inside the picker panel below the sliders.
const QUICK_SWATCHES = [
  '#00ff0a', '#00e8d0', '#00b3ff', '#7ad8ff', '#dfe7f0', '#ffffff',
  '#ffb000', '#ffd900', '#ff6b1a', '#ff4400', '#ff2244', '#ff3aa0',
  '#ff9ce0', '#ffaa33', '#005c04', '#001500', '#0a0e14', '#1a0f00',
]

function ColorPickerPanel({
  label,
  value,
  onChange,
  onClose,
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
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const swallow = (e: React.PointerEvent) => e.stopPropagation()

  return (
    <div className="hu-picker-overlay" onPointerDown={onClose}>
      <div
        className="hu-picker-panel"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="hu-picker-header">
          <div className="hu-panel-label" style={{ marginBottom: 0, borderBottom: 'none' }}>
            {label}
          </div>
          <button className="hu-picker-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="hu-picker-preview" style={{ background: value }} />
        <div className="hu-picker-hex">{value.toUpperCase()}</div>

        <div className="hu-picker-slider-row">
          <div className="hu-picker-slider-label">HUE</div>
          <input
            type="range" min={0} max={359} step={1} value={h}
            className="hu-picker-slider hu-picker-slider-hue"
            onChange={(e) => onChange(hslToHex(+e.target.value, s, l))}
            onPointerDown={swallow} onPointerMove={swallow} onPointerUp={swallow}
            style={{ touchAction: 'pan-x' }}
          />
          <div className="hu-picker-value">{h}°</div>
        </div>

        <div className="hu-picker-slider-row">
          <div className="hu-picker-slider-label">SAT</div>
          <input
            type="range" min={0} max={100} step={1} value={s}
            className="hu-picker-slider"
            style={{
              background: `linear-gradient(90deg, ${hslToHex(h, 0, l)}, ${hslToHex(h, 100, l)})`,
              touchAction: 'pan-x',
            }}
            onChange={(e) => onChange(hslToHex(h, +e.target.value, l))}
            onPointerDown={swallow} onPointerMove={swallow} onPointerUp={swallow}
          />
          <div className="hu-picker-value">{s}%</div>
        </div>

        <div className="hu-picker-slider-row">
          <div className="hu-picker-slider-label">LIGHT</div>
          <input
            type="range" min={0} max={100} step={1} value={l}
            className="hu-picker-slider"
            style={{
              background: `linear-gradient(90deg, #000, ${hslToHex(h, s, 50)}, #fff)`,
              touchAction: 'pan-x',
            }}
            onChange={(e) => onChange(hslToHex(h, s, +e.target.value))}
            onPointerDown={swallow} onPointerMove={swallow} onPointerUp={swallow}
          />
          <div className="hu-picker-value">{l}%</div>
        </div>

        <div className="hu-panel-label" style={{ marginTop: 8 }}>QUICK PICKS</div>
        <div className="hu-picker-quicks">
          {QUICK_SWATCHES.map((c) => (
            <button
              key={c}
              className="hu-picker-quick"
              style={{ background: c }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => { onChange(c); onClose() }}
              aria-label={c}
            />
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <button
          className="hu-eq-action hu-eq-action-large hu-picker-done"
          onClick={onClose}
        >
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
        max={3}
        step={0.05}
        value={v.gain}
        format={(x) => x.toFixed(2)}
        onChange={(x) => set({ gain: x })}
      />

      <Slider
        label="GAMMA"
        min={0.6}
        max={2.5}
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
        label="GLOW"
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
        enabled={enabled}
        className="hu-viz-canvas"
        style={{ height: 260, width: '100%', display: 'block' }}
      />
    </div>
  )
}

// ─── Equalizer page ─────────────────────────────────────────────────────────

function EqualizerPage({ onOpenEqualizer }: { onOpenEqualizer: () => void }) {
  return (
    <div className="hu-settings-page">
      <div className="hu-panel-label">EQUALIZER</div>
      <div className="hu-settings-hint" style={{ margin: '12px 0 24px' }}>
        Same screen as the gear shortcut on the music view.
      </div>
      <button className="hu-eq-action hu-eq-action-large" onClick={onOpenEqualizer}>
        Open Equalizer
      </button>
    </div>
  )
}

// ─── CarPlay page ───────────────────────────────────────────────────────────

function CarplayPage({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="hu-settings-page">
      <div className="hu-panel-label">CARPLAY</div>
      <div className="hu-settings-hint" style={{ margin: '12px 0 24px', maxWidth: 720 }}>
        Dongle-specific settings (resolution, FPS, key bindings, CAN-bus, cameras, microphone) live
        in Rhys' original settings panel. Tap below to open it.
      </div>
      <button className="hu-eq-action hu-eq-action-large" onClick={onOpen}>
        Open CarPlay Settings
      </button>
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
