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
  adaptiveGain: number
  bassBoost: number
  highFrequencyDamping: number
  smoothing: number
  mixLo: number
  mixHi: number
  glowStrength: number
  showFrequencyLabels: boolean
}

// ─── Analyzer ──────────────────────────────────────────────────────────────

export class AudioVisualizer {
  /** Final per-bar height in [0, 1], gain + peak-hold applied. */
  readonly bars: Float32Array
  /** Per-bar peak-hold marker position in [0, 1]. */
  readonly peaks: Float32Array
  /** Human-readable frequency labels (centre of each band, "60" / "1k" / "10k"). */
  readonly labels: string[]

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

  // Adaptive gain — slow-tracked average peak so quiet songs lift and
  // loud songs stay in range.
  private avgPeak = 0.5

  constructor(cfg: VizConfig) {
    this.cfg = cfg

    this.ring = new Float32Array(FFT_SIZE)
    this.reBuf = new Float32Array(FFT_SIZE)
    this.imBuf = new Float32Array(FFT_SIZE)
    this.magSmooth = new Float32Array(HALF_BINS)

    this.bars = new Float32Array(cfg.bars)
    this.peaks = new Float32Array(cfg.bars)
    this.smoothed = new Float32Array(cfg.bars)
    this.peakVel = new Float32Array(cfg.bars)
    this.peakHoldRem = new Float32Array(cfg.bars)

    this.bandBinLo = new Int32Array(cfg.bars)
    this.bandBinHi = new Int32Array(cfg.bars)
    this.bandFracLo = new Float32Array(cfg.bars)
    this.bandFracHi = new Float32Array(cfg.bars)
    this.bandCenter = new Float32Array(cfg.bars)
    this.bassMask = new Uint8Array(cfg.bars)
    this.highMask = new Uint8Array(cfg.bars)

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
    let frameMax = 0
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

      if (this.smoothed[b] > frameMax) frameMax = this.smoothed[b]
    }

    // 5. Adaptive gain — slow EMA of the per-frame peak so loud + quiet
    //    songs both fill the meter.
    if (frameMax > 0.05) {
      this.avgPeak = this.avgPeak * 0.997 + frameMax * 0.003
    } else {
      this.avgPeak = this.avgPeak * 0.9995 + 0.01 * 0.0005
    }
    if (this.avgPeak < 0.15) this.avgPeak = 0.15
    const gain = Math.min(3, cfg.adaptiveGain / this.avgPeak)

    // 6. Final bar values + peak-hold physics.
    const dt60 = dtMs / 16.667 // normalise to 60-fps frames
    for (let b = 0; b < cfg.bars; b++) {
      let val = this.smoothed[b] * gain
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

// ─── React hook ────────────────────────────────────────────────────────────

/**
 * Drives an AudioVisualizer from the main-process PCM stream.  Re-renders
 * the caller every animation frame so it can read the live `bars` /
 * `peaks` arrays.
 */
export function useAudioVisualizer(cfg: VizConfig) {
  const vizRef = useRef<AudioVisualizer | null>(null)
  if (!vizRef.current) vizRef.current = new AudioVisualizer(cfg)
  const [, setTick] = useState(0)
  const rafRef = useRef(0)

  useEffect(() => {
    const viz = vizRef.current!
    const onPcm = (chunk: Uint8Array) => viz.pushPcmS16(chunk)
    ;(window as any).api?.onAudioPcm?.(onPcm)

    let last = performance.now()
    const loop = (now: number) => {
      const dt = Math.min(100, now - last)
      last = now
      viz.step(dt)
      setTick((t) => (t + 1) & 0xffff)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  return {
    bars: vizRef.current.bars,
    peaks: vizRef.current.peaks,
    labels: vizRef.current.labels,
  }
}
