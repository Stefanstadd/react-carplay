// Canvas-based audio-visualiser renderer.
//
// Replaces the per-bar DOM/style updates that MusicView + SettingsView used
// to do on every animation frame (32-48 style diffs per tick).  On a Pi 5
// the DOM path was ~5 ms of reconciliation per frame; canvas cuts that to
// a single draw and lets the compositor keep the rest of the head-unit
// running at 60 fps.
//
// Reads bar / peak data directly from the global AudioVisualizer instance
// and only ticks when `enabled` is true, so an off-screen preview costs
// nothing.
import { useEffect, useRef } from 'react'
import { barColor, useVizInstance, useVizTick, type VizConfig } from './audioVisualizer'

interface VizCanvasProps {
  cfg: VizConfig
  /** Bar gradient reference colour — usually the theme `primary`. */
  themePrimary: string
  /** Peak-hold marker colour — comes from theme `peak`.  Falls back to
   *  `themePrimary` for callers that don't care. */
  peakColor?: string
  /** Top-of-gradient colour — what the tallest bars bloom to at their
   *  peak height.  Comes from theme `glow`; defaults to a primary-
   *  blended-white for legacy callers. */
  glowColor?: string
  /** Colour of the drop-shadow behind bars + peak markers.  Comes from
   *  theme `shadow`; defaults to primary. */
  shadowColor?: string
  enabled: boolean
  className?: string
  style?: React.CSSProperties
}

export default function VizCanvas({
  cfg, themePrimary, peakColor, glowColor, shadowColor, enabled, className, style,
}: VizCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viz = useVizInstance(cfg)
  // Capture live refs so the tick callback (which does NOT re-run on every
  // parent render) always sees the latest theme colour and config.
  const cfgRef = useRef(cfg)
  cfgRef.current = cfg
  const primaryRef = useRef(themePrimary)
  primaryRef.current = themePrimary
  const peakColorRef = useRef(peakColor ?? themePrimary)
  peakColorRef.current = peakColor ?? themePrimary
  const glowColorRef = useRef(glowColor ?? undefined)
  glowColorRef.current = glowColor ?? undefined
  const shadowColorRef = useRef(shadowColor ?? peakColor ?? themePrimary)
  shadowColorRef.current = shadowColor ?? peakColor ?? themePrimary

  // Match backing store to element pixel size so lines stay crisp under
  // the head-unit's CSS transform-scale.  Uses ResizeObserver rather than
  // a window resize listener so slide-in animations trigger a resize.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const resize = () => {
      const w = Math.max(1, canvas.clientWidth)
      const h = Math.max(1, canvas.clientHeight)
      // On Pi 5 avoid HiDPI scaling — the panel is 1:1 and doubling pixels
      // just wastes fillRect time.
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  const draw = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)

    const cfg = cfgRef.current
    const primary = primaryRef.current
    const peakCol = peakColorRef.current
    const glowCol = glowColorRef.current       // top of bar gradient
    const shadowCol = shadowColorRef.current   // canvas drop-shadow around bars/peaks
    const barCount = cfg.bars
    const gap = 6
    const totalGap = gap * (barCount - 1)
    const barW = Math.max(1, (w - totalGap) / barCount)

    // Bars: fill with a per-height gradient off `primary`, blooming into
    // `glow` at the top stop.  Drop-shadow uses `shadow` at a strength
    // scaled by cfg.glowStrength.  shadowBlur on canvas is cheap for
    // solid rectangles at this scale (Pi 5's GPU handles it fine at
    // 32-48 bars).
    ctx.save()
    for (let i = 0; i < barCount; i++) {
      const v = viz.bars[i] || 0
      if (v < 0.005) continue
      const x = i * (barW + gap)
      const barH = Math.max(2, v * h)
      const blur = (2 + 10 * v) * cfg.glowStrength
      ctx.fillStyle = barColor(v, cfg.colorCurve, primary, glowCol)
      if (blur > 0.5) {
        ctx.shadowColor = shadowCol
        ctx.shadowBlur = blur
      } else {
        ctx.shadowBlur = 0
      }
      ctx.fillRect(x, h - barH, barW, barH)
    }
    ctx.restore()

    // Peak markers — thin rectangles in the *peak* colour, drop-shadow in
    // the *shadow* colour so they still read against bright bars.
    ctx.save()
    ctx.fillStyle = peakCol
    ctx.shadowColor = shadowCol
    ctx.shadowBlur = 6 + 4 * cfg.glowStrength
    for (let i = 0; i < barCount; i++) {
      const p = viz.peaks[i] || 0
      if (p <= 0.02) continue
      const x = i * (barW + gap)
      const y = h - p * h
      ctx.fillRect(x, y - 1.5, barW, 3)
    }
    ctx.restore()
  }

  // Drive the canvas from the global viz tick.  Re-draw once immediately so
  // an off-screen (disabled) preview still shows the last known state
  // instead of a blank canvas.
  useVizTick(enabled, draw)
  useEffect(() => {
    draw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.bars, themePrimary, peakColor, glowColor, shadowColor])

  return <canvas ref={canvasRef} className={className} style={style} />
}
