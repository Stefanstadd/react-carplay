// Full-screen equalizer overlay.  Style is locked to the headunit pixel/CRT
// aesthetic: black background, bright #00ff00 on dark green, VT323 monospace,
// no rounded corners / gradients / shadows.
//
// Performance notes (it's running on a Pi):
//   • Bars render in a single <canvas>, redrawn only when band values change
//     — no rAF loop, no continuous redraw.
//   • Press-and-hold acceleration uses one setTimeout per button.
//   • Keyboard for naming presets is only mounted while open.

import React, { useEffect, useRef, useState, useCallback } from 'react'
import {
  EQ_BANDS,
  BAND_COUNT,
  GAIN_MIN,
  GAIN_MAX,
  GAIN_STEP,
  allPresets,
  useEqualizer,
  type EQPreset,
} from './equalizer'

// ─── Canvas bar graph ────────────────────────────────────────────────────────

const Y_TICKS = [-12, -8, -4, 0, 4, 8, 12]
const BAR_COLOR        = '#00ff00'
const GRID_COLOR       = '#004400'
const GRID_LABEL_COLOR = '#00ff0a'   // bright green — matches body text

// Canvas plot padding constants used by both the draw() function and the
// drag handler so they stay in sync.
const PAD_L = 70, PAD_R = 24, PAD_T = 24, PAD_B = 36

function EQCanvas({ bands }: { bands: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cvs = ref.current
    if (!cvs) return
    const rect = cvs.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      cvs.width  = Math.floor(rect.width)
      cvs.height = Math.floor(rect.height)
    }
    draw(cvs, bands)
  }, [bands])

  return <canvas ref={ref} className="hu-eq-canvas" />
}

function draw(cvs: HTMLCanvasElement, bands: number[]) {
  const ctx = cvs.getContext('2d')
  if (!ctx) return
  const W = cvs.width, H = cvs.height
  ctx.clearRect(0, 0, W, H)

  // ── Plot area
  const plotW = W - PAD_L - PAD_R
  const plotH = H - PAD_T - PAD_B
  const yFor = (db: number) => PAD_T + plotH * (1 - (db - GAIN_MIN) / (GAIN_MAX - GAIN_MIN))

  // ── Grid lines + dB labels
  ctx.lineWidth = 1
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (const db of Y_TICKS) {
    const y = Math.round(yFor(db)) + 0.5
    ctx.strokeStyle = GRID_COLOR
    ctx.beginPath()
    ctx.moveTo(PAD_L, y)
    ctx.lineTo(W - PAD_R, y)
    ctx.stroke()
    ctx.fillStyle = GRID_LABEL_COLOR
    ctx.font = '24px "VT323", monospace'
    ctx.fillText(`${db > 0 ? '+' : ''}${db}`, PAD_L - 12, y)
  }

  // ── Bars (centered around the 0 dB baseline that yFor() computes per call)
  const slot = plotW / BAND_COUNT
  const barW = Math.max(8, Math.floor(slot * 0.55))
  ctx.fillStyle = BAR_COLOR
  for (let i = 0; i < BAND_COUNT; i++) {
    const g = bands[i] ?? 0
    const x = Math.round(PAD_L + slot * i + (slot - barW) / 2)
    const topY = yFor(Math.max(0, g))
    const botY = yFor(Math.min(0, g))
    const h = Math.max(2, botY - topY)
    ctx.fillRect(x, topY, barW, h)
  }

  // ── Frequency labels under each bar
  ctx.fillStyle = BAR_COLOR
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.font = '22px "VT323", monospace'
  for (let i = 0; i < BAND_COUNT; i++) {
    const x = Math.round(PAD_L + slot * i + slot / 2)
    ctx.fillText(EQ_BANDS[i].label, x, H - PAD_B + 6)
  }
}

// ─── Press-and-hold button (used for ▲ / ▼) ─────────────────────────────────
// First step fires immediately; then 350 ms delay, then repeats every 90 ms.

