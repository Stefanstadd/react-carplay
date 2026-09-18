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
} from './equalizer'
import NameKeyboard from './NameKeyboard'

// ─── Canvas bar graph ────────────────────────────────────────────────────────

// dB grid ticks — clamp matches GAIN_MIN/GAIN_MAX (±8) so the ±12 zones are
// gone from the plot entirely.
const Y_TICKS = [-8, -4, 0, 4, 8]

// Canvas plot padding constants used by both the draw() function and the
// drag handler so they stay in sync.
const PAD_L = 70, PAD_R = 24, PAD_T = 24, PAD_B = 36

/** Look up a CSS custom property on the root and return the trimmed value.
 *  Used by the canvas so it picks up theme colours. */
function readVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** Draw `bands` on the canvas, but tween each height toward its target on
 *  every rAF tick.  When the preset switches the bars slide from their
 *  previous values to the new ones instead of snapping. */
function EQCanvas({ bands }: { bands: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  // Tracks the active theme so we redraw the canvas when colours change.
  const [themeTick, setThemeTick] = useState(0)
  useEffect(() => {
    const obs = new MutationObserver(() => setThemeTick(t => t + 1))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    return () => obs.disconnect()
  }, [])

  // Displayed heights — start at the incoming values so the first render
  // isn't a slide from 0.  Kept in a ref so the rAF loop can mutate without
  // triggering re-renders.
  const displayed = useRef<number[]>(bands.slice())
  const target    = useRef<number[]>(bands.slice())
  const rafId     = useRef<number | null>(null)

  useEffect(() => { target.current = bands.slice() }, [bands])

  useEffect(() => {
    const cvs = ref.current
    if (!cvs) return
    const resize = () => {
      const rect = cvs.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        cvs.width  = Math.floor(rect.width)
        cvs.height = Math.floor(rect.height)
      }
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(cvs)

    // Ease displayed → target every frame.  ~15% per tick converges in
    // ~200 ms without visible over-smoothing on 60 Hz.
    const tick = () => {
      let dirty = false
      const d = displayed.current
      const t = target.current
      for (let i = 0; i < d.length; i++) {
        const diff = (t[i] ?? 0) - (d[i] ?? 0)
        if (Math.abs(diff) < 0.01) {
          if (d[i] !== t[i]) { d[i] = t[i]; dirty = true }
        } else {
          d[i] = (d[i] ?? 0) + diff * 0.15
          dirty = true
        }
      }
      if (dirty) draw(cvs, d)
      rafId.current = requestAnimationFrame(tick)
    }
    rafId.current = requestAnimationFrame(tick)
    return () => {
      ro.disconnect()
      if (rafId.current !== null) cancelAnimationFrame(rafId.current)
    }
  }, [themeTick])

  return <canvas ref={ref} className="hu-eq-canvas" />
}

function draw(cvs: HTMLCanvasElement, bands: number[]) {
  const ctx = cvs.getContext('2d')
  if (!ctx) return
  const W = cvs.width, H = cvs.height
  ctx.clearRect(0, 0, W, H)

  // Theme colours, read at paint time so theme changes flow into the canvas.
  const barColor       = readVar('--hu-primary',      '#00ff00')
  const gridColor      = readVar('--hu-primary-deep', '#004400')
  const gridLabelColor = readVar('--hu-primary',      '#00ff0a')

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
    ctx.strokeStyle = gridColor
    ctx.beginPath()
    ctx.moveTo(PAD_L, y)
    ctx.lineTo(W - PAD_R, y)
    ctx.stroke()
    ctx.fillStyle = gridLabelColor
    ctx.font = '24px "VT323", monospace'
    ctx.fillText(`${db > 0 ? '+' : ''}${db}`, PAD_L - 12, y)
  }

  // ── Bars (centered around the 0 dB baseline that yFor() computes per call)
  const slot = plotW / BAND_COUNT
  const barW = Math.max(8, Math.floor(slot * 0.55))
  ctx.fillStyle = barColor
  for (let i = 0; i < BAND_COUNT; i++) {
    const g = bands[i] ?? 0
    const x = Math.round(PAD_L + slot * i + (slot - barW) / 2)
    const topY = yFor(Math.max(0, g))
    const botY = yFor(Math.min(0, g))
    const h = Math.max(2, botY - topY)
    ctx.fillRect(x, topY, barW, h)
  }

  // ── Frequency labels under each bar
  ctx.fillStyle = barColor
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

// ─── Main EQ overlay ────────────────────────────────────────────────────────

interface EQViewProps {
  onClose: () => void
}

export default function EQView({ onClose }: EQViewProps) {
  const { state, bumpBand, setBand, setActivePreset, savePreset } = useEqualizer()
  const [kbOpen, setKbOpen] = useState(false)
  // Direction of the last preset switch (-1 = left, +1 = right).  Drives the
  // slide-in/out animation on the preset strip.  Bumping the key on every
  // switch re-triggers the CSS animation.
  const [slideDir, setSlideDir] = useState<-1 | 0 | 1>(0)
  const [slideKey, setSlideKey] = useState(0)

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
    setSlideDir(dir)
    setSlideKey(k => k + 1)
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
      {/* Back arrow — top-left, rendered as a left-pointing arrow.
       *  Global Escape/Backspace also close the overlay via App.tsx. */}
      <button className="hu-eq-back-btn hu-eq-back-btn-tl" onClick={onClose} aria-label="Back">
        <BackArrow />
      </button>

      {/* Preset strip — moved up so it sits between the back button and the
       *  plot.  The strip is a carousel: switching preset animates the name
       *  in from the direction of the button the user pressed. */}
      <div className="hu-eq-preset-strip">
        <button className="hu-eq-preset-arrow" onClick={() => cyclePreset(-1)} aria-label="Previous preset">◄</button>
        <div className="hu-eq-preset-name-wrap">
          <div
            key={slideKey}
            className={`hu-eq-preset-name${
              slideDir === -1 ? ' hu-eq-preset-slide-left' :
              slideDir ===  1 ? ' hu-eq-preset-slide-right' : ''
            }`}
            title={presets[activeIdx]?.name}
          >
            {presets[activeIdx]?.name ?? 'Custom'}
          </div>
        </div>
        <button className="hu-eq-preset-arrow" onClick={() => cyclePreset(+1)} aria-label="Next preset">►</button>
      </div>

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

      {/* Per-band ▲ / dB / ▼ controls — arrows nudged up (marginTop:-6) so
       *  they sit closer to the top of the value strip. */}
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

      {/* Bottom bar — save + reset (back moved to top-left) */}
      <div className="hu-eq-bottom">
        <div className="hu-eq-bottom-left">
          <button className="hu-eq-action" onClick={() => setKbOpen(true)}>Save preset</button>
          <button className="hu-eq-action" onClick={resetToPreset}>Reset</button>
        </div>
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

function BackArrow() {
  return (
    <svg viewBox="0 0 32 24" width="46" height="34" aria-hidden="true">
      <polygon points="12,0 12,8 32,8 32,16 12,16 12,24 0,12" fill="currentColor" />
    </svg>
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

