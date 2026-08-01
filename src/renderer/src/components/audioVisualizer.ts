// =============================================================================
//  Audio visualiser — professional 32-band real-time spectrum analyser
// =============================================================================
//
//  Pipeline (runs every animation frame):
//
//    PCM ring buffer  ──┐
//         (s16le)       │
//         pushed by     │
//         main process  │
//         via IPC       ▼
//      ┌─ Hann window ──┐
//      │ Cooley-Tukey FFT (4096-pt) with cached twiddle factors
//      │ Magnitude spectrum
//      │ Temporal smoothing on raw magnitudes (Web-Audio style)
//      │ For each log-spaced band:
//      │   • RMS energy (sub-bin interpolation for very low bars)
//      │   • dBFS conversion (calibrated for Hann coherent gain)
//      │   • Normalise to [0, 1] with MIN_DB..MAX_DB clip
//      │   • Bass boost / high-freq damping
//      │   • Noise gate + gamma curve
//      │   • Attack/release smoothing
//      │ Adaptive gain (auto-levels loud vs. quiet songs)
//      │ Peak hold + gravity fall
//      └─ bars[] + peaks[] (Float32Array, same length as VIZ_CONFIG.bars)
//
//  React side: useAudioVisualizer() drives the instance from
//  window.api.onAudioPcm + requestAnimationFrame and triggers a state tick
//  each frame so MusicView re-reads the live arrays.
//
// =============================================================================

import { useEffect, useRef, useState } from 'react'

// ─── Module-level constants ────────────────────────────────────────────────

export const FFT_SIZE = 4096
const SAMPLE_RATE = 48000
const HALF_BINS = FFT_SIZE / 2
const BIN_WIDTH_HZ = SAMPLE_RATE / FFT_SIZE
// Magnitude of a 0 dBFS sinusoid in the Hann-windowed FFT.  Used to
// calibrate the dBFS axis: db = 20*log10(mag / REF_MAX).
const REF_MAX = FFT_SIZE / 4
const MIN_DB = -70
const MAX_DB = 0
const DB_RANGE = MAX_DB - MIN_DB

// ─── Pre-computed FFT helpers (one-time cost at module load) ───────────────

const HANN = new Float32Array(FFT_SIZE)
for (let i = 0; i < FFT_SIZE; i++) {
  HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))
}

const TW_COS = new Float32Array(FFT_SIZE)
const TW_SIN = new Float32Array(FFT_SIZE)
for (let i = 0; i < FFT_SIZE; i++) {
  const angle = (-2 * Math.PI * i) / FFT_SIZE
  TW_COS[i] = Math.cos(angle)
  TW_SIN[i] = Math.sin(angle)
}

// Bit-reversal permutation table.
const BIT_REV = new Uint32Array(FFT_SIZE)
{
  let j = 0
  for (let i = 0; i < FFT_SIZE - 1; i++) {
    BIT_REV[i] = j
    let k = FFT_SIZE >> 1
    while (k > 0 && k <= j) {
      j -= k
      k >>= 1
    }
    j += k
  }
  BIT_REV[FFT_SIZE - 1] = FFT_SIZE - 1
}

/** In-place Cooley-Tukey radix-2 FFT using pre-computed twiddle + bit-rev tables. */
function fft(real: Float32Array, imag: Float32Array): void {
  // Bit-reversal permutation
  for (let i = 0; i < FFT_SIZE; i++) {
    const j = BIT_REV[i]
    if (j > i) {
      const tr = real[i]
      real[i] = real[j]
      real[j] = tr
      const ti = imag[i]
      imag[i] = imag[j]
      imag[j] = ti
    }
  }
  // Butterflies
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const half = size >> 1
    const tableStep = FFT_SIZE / size
    for (let i = 0; i < FFT_SIZE; i += size) {
      let twIdx = 0
      for (let k = 0; k < half; k++) {
        const cosA = TW_COS[twIdx]
        const sinA = TW_SIN[twIdx]
        const aRe = real[i + k + half]
        const aIm = imag[i + k + half]
        const tr = aRe * cosA - aIm * sinA
        const ti = aRe * sinA + aIm * cosA
        real[i + k + half] = real[i + k] - tr
        imag[i + k + half] = imag[i + k] - ti
        real[i + k] += tr
        imag[i + k] += ti
        twIdx += tableStep
      }
    }
  }
}

// ─── Config type ───────────────────────────────────────────────────────────