function HoldButton({
  onStep,
  className = '',
  children,
  ariaLabel,
}: {
  onStep: () => void
  className?: string
  children: React.ReactNode
  ariaLabel?: string
}) {
  const timer = useRef<NodeJS.Timeout | null>(null)
  const interval = useRef<NodeJS.Timeout | null>(null)

  const stop = useCallback(() => {
    if (timer.current)    { clearTimeout(timer.current);    timer.current = null }
    if (interval.current) { clearInterval(interval.current); interval.current = null }
  }, [])

  const begin = useCallback(() => {
    stop()
    onStep()
    timer.current = setTimeout(() => {
      interval.current = setInterval(onStep, 90)
    }, 350)
  }, [onStep, stop])

  useEffect(() => stop, [stop])

  return (
    <button
      className={`hu-eq-step-btn ${className}`}
      onPointerDown={(e) => { e.preventDefault(); begin() }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  )
}

// ─── On-screen QWERTY keyboard (for naming custom presets) ──────────────────

const KB_ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM']

function NameKeyboard({
  initial,
  onCancel,
  onAccept,
}: {
  initial: string
  onCancel: () => void
  onAccept: (name: string) => void
}) {
  const [value, setValue] = useState(initial)
  const append = (ch: string) => setValue(v => (v + ch).slice(0, 16))
  const back   = () => setValue(v => v.slice(0, -1))

  return (
    <div className="hu-eq-kb-overlay" onPointerDown={onCancel}>
      <div className="hu-eq-kb-panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="hu-eq-kb-prompt">PRESET NAME</div>
        <div className="hu-eq-kb-display">{value || <span className="hu-eq-kb-placeholder">—</span>}</div>

        {KB_ROWS.map((row, ri) => (
          <div key={ri} className="hu-eq-kb-row" style={{ paddingLeft: ri * 26 }}>
            {row.split('').map(k => (
              <button key={k} className="hu-eq-kb-key" onClick={() => append(k)}>{k}</button>
            ))}
          </div>
        ))}
        <div className="hu-eq-kb-row">
          <button className="hu-eq-kb-key hu-eq-kb-key-wide" onClick={() => append(' ')}>SPACE</button>
          <button className="hu-eq-kb-key" onClick={back}>⌫</button>
          <button className="hu-eq-kb-key hu-eq-kb-key-wide" onClick={onCancel}>CANCEL</button>
          <button
            className="hu-eq-kb-key hu-eq-kb-key-wide hu-eq-kb-key-accept"
            onClick={() => value.trim() && onAccept(value.trim())}
            disabled={!value.trim()}
          >
            SAVE
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main EQ overlay ────────────────────────────────────────────────────────

interface EQViewProps {
  onClose: () => void
}

export default function EQView({ onClose }: EQViewProps) {
  const { state, bumpBand, setBand, setActivePreset, savePreset } = useEqualizer()
  const [kbOpen, setKbOpen] = useState(false)

  // ── Drag handling ──
  // Touch any band and slide up/down — the bar follows the finger.  Pointer
  // capture keeps the gesture tracked even if the finger leaves the band's
  // original column.
  const plotRef = useRef<HTMLDivElement>(null)
  const dragState = useRef<{
    bandIdx: number
    plotTop: number
    plotH: number
  } | null>(null)

  const gainFromY = (clientY: number): number => {
    const ds = dragState.current
    if (!ds) return 0
    const norm = (clientY - ds.plotTop) / ds.plotH
    const clamped = Math.max(0, Math.min(1, norm))
    // Top of the plot is +max, bottom is -max.
    return GAIN_MAX - clamped * (GAIN_MAX - GAIN_MIN)
  }

  const onPlotPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const wrap = plotRef.current
    if (!wrap) return
    const rect = wrap.getBoundingClientRect()
    const plotLeft   = rect.left + PAD_L
    const plotRight  = rect.right - PAD_R
    const plotTop    = rect.top + PAD_T
    const plotH      = rect.height - PAD_T - PAD_B
    const plotW      = plotRight - plotLeft
    const x = e.clientX - plotLeft
    if (x < 0 || x > plotW || plotH <= 0) return
    const slot = plotW / BAND_COUNT
    const bandIdx = Math.min(BAND_COUNT - 1, Math.max(0, Math.floor(x / slot)))
    dragState.current = { bandIdx, plotTop, plotH }
    wrap.setPointerCapture(e.pointerId)
    setBand(bandIdx, gainFromY(e.clientY))
    e.preventDefault()
  }

  const onPlotPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return
    setBand(dragState.current.bandIdx, gainFromY(e.clientY))
  }

  const onPlotPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return
    plotRef.current?.releasePointerCapture(e.pointerId)
    dragState.current = null
  }

  const presets = allPresets(state)
  const activeIdx = Math.max(0, presets.findIndex(p => p.name === state.activePreset))

  const cyclePreset = (dir: -1 | 1) => {
    if (presets.length === 0) return
    const next = (activeIdx + dir + presets.length) % presets.length
    setActivePreset(presets[next].name)
  }

  // "Reset" restores the currently-active preset's band values (not flat).
  const resetToPreset = () => {
    const p = presets.find(x => x.name === state.activePreset)
    if (p) setActivePreset(p.name)
  }

  // Suggest a custom-preset name that doesn't collide with existing ones.
  const defaultName = () => {
    let i = 1
    const taken = new Set(state.customPresets.map(p => p.name.toLowerCase()))
    while (taken.has(`custom ${i}`)) i++
    return `Custom ${i}`
  }

  return (
    <div className="hu-eq-overlay">
      {/* Plot area — draggable bars */}
      <div
        ref={plotRef}
        className="hu-eq-plot-wrap"
        onPointerDown={onPlotPointerDown}
        onPointerMove={onPlotPointerMove}
        onPointerUp={onPlotPointerUp}
        onPointerCancel={onPlotPointerUp}
      >
        <EQCanvas bands={state.bands} />
      </div>

      {/* Per-band ▲ / dB / ▼ controls */}
      <div className="hu-eq-bands-row">
        {EQ_BANDS.map((b, i) => (
          <div key={b.frequency} className="hu-eq-band-col">
            <HoldButton
              onStep={() => bumpBand(i, +GAIN_STEP)}
              ariaLabel={`Increase ${b.label}`}
            >
              <Triangle direction="up" />
            </HoldButton>
            <div className="hu-eq-band-value">
              {formatGain(state.bands[i] ?? 0)}
            </div>
            <HoldButton
              onStep={() => bumpBand(i, -GAIN_STEP)}
              ariaLabel={`Decrease ${b.label}`}
            >
              <Triangle direction="down" />
            </HoldButton>
          </div>
        ))}
      </div>

      {/* Bottom bar — presets, save, reset, back */}
      <div className="hu-eq-bottom">
        <div className="hu-eq-bottom-left">
          <button className="hu-eq-action" onClick={() => setKbOpen(true)}>Save preset</button>
          <button className="hu-eq-action" onClick={resetToPreset}>Reset</button>
        </div>

        <div className="hu-eq-preset-strip">
          <PresetGhost preset={presets[(activeIdx - 2 + presets.length) % presets.length]} dim={2} />
          <PresetGhost preset={presets[(activeIdx - 1 + presets.length) % presets.length]} dim={1} />
          <button className="hu-eq-preset-arrow" onClick={() => cyclePreset(-1)} aria-label="Previous preset">◄</button>
          <div className="hu-eq-preset-name">{presets[activeIdx]?.name ?? 'Custom'}</div>
          <button className="hu-eq-preset-arrow" onClick={() => cyclePreset(+1)} aria-label="Next preset">►</button>
          <PresetGhost preset={presets[(activeIdx + 1) % presets.length]} dim={1} />
          <PresetGhost preset={presets[(activeIdx + 2) % presets.length]} dim={2} />
        </div>

        <button className="hu-eq-back-btn" onClick={onClose} aria-label="Back">↺</button>
      </div>

      {kbOpen && (
        <NameKeyboard
          initial={defaultName()}
          onCancel={() => setKbOpen(false)}
          onAccept={(name) => { savePreset(name); setKbOpen(false) }}
        />
      )}
    </div>
  )
}

