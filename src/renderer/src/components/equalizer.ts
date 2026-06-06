// Renderer-side EQ state — mirrors the main-process Equalizer.
// Reads `eq:state` pushes from main and exposes a small React hook + helpers.

import { useEffect, useState } from 'react'

export type BiquadKind = 'lowshelf' | 'peaking' | 'highshelf'
export interface BandSpec { frequency: number; kind: BiquadKind; label: string }

// Frequency layout matches src/main/Equalizer.ts BANDS.  Labels are what's
// drawn under each bar in the mockup.
export const EQ_BANDS: BandSpec[] = [
  { frequency: 60,    kind: 'lowshelf',  label: '60'   },
  { frequency: 170,   kind: 'peaking',   label: '170'  },
  { frequency: 310,   kind: 'peaking',   label: '310'  },
  { frequency: 600,   kind: 'peaking',   label: '600'  },
  { frequency: 1000,  kind: 'peaking',   label: '1K'   },
  { frequency: 3000,  kind: 'peaking',   label: '3K'   },
  { frequency: 6000,  kind: 'peaking',   label: '6K'   },
  { frequency: 12000, kind: 'peaking',   label: '12K'  },
  { frequency: 14000, kind: 'peaking',   label: '14K'  },
  { frequency: 16000, kind: 'highshelf', label: '16K'  },
]

export const BAND_COUNT = EQ_BANDS.length
export const GAIN_MIN  = -12
export const GAIN_MAX  =  12
export const GAIN_STEP = 0.2

export interface EQPreset {
  name: string
  bands: number[]
  builtin?: boolean
}

export const BUILTIN_PRESETS: EQPreset[] = [
  { name: 'Flat',         bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],   builtin: true },
  { name: 'Bass Boosted', bands: [4, 3, 2, 0, 0, 0, 0, 0, 0, 0],   builtin: true },
  { name: 'Rock',         bands: [2, 1, 0, -1, -1, 0, 1, 2, 2, 1], builtin: true },
  { name: 'Electronic',   bands: [3, 2, 0, -2, -1, 0, 1, 2, 3, 3], builtin: true },
  { name: 'Jazz',         bands: [2, 1, 0, 1, -1, -1, 0, 1, 1, 2], builtin: true },
]

export interface EQState {
  bands: number[]
  activePreset: string
  customPresets: EQPreset[]
  enabled: boolean
}

const DEFAULT_STATE: EQState = {
  bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  activePreset: 'Flat',
  customPresets: [],
  enabled: true,
}

export function clampGain(v: number): number {
  if (!Number.isFinite(v)) return 0
  const snapped = Math.round(v * 5) / 5   // 0.2 dB grid
  return Math.max(GAIN_MIN, Math.min(GAIN_MAX, snapped))
}

export function useEqualizer() {
  const [state, setState] = useState<EQState>(DEFAULT_STATE)

  useEffect(() => {
    const eq = (window as any).api?.eq
    if (!eq) return
    eq.onState((_: any, s: EQState) => setState(s ?? DEFAULT_STATE))
    eq.requestState()
  }, [])

  const eq = (window as any).api?.eq

  return {
    state,
    setBands:        (b: number[])      => eq?.setBands?.(b),
    setActivePreset: (name: string)     => eq?.setActivePreset?.(name),
    savePreset:      (name: string)     => eq?.savePreset?.(name),
    deletePreset:    (name: string)     => eq?.deletePreset?.(name),
    setEnabled:      (e: boolean)       => eq?.setEnabled?.(e),

    /** Bump a single band by `delta` dB.  Snaps to the 0.2 dB grid and pushes. */
    bumpBand: (idx: number, delta: number) => {
      const next = state.bands.slice()
      next[idx] = clampGain((next[idx] ?? 0) + delta)
      eq?.setBands?.(next)
      setState(s => ({ ...s, bands: next }))   // optimistic so the UI feels instant
    },

    /** Set a single band to an absolute value (used by the drag handler). */
    setBand: (idx: number, value: number) => {
      const next = state.bands.slice()
      next[idx] = clampGain(value)
      eq?.setBands?.(next)
      setState(s => ({ ...s, bands: next }))
    },
  }
}

export function allPresets(s: EQState): EQPreset[] {
  return [...BUILTIN_PRESETS, ...s.customPresets]
}