export type VizConfig = {
  bars: number
  minHz: number
  maxHz: number
  attackSpeed: number
  releaseSpeed: number
  peakHoldTime: number
  peakFallSpeed: number
  gamma: number
  noiseGate: number
  gain: number
  bassBoost: number
  highFrequencyDamping: number
  smoothing: number
  colorCurve: number
  glowStrength: number
  showFrequencyLabels: boolean
}

// ─── Analyzer ──────────────────────────────────────────────────────────────

export class AudioVisualizer {
  /** Final per-bar height in [0, 1], gain + peak-hold applied.  Reallocated
   *  by updateConfig() when the bar count changes, so not `readonly`. */
  bars: Float32Array
  /** Per-bar peak-hold marker position in [0, 1]. */
  peaks: Float32Array
  /** Human-readable frequency labels (centre of each band). */
  labels: string[]

  private cfg: VizConfig
  private ring: Float32Array
  private writePos = 0
  private gotData = false

  // Per-frame scratch
  private reBuf: Float32Array
  private imBuf: Float32Array
  // Smoothed FFT magnitudes (Web-Audio style temporal averaging on raw bins).
  private magSmooth: Float32Array
  // Per-band internal state
  private smoothed: Float32Array       // pre-gain, post attack/release
  private peakVel: Float32Array        // peak-marker velocity (gravity)
  private peakHoldRem: Float32Array    // ms left in the peak hold

  // Pre-computed per-band bin ranges
  private bandBinLo: Int32Array
  private bandBinHi: Int32Array
  private bandFracLo: Float32Array
  private bandFracHi: Float32Array
  private bandCenter: Float32Array
  private bassMask: Uint8Array
  private highMask: Uint8Array

  constructor(cfg: VizConfig) {
    // Buffers that do not depend on the band count.  We never resize the
    // ring/FFT scratch buffers because FFT_SIZE is fixed.
    this.ring = new Float32Array(FFT_SIZE)
    this.reBuf = new Float32Array(FFT_SIZE)
    this.imBuf = new Float32Array(FFT_SIZE)
    this.magSmooth = new Float32Array(HALF_BINS)

    // Per-band arrays + labels are built by allocBands() so updateConfig
    // can rebuild them when the user changes bars / minHz / maxHz.  The
    // public refs below are reassigned inside allocBands.
    this.cfg = cfg
    this.bars = new Float32Array(0)
    this.peaks = new Float32Array(0)
    this.smoothed = new Float32Array(0)
    this.peakVel = new Float32Array(0)
    this.peakHoldRem = new Float32Array(0)
    this.bandBinLo = new Int32Array(0)
    this.bandBinHi = new Int32Array(0)
    this.bandFracLo = new Float32Array(0)
    this.bandFracHi = new Float32Array(0)
    this.bandCenter = new Float32Array(0)
    this.bassMask = new Uint8Array(0)
    this.highMask = new Uint8Array(0)
    this.labels = []
    this.allocBands(cfg)
  }

  /** Apply a new config at runtime.  Rebuilds the band-bin tables only
   *  when the count or frequency range changed; otherwise the new config
   *  is just remembered (the per-frame loop reads `this.cfg.*` directly). */
  updateConfig(cfg: VizConfig): void {
    const prev = this.cfg
    const structuralChange = prev.bars !== cfg.bars
                          || prev.minHz !== cfg.minHz
                          || prev.maxHz !== cfg.maxHz
    this.cfg = cfg
    if (structuralChange) this.allocBands(cfg)
  }

