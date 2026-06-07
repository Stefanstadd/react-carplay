// One persisted blob covering everything the user can tweak in the new
// head-unit Settings screen — theme colors, visualizer config, gauge
// definitions.  Stored at ~/.config/headunit/user.json and pushed to the
// renderer over IPC so the UI can update without a restart.
//
// Anything CarPlay/dongle-specific stays in the old config.json + Settings.tsx
// path managed by index.ts.  This module only owns the head-unit cosmetics
// and the dash-side gauge definitions.

import { ipcMain, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ─── Types pushed to the renderer ────────────────────────────────────────────

export interface ThemePreset {
  name: string
  primary: string     // --hu-primary (was --hu-green)
  peak: string        // --hu-peak (visualizer peaks + gauge needles)
  background: string  // --hu-bg-deep
  warn: string        // --hu-warn
  miss: string        // --hu-miss
  builtin?: boolean
}

export const BUILTIN_THEMES: ThemePreset[] = [
  { name: 'Saab Green',  primary: '#00ff0a', peak: '#00ff0a', background: '#001500', warn: '#ff6b1a', miss: '#ff4444', builtin: true },
  { name: 'Amber',       primary: '#ffb000', peak: '#ffd900', background: '#1a0f00', warn: '#ff4400', miss: '#ff2244', builtin: true },
  { name: 'Ice Blue',    primary: '#00b3ff', peak: '#7ad8ff', background: '#001022', warn: '#ff9933', miss: '#ff3355', builtin: true },
  { name: 'Crimson',     primary: '#ff2244', peak: '#ffaa44', background: '#150000', warn: '#ffcc00', miss: '#ff8800', builtin: true },
  { name: 'Cyan',        primary: '#00e8d0', peak: '#a8fff5', background: '#001a18', warn: '#ffaa33', miss: '#ff3366', builtin: true },
  { name: 'Hot Pink',    primary: '#ff3aa0', peak: '#ff9ce0', background: '#180012', warn: '#ffaa00', miss: '#ff5544', builtin: true },
  { name: 'White',       primary: '#dfe7f0', peak: '#ffffff', background: '#0a0e14', warn: '#ffaa33', miss: '#ff4444', builtin: true },
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
  /** CAN-bus key the renderer pulls the live value from once the hardware
   *  is wired up.  Free-form string — meaning is up to whatever feeds
   *  vehicleData on the IPC. */
  canKey: string
  /** Optional value above which the gauge enters warn (orange) state. */
  warnAbove?: number
}

export interface UserSettings {
  theme: {
    primary: string
    peak: string
    background: string
    warn: string
    miss: string
    activePreset: string
    customPresets: ThemePreset[]
  }
  viz: VizConfig
  gauges: GaugeDef[]
}

const DEFAULT_SETTINGS: UserSettings = {
  theme: {
    primary:    BUILTIN_THEMES[0].primary,
    peak:       BUILTIN_THEMES[0].peak,
    background: BUILTIN_THEMES[0].background,
    warn:       BUILTIN_THEMES[0].warn,
    miss:       BUILTIN_THEMES[0].miss,
    activePreset: BUILTIN_THEMES[0].name,
    customPresets: [],
  },
  viz: { ...DEFAULT_VIZ },
  gauges: [],
}

// ─── Manager ─────────────────────────────────────────────────────────────────

export class UserSettingsManager {
  private getWindow: () => BrowserWindow | undefined
  private state: UserSettings = clone(DEFAULT_SETTINGS)
  private file: string

  constructor(getWindow: () => BrowserWindow | undefined) {
    this.getWindow = getWindow
    this.file = path.join(os.homedir(), '.config', 'headunit', 'user.json')
    this.load()
    this.registerIpc()
  }

  start() {
    this.push()
  }

  // ─── Load / save ───────────────────────────────────────────────────────────

  private load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
        this.state = sanitize(raw)
        console.log('[user] settings loaded')
      }
    } catch (err) {
      console.warn('[user] load failed:', (err as Error).message)
    }
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2))
    } catch (err) {
      console.warn('[user] save failed:', (err as Error).message)
    }
  }

  // ─── IPC ───────────────────────────────────────────────────────────────────

  private registerIpc() {
    ipcMain.on('user:requestState', () => this.push())

    // Theme
    ipcMain.on('user:setTheme', (_e, t: Partial<UserSettings['theme']>) => {
      this.state.theme = { ...this.state.theme, ...t }
      // If any colour was tweaked manually (not via preset selection), drop
      // the active-preset name so the swatch UI shows "custom".
      const colorTweaked = !!(t.primary || t.peak || t.background || t.warn || t.miss)
      if (colorTweaked && !t.activePreset) {
        const match = matchPreset(this.state.theme, this.allThemes())
        this.state.theme.activePreset = match ?? '—'
      }
      this.save(); this.push()
    })

    ipcMain.on('user:saveThemePreset', (_e, name: string) => {
      const clean = String(name || '').trim().slice(0, 24)
      if (!clean) return
      if (BUILTIN_THEMES.find(p => p.name.toLowerCase() === clean.toLowerCase())) return
      const without = this.state.theme.customPresets.filter(p => p.name.toLowerCase() !== clean.toLowerCase())
      without.push({
        name: clean,
        primary:    this.state.theme.primary,
        peak:       this.state.theme.peak,
        background: this.state.theme.background,
        warn:       this.state.theme.warn,
        miss:       this.state.theme.miss,
      })
      this.state.theme.customPresets = without
      this.state.theme.activePreset = clean
      this.save(); this.push()
    })

    ipcMain.on('user:deleteThemePreset', (_e, name: string) => {
      this.state.theme.customPresets = this.state.theme.customPresets.filter(p => p.name !== name)
      if (this.state.theme.activePreset === name) {
        const def = BUILTIN_THEMES[0]
        this.state.theme.primary    = def.primary
        this.state.theme.peak       = def.peak
        this.state.theme.background = def.background
        this.state.theme.warn       = def.warn
        this.state.theme.miss       = def.miss
        this.state.theme.activePreset = def.name
      }
      this.save(); this.push()
    })

    // Visualizer config
    ipcMain.on('user:setViz', (_e, v: Partial<VizConfig>) => {
      this.state.viz = sanitizeViz({ ...this.state.viz, ...v })
      this.save(); this.push()
    })

    ipcMain.on('user:resetViz', () => {
      this.state.viz = { ...DEFAULT_VIZ }
      this.save(); this.push()
    })

    // Gauges
    ipcMain.on('user:upsertGauge', (_e, g: GaugeDef) => {
      const clean = sanitizeGauge(g)
      if (!clean) return
      const idx = this.state.gauges.findIndex(x => x.id === clean.id)
      if (idx >= 0) this.state.gauges[idx] = clean
      else this.state.gauges.push(clean)
      this.save(); this.push()
    })

    ipcMain.on('user:deleteGauge', (_e, id: string) => {
      this.state.gauges = this.state.gauges.filter(g => g.id !== id)
      this.save(); this.push()
    })
  }

  private push() {
    const w = this.getWindow()
    if (!w?.webContents) return
    try { w.webContents.send('user:state', this.state) } catch { /* */ }
  }

  private allThemes(): ThemePreset[] {
    return [...BUILTIN_THEMES, ...this.state.theme.customPresets]
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) }

