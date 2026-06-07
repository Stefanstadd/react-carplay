// Renderer-side mirror of the main-process UserSettings store.
// One hook (useUserSettings) subscribes to `user:state` pushes, applies the
// theme by setting CSS variables on <html>, and exposes setters that just
// fire IPC at main.

import { useEffect, useState, useCallback } from 'react'

// ─── Types (must match src/main/UserSettings.ts) ─────────────────────────────

export interface ThemePreset {
  name: string
  primary: string
  peak: string
  builtin?: boolean
}

export const BUILTIN_THEMES: ThemePreset[] = [
  { name: 'Saab Green',  primary: '#00ff0a', peak: '#00ff0a', builtin: true },
  { name: 'Amber',       primary: '#ffb000', peak: '#ffd900', builtin: true },
  { name: 'Ice Blue',    primary: '#00b3ff', peak: '#7ad8ff', builtin: true },
  { name: 'Crimson',     primary: '#ff2244', peak: '#ffaa44', builtin: true },
  { name: 'Cyan',        primary: '#00e8d0', peak: '#a8fff5', builtin: true },
  { name: 'Hot Pink',    primary: '#ff3aa0', peak: '#ff9ce0', builtin: true },
  { name: 'White',       primary: '#dfe7f0', peak: '#ffffff', builtin: true },
]

export interface VizConfig {
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

export const DEFAULT_VIZ: VizConfig = {
  bars: 32,
  minHz: 20,
  maxHz: 20000,
  attackSpeed: 0.75,
  releaseSpeed: 0.06,
  peakHoldTime: 120,
  peakFallSpeed: 0.04,
  gamma: 1.35,
  noiseGate: 0.015,
  gain: 1.5,
  bassBoost: 1.15,
  highFrequencyDamping: 0.9,
  smoothing: 0.18,
  colorCurve: 1.6,
  glowStrength: 0.7,
  showFrequencyLabels: false,
}

export interface GaugeDef {
  id: string
  label: string
  min: number
  max: number
  unit: string
  canKey: string
  warnAbove?: number
}

export interface UserSettings {
  theme: {
    primary: string
    peak: string
    activePreset: string
    customPresets: ThemePreset[]
  }
  viz: VizConfig
  gauges: GaugeDef[]
}

const DEFAULT_STATE: UserSettings = {
  theme: {
    primary: BUILTIN_THEMES[0].primary,
    peak:    BUILTIN_THEMES[0].peak,
    activePreset: BUILTIN_THEMES[0].name,
    customPresets: [],
  },
  viz: { ...DEFAULT_VIZ },
  gauges: [],
}

// ─── CSS variable application ────────────────────────────────────────────────
// Derives the same family of green tones the head unit CSS expects from a
// single primary hex.  Keeps every existing component (header, list rows,
// buttons, etc.) in sync when the user picks a new colour.

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const x = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${x(r)}${x(g)}${x(b)}`
}

/** Scales a hex by `k` (0 → black, 1 → original, >1 → towards white). */
function scale(hex: string, k: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  if (k <= 1) return rgbToHex([rgb[0] * k, rgb[1] * k, rgb[2] * k])
  // Lerp towards white for values > 1
  const t = Math.min(1, k - 1)
  return rgbToHex([rgb[0] + (255 - rgb[0]) * t, rgb[1] + (255 - rgb[1]) * t, rgb[2] + (255 - rgb[2]) * t])
}

export function applyTheme(primary: string, peak: string) {
  const root = document.documentElement
  root.style.setProperty('--hu-green',      primary)
  root.style.setProperty('--hu-peak',       peak)
  root.style.setProperty('--hu-green-mid',  scale(primary, 0.54))
  root.style.setProperty('--hu-green-dim',  scale(primary, 0.36))
  root.style.setProperty('--hu-green-deep', scale(primary, 0.18))
  // Match deep-background tint to the primary hue so the whole UI shifts
  // (e.g. amber theme has an amber-tinted background).
  root.style.setProperty('--hu-bg-deep',  scale(primary, 0.04))
  root.style.setProperty('--hu-bg-panel', scale(primary, 0.02))
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useUserSettings() {
  const [state, setState] = useState<UserSettings>(DEFAULT_STATE)

  useEffect(() => {
    const u = (window as any).api?.user
    if (!u) return
    u.onState((_: any, s: UserSettings) => {
      const merged = mergeWithDefaults(s)
      setState(merged)
      applyTheme(merged.theme.primary, merged.theme.peak)
    })
    u.requestState()
  }, [])

  const u = (window as any).api?.user

  const setTheme = useCallback((patch: Partial<UserSettings['theme']>) => {
    setState(prev => {
      const next: UserSettings = { ...prev, theme: { ...prev.theme, ...patch } }
      applyTheme(next.theme.primary, next.theme.peak)
      return next
    })
    u?.setTheme?.(patch)
  }, [u])

  const saveThemePreset   = useCallback((name: string) => u?.saveThemePreset?.(name), [u])
  const deleteThemePreset = useCallback((name: string) => u?.deleteThemePreset?.(name), [u])

  const setViz = useCallback((patch: Partial<VizConfig>) => {
    setState(prev => ({ ...prev, viz: { ...prev.viz, ...patch } }))
    u?.setViz?.(patch)
  }, [u])
  const resetViz = useCallback(() => u?.resetViz?.(), [u])

  const upsertGauge = useCallback((g: GaugeDef) => u?.upsertGauge?.(g), [u])
  const deleteGauge = useCallback((id: string) => u?.deleteGauge?.(id), [u])

  return {
    state,
    setTheme,
    saveThemePreset,
    deleteThemePreset,
    setViz,
    resetViz,
    upsertGauge,
    deleteGauge,
  }
}

export function allThemes(s: UserSettings): ThemePreset[] {
  return [...BUILTIN_THEMES, ...s.theme.customPresets]
}

function mergeWithDefaults(s: UserSettings | undefined | null): UserSettings {
  if (!s) return DEFAULT_STATE
  return {
    theme: {
      primary: s.theme?.primary ?? DEFAULT_STATE.theme.primary,
      peak:    s.theme?.peak    ?? DEFAULT_STATE.theme.peak,
      activePreset:  s.theme?.activePreset  ?? DEFAULT_STATE.theme.activePreset,
      customPresets: Array.isArray(s.theme?.customPresets) ? s.theme.customPresets : [],
    },
    viz: { ...DEFAULT_VIZ, ...(s.viz ?? {}) },
    gauges: Array.isArray(s.gauges) ? s.gauges : [],
  }
}