  /** Allocate / reallocate the per-band tables and labels for `cfg`. */
  private allocBands(cfg: VizConfig): void {
    // (The same body lives below in the constructor's setup section
    // historically.  Kept here so updateConfig and the constructor share it.)
    this.bars        = new Float32Array(cfg.bars)
    this.peaks       = new Float32Array(cfg.bars)
    this.smoothed    = new Float32Array(cfg.bars)
    this.peakVel     = new Float32Array(cfg.bars)
    this.peakHoldRem = new Float32Array(cfg.bars)

    this.bandBinLo   = new Int32Array(cfg.bars)
    this.bandBinHi   = new Int32Array(cfg.bars)
    this.bandFracLo  = new Float32Array(cfg.bars)
    this.bandFracHi  = new Float32Array(cfg.bars)
    this.bandCenter  = new Float32Array(cfg.bars)
    this.bassMask    = new Uint8Array(cfg.bars)
    this.highMask    = new Uint8Array(cfg.bars)

    // Log-spaced band edges.  Each band b covers
    //   [minHz * (maxHz/minHz)^(b/bars), minHz * (maxHz/minHz)^((b+1)/bars)]
    // Geometric centre = sqrt(fLo * fHi).
    this.labels = []
    for (let b = 0; b < cfg.bars; b++) {
      const fLo = cfg.minHz * Math.pow(cfg.maxHz / cfg.minHz, b / cfg.bars)
      const fHi = cfg.minHz * Math.pow(cfg.maxHz / cfg.minHz, (b + 1) / cfg.bars)
      const fC = Math.sqrt(fLo * fHi)
      this.bandFracLo[b] = fLo / BIN_WIDTH_HZ
      this.bandFracHi[b] = fHi / BIN_WIDTH_HZ
      this.bandBinLo[b] = Math.floor(this.bandFracLo[b])
      this.bandBinHi[b] = Math.min(HALF_BINS - 1, Math.ceil(this.bandFracHi[b]) - 1)
      // Ensure binHi >= binLo so even sub-bin bands point at *something*.
      if (this.bandBinHi[b] < this.bandBinLo[b]) this.bandBinHi[b] = this.bandBinLo[b]
      this.bandCenter[b] = fC
      this.bassMask[b] = fC < 250 ? 1 : 0
      this.highMask[b] = fC > 4000 ? 1 : 0

      const k = fC / 1000
      if (k >= 10) this.labels.push(`${Math.round(k)}k`)
      else if (k >= 1) this.labels.push(`${k.toFixed(1).replace(/\.0$/, '')}k`)
      else this.labels.push(`${Math.round(fC)}`)
    }
  }

  /** Append raw s16le PCM bytes (from the main-process parec) to the ring. */
  pushPcmS16(buf: Uint8Array): void {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const len = buf.byteLength >> 1
    for (let i = 0; i < len; i++) {
      const s = view.getInt16(i * 2, true) / 32768
      this.ring[this.writePos] = s
      this.writePos = (this.writePos + 1) % FFT_SIZE
      if (s !== 0) this.gotData = true
    }
  }

  hasData(): boolean {
    return this.gotData
  }

  /** Advance one frame.  dtMs = wall time elapsed since the previous call. */
  step(dtMs: number): void {
    const cfg = this.cfg
    if (!this.gotData) {
      // No samples yet → keep bars + peaks falling toward zero (smooth).
      for (let b = 0; b < cfg.bars; b++) {
        this.bars[b] *= 0.92
        this.peaks[b] = Math.max(this.peaks[b] - 0.005, this.bars[b])
      }
      return
    }

    // 1. Copy ring into reBuf in time-order, applying Hann window.
    for (let i = 0; i < FFT_SIZE; i++) {
      const src = (this.writePos + i) % FFT_SIZE
      this.reBuf[i] = this.ring[src] * HANN[i]
      this.imBuf[i] = 0
    }

    // 2. FFT in place.
    fft(this.reBuf, this.imBuf)

    // 3. Magnitudes + Web-Audio-style smoothing on the raw bins.
    const a = cfg.smoothing
    for (let k = 0; k < HALF_BINS; k++) {
      const re = this.reBuf[k]
      const im = this.imBuf[k]
      const mag = Math.sqrt(re * re + im * im)
      this.magSmooth[k] = this.magSmooth[k] * a + mag * (1 - a)
    }

    // 4. Per-band processing.
    for (let b = 0; b < cfg.bars; b++) {
      const binLo = this.bandBinLo[b]
      const binHi = this.bandBinHi[b]
      const fracLo = this.bandFracLo[b]
      const fracHi = this.bandFracHi[b]

      // RMS energy in this band.
      let rms = 0
      if (binHi === binLo) {
        // Sub-bin band — linearly interpolate at the band's centre frequency.
        const center = (fracLo + fracHi) / 2
        const f = Math.floor(center)
        const t = center - f
        const m0 = this.magSmooth[f]
        const m1 = f + 1 < HALF_BINS ? this.magSmooth[f + 1] : m0
        rms = m0 * (1 - t) + m1 * t
      } else {
        // Multi-bin — RMS with edge-weighted partial bins.
        let sumE = 0
        let totalW = 0
        for (let k = binLo; k <= binHi; k++) {
          let w = 1
          if (k === binLo && binLo < fracLo) w = binLo + 1 - fracLo
          else if (k === binHi && binHi + 1 > fracHi) w = fracHi - binHi
          if (w < 0) w = 0
          if (w > 1) w = 1
          const m = this.magSmooth[k]
          sumE += w * m * m
          totalW += w
        }
        rms = totalW > 0 ? Math.sqrt(sumE / totalW) : 0
      }

      // Convert to dBFS, normalise to [0, 1].
      const db = 20 * Math.log10(rms / REF_MAX + 1e-9)
      let v = (db - MIN_DB) / DB_RANGE
      if (v < 0) v = 0
      else if (v > 1) v = 1

      // Frequency-band shaping.
      if (this.bassMask[b]) v *= cfg.bassBoost
      if (this.highMask[b]) v *= cfg.highFrequencyDamping

      // Noise gate (squash, then rescale remaining range so loud parts
      // aren't visually attenuated).
      if (v < cfg.noiseGate) v = 0
      else v = (v - cfg.noiseGate) / (1 - cfg.noiseGate)

      // Gamma curve for visual contrast.
      if (v > 0) v = Math.pow(v, cfg.gamma)

      // Attack / release smoothing per band.
      const prev = this.smoothed[b]
      if (v > prev) this.smoothed[b] = prev + (v - prev) * cfg.attackSpeed
      else this.smoothed[b] = prev + (v - prev) * cfg.releaseSpeed
    }

    // 5. Final bar values + peak-hold physics.  Static gain — replaces
    //    the old adaptive-leveling which felt visibly laggy.
    const dt60 = dtMs / 16.667 // normalise to 60-fps frames
    for (let b = 0; b < cfg.bars; b++) {
      let val = this.smoothed[b] * cfg.gain
      if (val > 1) val = 1
      if (val < 0) val = 0
      this.bars[b] = val

      if (val >= this.peaks[b]) {
        this.peaks[b] = val
        this.peakVel[b] = 0
        this.peakHoldRem[b] = cfg.peakHoldTime
      } else if (this.peakHoldRem[b] > 0) {
        this.peakHoldRem[b] -= dtMs
      } else {
        this.peakVel[b] += cfg.peakFallSpeed * dt60
        this.peaks[b] -= this.peakVel[b] * dt60
        if (this.peaks[b] < val) {
          this.peaks[b] = val
          this.peakVel[b] = 0
        } else if (this.peaks[b] < 0) {
          this.peaks[b] = 0
          this.peakVel[b] = 0
        }
      }
    }
  }
}