function isHex(s: any): s is string {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s)
}

function sanitize(raw: any): UserSettings {
  const out: UserSettings = clone(DEFAULT_SETTINGS)
  if (raw?.theme) {
    if (isHex(raw.theme.primary))    out.theme.primary    = raw.theme.primary
    if (isHex(raw.theme.peak))       out.theme.peak       = raw.theme.peak
    if (isHex(raw.theme.background)) out.theme.background = raw.theme.background
    if (isHex(raw.theme.warn))       out.theme.warn       = raw.theme.warn
    if (isHex(raw.theme.miss))       out.theme.miss       = raw.theme.miss
    if (typeof raw.theme.activePreset === 'string') out.theme.activePreset = raw.theme.activePreset
    if (Array.isArray(raw.theme.customPresets)) {
      out.theme.customPresets = raw.theme.customPresets
        .filter((p: any) => p && typeof p.name === 'string' && isHex(p.primary) && isHex(p.peak))
        .map((p: any) => ({
          name: p.name.slice(0, 24),
          primary:    p.primary,
          peak:       p.peak,
          // Fill in sane defaults for fields that weren't in older saved files.
          background: isHex(p.background) ? p.background : DEFAULT_SETTINGS.theme.background,
          warn:       isHex(p.warn)       ? p.warn       : DEFAULT_SETTINGS.theme.warn,
          miss:       isHex(p.miss)       ? p.miss       : DEFAULT_SETTINGS.theme.miss,
        }))
    }
  }
  if (raw?.viz) out.viz = sanitizeViz({ ...DEFAULT_VIZ, ...raw.viz })
  if (Array.isArray(raw?.gauges)) {
    out.gauges = raw.gauges
      .map(sanitizeGauge)
      .filter((g: GaugeDef | null): g is GaugeDef => g != null)
  }
  return out
}