// ─── Small bits ─────────────────────────────────────────────────────────────

function formatGain(v: number): string {
  const sign = v > 0 ? '+' : v < 0 ? '' : ''     // negatives carry their own '-'
  // 0.2 dB grid — show 1 decimal when it's not on a whole number.
  const rounded = Math.round(v * 5) / 5
  return rounded % 1 === 0 ? `${sign}${rounded.toFixed(0)}` : `${sign}${rounded.toFixed(1)}`
}

function Triangle({ direction }: { direction: 'up' | 'down' }) {
  // SVG triangles — crisp at any size, no font dependency.
  return direction === 'up'
    ? <svg viewBox="0 0 16 12" width="32" height="24"><polygon points="8,0 16,12 0,12" fill="currentColor" /></svg>
    : <svg viewBox="0 0 16 12" width="32" height="24"><polygon points="0,0 16,0 8,12" fill="currentColor" /></svg>
}

function PresetGhost({ preset, dim }: { preset: EQPreset | undefined; dim: 1 | 2 }) {
  if (!preset) return <div className="hu-eq-preset-ghost" style={{ visibility: 'hidden' }}>—</div>
  return (
    <div className={`hu-eq-preset-ghost hu-eq-preset-ghost-${dim}`}>{preset.name}</div>
  )
}
