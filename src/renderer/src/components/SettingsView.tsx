// Full settings panel.  Lives as an overlay over the music carousel; the
// HeadUnit header + nav-bar stay visible above/below.  Five sub-pages live
// inside a sidebar (same pattern as PhoneView):
//   • General   — theme colours, swatches, picker, presets
//   • Visualizer — viz config sliders with a live preview
//   • Equalizer — shortcut into the existing EQ overlay
//   • CarPlay   — launches Rhys' original /settings route
//   • Gauges    — define gauges for the dash (CAN-key, min, max, label)

import { useState } from 'react'
import {
  useUserSettings,
  applyTheme,
  allThemes,
  BUILTIN_THEMES,
  DEFAULT_VIZ,
  type GaugeDef,
  type VizConfig,
} from './userSettings'
import { useAudioVisualizer, barColor } from './audioVisualizer'
import { useScrollContainer } from './HeadUnit'

type SubPage = 'general' | 'viz' | 'eq' | 'carplay' | 'gauges'

const PAGES: { id: SubPage; label: string }[] = [
  { id: 'general',  label: 'GENERAL'    },
  { id: 'viz',      label: 'VISUALIZER' },
  { id: 'eq',       label: 'EQUALIZER'  },
  { id: 'carplay',  label: 'CARPLAY'    },
  { id: 'gauges',   label: 'GAUGES'     },
]

interface SettingsViewProps {
  isActive: boolean
  onOpenEqualizer: () => void
  onOpenCarplaySettings: () => void
}

export default function SettingsView({ isActive, onOpenEqualizer, onOpenCarplaySettings }: SettingsViewProps) {
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
        {PAGES.map(p => (
          <button
            key={p.id}
            className={`hu-list-btn${page === p.id ? ' hu-list-btn-active' : ''}`}
            onClick={() => { setPage(p.id); if (scroll.ref.current) scroll.ref.current.scrollTop = 0 }}
          >
            <span>{p.label}</span>
          </button>
        ))}
      </div>

      <div
        className="hu-main-area hu-settings-scroll"
        ref={scroll.ref}
        {...scroll.handlers}
      >
        {page === 'general' && <GeneralPage us={us} />}
        {page === 'viz'     && <VizPage us={us} vizActive={isActive} />}
        {page === 'eq'      && <EqualizerPage onOpenEqualizer={onOpenEqualizer} />}
        {page === 'carplay' && <CarplayPage onOpen={onOpenCarplaySettings} />}
        {page === 'gauges'  && <GaugesPage us={us} />}
      </div>
    </div>
  )
}

// ─── General (colors) ───────────────────────────────────────────────────────

function GeneralPage({ us }: { us: ReturnType<typeof useUserSettings> }) {
  const presets = allThemes(us.state)
  const [renaming, setRenaming] = useState(false)
  const [presetName, setPresetName] = useState('')

  const pickPreset = (name: string) => {
    const p = presets.find(x => x.name === name)
    if (!p) return
    us.setTheme({
      primary: p.primary, peak: p.peak,
      background: p.background, warn: p.warn, miss: p.miss,
      activePreset: name,
    })
  }

  const onSavePreset = () => {
    const clean = presetName.trim()
    if (!clean) return
    us.saveThemePreset(clean)
    setRenaming(false)
    setPresetName('')
  }

  const COLORS: { key: 'primary' | 'peak' | 'background' | 'warn' | 'miss'; label: string; hint: string }[] = [
    { key: 'primary',    label: 'PRIMARY',    hint: 'Text, borders, icons' },
    { key: 'peak',       label: 'PEAK',       hint: 'Visualizer peaks & gauge needles' },
    { key: 'background', label: 'BACKGROUND', hint: 'Screen base color' },
    { key: 'warn',       label: 'WARN',       hint: 'Over-redline / temp warnings' },
    { key: 'miss',       label: 'MISS',       hint: 'Missed call indicator' },
  ]

  return (
    <div className="hu-settings-page">
      <div className="hu-panel-label">COLORS</div>

      {COLORS.map(c => (
        <div key={c.key} className="hu-settings-row">
          <div className="hu-settings-row-label">{c.label}</div>
          <div className="hu-settings-row-body">
            <input
              type="color"
              className="hu-color-picker"
              value={us.state.theme[c.key]}
              onChange={(e) => us.setTheme({ [c.key]: e.target.value } as any)}
              /* Eat pointerdown so finger-jitter doesn't hand the gesture
               * to the page scroll container while opening the picker. */
              onPointerDown={(e) => e.stopPropagation()}
            />
            <div className="hu-hex-label">{us.state.theme[c.key].toUpperCase()}</div>
            <div className="hu-settings-hint">{c.hint}</div>
          </div>
        </div>
      ))}

      <div className="hu-panel-label" style={{ marginTop: 24 }}>PRESETS</div>
      <div className="hu-theme-swatches">
        {presets.map(p => {
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
              {/* Three-band preview: background top, primary middle, peak bottom */}
              <div className="hu-theme-swatch-preview">
                <div className="hu-theme-swatch-band" style={{ background: p.background }} />
                <div className="hu-theme-swatch-band" style={{ background: p.primary }} />
                <div className="hu-theme-swatch-band" style={{ background: p.peak }} />
              </div>
              <div className="hu-theme-swatch-name">{p.name.toUpperCase()}</div>
              {!p.builtin && (
                <button
                  className="hu-theme-swatch-delete"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); us.deleteThemePreset(p.name) }}
                  aria-label="Delete preset"
                >✕</button>
              )}
            </button>
          )
        })}
      </div>

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
            <button className="hu-eq-action" onClick={onSavePreset} disabled={!presetName.trim()}>SAVE</button>
            <button className="hu-eq-action" onClick={() => { setRenaming(false); setPresetName('') }}>CANCEL</button>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Visualizer ─────────────────────────────────────────────────────────────