function sanitizeViz(v: VizConfig): VizConfig {
  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : 0))
  return {
    bars:                 Math.max(8, Math.min(96, Math.round(v.bars))) || 32,
    minHz:                clamp(v.minHz, 10, 200),
    maxHz:                clamp(v.maxHz, 4000, 24000),
    attackSpeed:          clamp(v.attackSpeed, 0.05, 1),
    releaseSpeed:         clamp(v.releaseSpeed, 0.005, 1),
    peakHoldTime:         clamp(v.peakHoldTime, 0, 2000),
    peakFallSpeed:        clamp(v.peakFallSpeed, 0, 1),
    gamma:                clamp(v.gamma, 0.4, 3.5),
    noiseGate:            clamp(v.noiseGate, 0, 0.2),
    gain:                 clamp(v.gain, 0.2, 5),
    bassBoost:            clamp(v.bassBoost, 0.5, 3),
    highFrequencyDamping: clamp(v.highFrequencyDamping, 0.2, 1.5),
    smoothing:            clamp(v.smoothing, 0, 0.95),
    colorCurve:           clamp(v.colorCurve, 0.4, 3.5),
    glowStrength:         clamp(v.glowStrength, 0, 2),
    showFrequencyLabels:  !!v.showFrequencyLabels,
  }
}

function sanitizeGauge(g: any): GaugeDef | null {
  if (!g || typeof g.label !== 'string') return null
  const id = typeof g.id === 'string' && g.id ? g.id : `g_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const min = Number.isFinite(g.min) ? Number(g.min) : 0
  const max = Number.isFinite(g.max) ? Number(g.max) : 100
  return {
    id,
    label: String(g.label).slice(0, 24),
    min,
    max: max > min ? max : min + 1,
    unit: String(g.unit ?? '').slice(0, 8),
    canKey: String(g.canKey ?? '').slice(0, 32),
    warnAbove: Number.isFinite(g.warnAbove) ? Number(g.warnAbove) : undefined,
  }
}

function matchPreset(t: UserSettings['theme'], presets: ThemePreset[]): string | undefined {
  for (const p of presets) {
    if (p.primary.toLowerCase()    === t.primary.toLowerCase()
     && p.peak.toLowerCase()       === t.peak.toLowerCase()
     && p.background.toLowerCase() === t.background.toLowerCase()
     && p.warn.toLowerCase()       === t.warn.toLowerCase()
     && p.miss.toLowerCase()       === t.miss.toLowerCase()) return p.name
  }
  return undefined
}