// ─── Singleton instance + animation loop ───────────────────────────────────
// The visualizer is module-scoped so its state (smoothed bars, peak hold
// timers, ring buffer) survives across React mount/unmount cycles.
// Switching to another head-unit screen no longer resets the bars.

let GLOBAL_VIZ: AudioVisualizer | null = null
let PCM_HOOKED = false
let LOOP_STARTED = false
const LISTENERS = new Set<() => void>()

function ensureViz(cfg: VizConfig): AudioVisualizer {
  if (!GLOBAL_VIZ) GLOBAL_VIZ = new AudioVisualizer(cfg)
  else GLOBAL_VIZ.updateConfig(cfg)
  if (!PCM_HOOKED) {
    const api = (window as any).api
    if (api?.onAudioPcm) {
      api.onAudioPcm((chunk: Uint8Array) => GLOBAL_VIZ!.pushPcmS16(chunk))
      PCM_HOOKED = true
    }
  }
  if (!LOOP_STARTED) {
    LOOP_STARTED = true
    let last = performance.now()
    const loop = (now: number) => {
      const dt = Math.min(100, now - last)
      last = now
      // Skip the FFT + per-band work and React notifications when no
      // subscriber is listening — this is the "idle" state requested by the
      // user.  The PCM ring keeps filling in pushPcmS16; when a subscriber
      // re-attaches the next frame just picks up from the current write head.
      if (LISTENERS.size > 0) {
        GLOBAL_VIZ!.step(dt)
        LISTENERS.forEach((fn) => fn())
      }
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }
  return GLOBAL_VIZ
}

// ─── React hook ────────────────────────────────────────────────────────────

/**
 * Subscribes the calling component to per-frame re-renders driven by the
 * global AudioVisualizer.  Returns live refs to the bars/peaks arrays;
 * read them inline in JSX.
 */
export function useAudioVisualizer(cfg: VizConfig, enabled: boolean = true) {
  const viz = ensureViz(cfg)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!enabled) return
    const fn = () => setTick((t) => (t + 1) & 0xffff)
    LISTENERS.add(fn)
    return () => {
      LISTENERS.delete(fn)
    }
  }, [enabled])

  return { bars: viz.bars, peaks: viz.peaks, labels: viz.labels }
}

/**
 * Ensures the global visualizer instance stays in sync with `cfg` without
 * triggering a per-frame React re-render.  Used by the canvas renderer,
 * which reads viz.bars / viz.peaks directly inside its rAF loop.
 */
export function useVizInstance(cfg: VizConfig): AudioVisualizer {
  return ensureViz(cfg)
}