function VizPage({ us, vizActive }: { us: ReturnType<typeof useUserSettings>; vizActive: boolean }) {
  const v = us.state.viz
  const set = (patch: Partial<VizConfig>) => us.setViz(patch)

  return (
    <div className="hu-settings-page">
      <div className="hu-panel-label">LIVE PREVIEW</div>
      <VizPreview enabled={vizActive} />

      <div className="hu-panel-label" style={{ marginTop: 24 }}>VISUALIZER</div>

      <Slider label="BARS" min={8} max={64} step={2} value={v.bars}
        format={(x) => String(x)} onChange={(x) => set({ bars: Math.round(x) })} />

      <Slider label="GAIN" min={0.5} max={3} step={0.05} value={v.gain}
        format={(x) => x.toFixed(2)} onChange={(x) => set({ gain: x })} />

      <Slider label="GAMMA" min={0.6} max={2.5} step={0.05} value={v.gamma}
        format={(x) => x.toFixed(2)} onChange={(x) => set({ gamma: x })} />

      <Slider label="ATTACK" min={0.1} max={1} step={0.01} value={v.attackSpeed}
        format={(x) => x.toFixed(2)} onChange={(x) => set({ attackSpeed: x })} />

      <Slider label="RELEASE" min={0.01} max={0.5} step={0.005} value={v.releaseSpeed}
        format={(x) => x.toFixed(3)} onChange={(x) => set({ releaseSpeed: x })} />

      <Slider label="BASS BOOST" min={0.8} max={2.5} step={0.05} value={v.bassBoost}
        format={(x) => x.toFixed(2)} onChange={(x) => set({ bassBoost: x })} />

      <Slider label="HIGH DAMP" min={0.4} max={1.2} step={0.05} value={v.highFrequencyDamping}
        format={(x) => x.toFixed(2)} onChange={(x) => set({ highFrequencyDamping: x })} />

      <Slider label="SMOOTHING" min={0} max={0.9} step={0.01} value={v.smoothing}
        format={(x) => x.toFixed(2)} onChange={(x) => set({ smoothing: x })} />

      <Slider label="GLOW" min={0} max={1.5} step={0.05} value={v.glowStrength}
        format={(x) => x.toFixed(2)} onChange={(x) => set({ glowStrength: x })} />

      <Slider label="COLOR CURVE" min={0.6} max={3} step={0.05} value={v.colorCurve}
        format={(x) => x.toFixed(2)} onChange={(x) => set({ colorCurve: x })} />

      <Slider label="NOISE GATE" min={0} max={0.1} step={0.002} value={v.noiseGate}
        format={(x) => x.toFixed(3)} onChange={(x) => set({ noiseGate: x })} />

      <Slider label="PEAK HOLD ms" min={0} max={500} step={10} value={v.peakHoldTime}
        format={(x) => String(Math.round(x))} onChange={(x) => set({ peakHoldTime: x })} />

      <Slider label="PEAK FALL" min={0} max={0.3} step={0.005} value={v.peakFallSpeed}
        format={(x) => x.toFixed(3)} onChange={(x) => set({ peakFallSpeed: x })} />

      <div className="hu-settings-row" style={{ marginTop: 16 }}>
        <button className="hu-eq-action" onClick={us.resetViz}>Reset to defaults</button>
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
  const themePrimary = us.state.theme.primary
  // Subscribe to the visualiser only while the Visualizer settings page is
  // actually on screen — otherwise the FFT loop idles and the rest of the
  // head unit keeps its frame budget.
  const { bars, peaks } = useAudioVisualizer(v, enabled)
  return (
    <div className="hu-viz-preview">
      <div className="hu-eq-bars" style={{ height: 260 }}>
        {Array.from({ length: v.bars }, (_, i) => {
          const h = bars[i] || 0
          const p = peaks[i] || 0
          const bg = barColor(h, v.colorCurve, themePrimary)
          const glowPx    = (4 + 14 * h) * v.glowStrength
          const glowAlpha = (0.18 + 0.5 * h) * v.glowStrength
          return (
            <div key={i} className="hu-eq-bar-wrap">
              <div
                className="hu-eq-bar"
                style={{
                  height: `${Math.max(2, h * 100)}%`,
                  background: bg,
                  boxShadow: glowPx > 0.1
                    ? `0 0 ${glowPx.toFixed(1)}px rgba(0, 255, 10, ${glowAlpha.toFixed(2)})`
                    : 'none',
                }}
              />
              {p > 0.02 && (
                <div className="hu-eq-peak" style={{ bottom: `${(p * 100).toFixed(2)}%` }} />
              )}
            </div>
          )
        })}
      </div>
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
        Dongle-specific settings (resolution, FPS, key bindings, CAN-bus,
        cameras, microphone) live in Rhys' original settings panel.  Tap below
        to open it.
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
    warnAbove: undefined,
  })

  return (
    <div className="hu-settings-page">
      <div className="hu-panel-label">GAUGES</div>
      <div className="hu-settings-hint" style={{ margin: '12px 0 12px' }}>
        Define dash gauges now so they appear once the CAN-bus wiring is live.
        Values stay at 0 until vehicleData arrives for the matching CAN key.
      </div>

      <div className="hu-gauge-list">
        {us.state.gauges.length === 0 && (
          <div className="hu-empty-state">
            <div className="hu-empty-title">NO GAUGES DEFINED</div>
            <div className="hu-empty-sub">The default OIL TEMP / SPEED / RPM gauges remain in use.</div>
          </div>
        )}
        {us.state.gauges.map(g => (
          <div key={g.id} className="hu-gauge-list-row">
            <div className="hu-gauge-list-label">{g.label || '(unnamed)'}</div>
            <div className="hu-gauge-list-meta">
              {g.min}–{g.max}{g.unit ? ` ${g.unit}` : ''} · key: {g.canKey || '—'}
            </div>
            <button className="hu-eq-action" onClick={() => setEditing(g)}>Edit</button>
            <button className="hu-eq-action hu-device-action-forget" onClick={() => us.deleteGauge(g.id)}>Delete</button>
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
          onSave={(g) => { us.upsertGauge(g); setEditing(null) }}
        />
      )}
    </div>
  )
}

function GaugeEditor({
  gauge, onCancel, onSave,
}: { gauge: GaugeDef; onCancel: () => void; onSave: (g: GaugeDef) => void }) {
  const [g, setG] = useState<GaugeDef>(gauge)
  const update = (patch: Partial<GaugeDef>) => setG(p => ({ ...p, ...patch }))
  const valid = g.label.trim().length > 0 && g.max > g.min

  return (
    <div className="hu-modal-overlay" onPointerDown={onCancel}>
      <div className="hu-modal-panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="hu-panel-label">GAUGE</div>

        <LabeledInput label="LABEL" value={g.label} onChange={(v) => update({ label: v })} placeholder="OIL TEMP" />
        <LabeledInput label="CAN KEY" value={g.canKey} onChange={(v) => update({ canKey: v })} placeholder="oilTempC" hint="The key your CAN bridge sends in vehicleData" />
        <LabeledInput label="UNIT" value={g.unit} onChange={(v) => update({ unit: v })} placeholder="°C / km/h / V" />
        <div className="hu-settings-row">
          <NumberInput label="MIN" value={g.min} onChange={(v) => update({ min: v })} />
          <NumberInput label="MAX" value={g.max} onChange={(v) => update({ max: v })} />
          <NumberInput label="WARN ABOVE" value={g.warnAbove ?? NaN}
            onChange={(v) => update({ warnAbove: Number.isFinite(v) ? v : undefined })}
            placeholder="(none)"
          />
        </div>

        <div className="hu-settings-row" style={{ marginTop: 16 }}>
          <button className="hu-eq-action" onClick={onCancel}>CANCEL</button>
          <button
            className="hu-eq-action hu-eq-action-large"
            disabled={!valid}
            onClick={() => onSave(g)}
          >SAVE</button>
        </div>
      </div>
    </div>
  )
}

// ─── Small input bits ───────────────────────────────────────────────────────

function Slider({ label, min, max, step, value, format, onChange }: {
  label: string; min: number; max: number; step: number;
  value: number; format: (x: number) => string; onChange: (x: number) => void
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
        min={min} max={max} step={step} value={value}
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

function LabeledInput({ label, value, onChange, placeholder, hint }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: string
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

function NumberInput({ label, value, onChange, placeholder }: {
  label: string; value: number; onChange: (v: number) => void; placeholder?: string
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