/**
 * Registers a per-frame tick callback with the global visualizer loop.
 * Unlike useAudioVisualizer this does NOT force a React re-render — the
 * caller uses it to drive an imperative renderer (canvas, refs, etc.).
 */
export function useVizTick(enabled: boolean, cb: () => void): void {
  const cbRef = useRef(cb)
  cbRef.current = cb
  useEffect(() => {
    if (!enabled) return
    const fn = () => cbRef.current()
    LISTENERS.add(fn)
    return () => { LISTENERS.delete(fn) }
  }, [enabled])
}

// ─── Color palette ─────────────────────────────────────────────────────────
// Multi-stop gradient: dark green at silence, full bright at near-peak,
// hot green-white at the very top.  colorCurve in config bends the curve.

type RGB = readonly [number, number, number]

// Default green stops used when no theme primary is passed in (e.g. early
// boot before applyTheme runs).  At runtime barColor() rebuilds these
// against the active --hu-primary so the visualiser tracks the theme.
const FALLBACK_STOPS: { t: number; rgb: RGB }[] = [
  { t: 0.0,  rgb: [0,  30,   4] },
  { t: 0.25, rgb: [0,  90,   6] },
  { t: 0.55, rgb: [0, 170,  10] },
  { t: 0.85, rgb: [0, 240,  16] },
  { t: 1.0,  rgb: [150, 255, 130] },
]

// One-entry cache: most renders pass the same primary+glow 32-48 times in
// a row (once per bar per frame).  Cache on the composite key so the
// gradient only rebuilds when the theme changes.
let _cachedKey = ''
let _cachedStops: { t: number; rgb: RGB }[] = FALLBACK_STOPS

function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff] as RGB
}

function stopsFromTheme(primary: string, glow?: string): { t: number; rgb: RGB }[] {
  const key = `${primary}|${glow ?? ''}`
  if (key === _cachedKey) return _cachedStops
  const rgb = hexToRgb(primary)
  if (!rgb) return FALLBACK_STOPS
  // Scale the primary toward black at the low end so quiet bars stay subtle.
  const dark = (k: number): RGB => [Math.round(rgb[0] * k), Math.round(rgb[1] * k), Math.round(rgb[2] * k)]
  // Top stop: prefer the theme's explicit glow colour so bars *bloom* to
  // whatever the user picked at their peak height.  Fall back to
  // primary-toward-white for legacy behaviour when no glow is provided.
  const glowRgb = glow ? hexToRgb(glow) : null
  const top: RGB = glowRgb ?? [
    Math.round(rgb[0] + (255 - rgb[0]) * 0.45),
    Math.round(rgb[1] + (255 - rgb[1]) * 0.45),
    Math.round(rgb[2] + (255 - rgb[2]) * 0.45),
  ]
  _cachedKey = key
  _cachedStops = [
    { t: 0.0,  rgb: dark(0.12) },
    { t: 0.25, rgb: dark(0.32) },
    { t: 0.55, rgb: dark(0.65) },
    { t: 0.85, rgb: rgb },   // primary — solid mid-height colour
    { t: 1.0,  rgb: top },   // glow — what the bar radiates at peak height
  ]
  return _cachedStops
}

/** Returns a CSS rgb() string for a bar height (0..1).  Exponential
 *  curve via cfg.colorCurve (>1 emphasises the bright/hot end).
 *  - `primary`: mid-height colour (theme.primary).
 *  - `glow`:    top-of-gradient colour (theme.glow) — what the tallest
 *               bars bloom to.  Falls back to primary-blended-white so
 *               callers that haven't wired up glow yet keep the old look. */
export function barColor(h: number, colorCurve = 1.6, primary?: string, glow?: string): string {
  const stops = primary ? stopsFromTheme(primary, glow) : FALLBACK_STOPS
  if (h <= 0) return `rgb(${stops[0].rgb.join(',')})`
  const t = Math.pow(Math.min(1, h), 1 / colorCurve)
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].t) {
      const lo = stops[i - 1]
      const hi = stops[i]
      const k = (t - lo.t) / (hi.t - lo.t)
      const r = Math.round(lo.rgb[0] + (hi.rgb[0] - lo.rgb[0]) * k)
      const g = Math.round(lo.rgb[1] + (hi.rgb[1] - lo.rgb[1]) * k)
      const b = Math.round(lo.rgb[2] + (hi.rgb[2] - lo.rgb[2]) * k)
      return `rgb(${r},${g},${b})`
    }
  }
  const last = stops[stops.length - 1].rgb
  return `rgb(${last.join(',')})`
}
