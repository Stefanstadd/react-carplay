// 10-band parametric EQ that lives at the system level (PipeWire filter-chain)
// so it affects both Bluetooth A2DP and USB CarPlay audio output.
//
// State / persistence:
//   ~/.config/headunit/eq.json   — band gains + active preset + custom presets
//
// System integration:
//   ~/.config/pipewire/filter-chain.conf.d/headunit-eq.conf
//     — generated config that loads libpipewire-module-filter-chain with a
//       chain of biquad filters (lowshelf → 8× peaking → highshelf).  The
//       chain is exposed as a virtual sink ("headunit_eq"); when active, it's
//       made the default sink so every new audio stream gets EQ'd.
//
//   On every gain change we re-write the config and (debounced) restart
//   pipewire so the new gains take effect.  The restart causes a ~1.5 s gap
//   in audio so changes are coalesced 700 ms after the last user input.

import { ipcMain, BrowserWindow } from 'electron'
import { exec } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ─── Types pushed to the renderer ────────────────────────────────────────────

export type BiquadKind = 'lowshelf' | 'peaking' | 'highshelf'

export interface BandSpec { frequency: number; kind: BiquadKind }

export const BANDS: BandSpec[] = [
  { frequency: 60,    kind: 'lowshelf'  },
  { frequency: 170,   kind: 'peaking'   },
  { frequency: 310,   kind: 'peaking'   },
  { frequency: 600,   kind: 'peaking'   },
  { frequency: 1000,  kind: 'peaking'   },
  { frequency: 3000,  kind: 'peaking'   },
  { frequency: 6000,  kind: 'peaking'   },
  { frequency: 12000, kind: 'peaking'   },
  { frequency: 14000, kind: 'peaking'   },
  { frequency: 16000, kind: 'highshelf' },
]

export const BAND_COUNT = BANDS.length
export const GAIN_MIN = -6
export const GAIN_MAX = 6

export interface EQPreset {
  name: string
  bands: number[]    // length === BAND_COUNT, values in [-6, +6], step 0.2
  builtin?: boolean
}

export const BUILTIN_PRESETS: EQPreset[] = [
  { name: 'Flat',         bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],         builtin: true },
  { name: 'Bass Boosted', bands: [4, 3, 2, 0, 0, 0, 0, 0, 0, 0],         builtin: true },
  { name: 'Rock',         bands: [2, 1, 0, -1, -1, 0, 1, 2, 2, 1],       builtin: true },
  { name: 'Electronic',   bands: [3, 2, 0, -2, -1, 0, 1, 2, 3, 3],       builtin: true },
  { name: 'Jazz',         bands: [2, 1, 0, 1, -1, -1, 0, 1, 1, 2],       builtin: true },
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

// ─── Manager ─────────────────────────────────────────────────────────────────

export class Equalizer {
  private getWindow: () => BrowserWindow | undefined
  private state: EQState = { ...DEFAULT_STATE }

  private stateFile: string
  private pipewireConfFile: string

  private applyTimer: NodeJS.Timeout | null = null

  constructor(getWindow: () => BrowserWindow | undefined) {
    this.getWindow = getWindow

    const home = os.homedir()
    this.stateFile        = path.join(home, '.config', 'headunit', 'eq.json')
    this.pipewireConfFile = path.join(home, '.config', 'pipewire', 'filter-chain.conf.d', 'headunit-eq.conf')

    this.load()
    this.registerIpc()
  }

  start() {
    // Write the filter-chain config on boot so the EQ persists across system
    // restarts.  No pipewire reload here — pipewire already loaded the config
    // when it started.  If the values changed since last write, the next
    // setBands/setActivePreset triggers a reload.
    if (process.platform === 'linux') {
      this.writePipewireConfig()
    }
    this.push()
  }

  // ─── State I/O ─────────────────────────────────────────────────────────────

  private load() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'))
        this.state = sanitize({ ...DEFAULT_STATE, ...raw })
        console.log('[eq] loaded state — preset:', this.state.activePreset)
      }
    } catch (err) {
      console.warn('[eq] failed to load state:', (err as Error).message)
    }
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2))
    } catch (err) {
      console.warn('[eq] failed to save state:', (err as Error).message)
    }
  }

  // ─── IPC wiring ────────────────────────────────────────────────────────────

  private registerIpc() {
    ipcMain.on('eq:requestState', () => this.push())

    ipcMain.on('eq:setBands', (_e, bands: number[]) => {
      if (!Array.isArray(bands) || bands.length !== BAND_COUNT) return
      this.state.bands = bands.map(clampGain)
      // Once the user starts twisting bands manually, we're no longer on a
      // named preset — null it so the UI shows "Custom".  Save preset later
      // brings back a named entry.
      this.state.activePreset = matchPreset(this.state.bands, this.allPresets()) ?? '—'
      this.save()
      this.push()
      this.scheduleApply()
    })

    ipcMain.on('eq:setActivePreset', (_e, name: string) => {
      const p = this.allPresets().find(x => x.name === name)
      if (!p) return
      this.state.activePreset = name
      this.state.bands = p.bands.map(clampGain)
      this.save()
      this.push()
      this.scheduleApply()
    })

    ipcMain.on('eq:savePreset', (_e, name: string) => {
      const clean = String(name || '').trim().slice(0, 24)
      if (!clean) return
      if (BUILTIN_PRESETS.find(p => p.name.toLowerCase() === clean.toLowerCase())) return  // can't shadow a builtin
      const without = this.state.customPresets.filter(p => p.name.toLowerCase() !== clean.toLowerCase())
      without.push({ name: clean, bands: [...this.state.bands] })
      this.state.customPresets = without
      this.state.activePreset = clean
      this.save()
      this.push()
    })

    ipcMain.on('eq:deletePreset', (_e, name: string) => {
      this.state.customPresets = this.state.customPresets.filter(p => p.name !== name)
      if (this.state.activePreset === name) {
        this.state.activePreset = 'Flat'
        this.state.bands = [...BUILTIN_PRESETS[0].bands]
        this.scheduleApply()
      }
      this.save()
      this.push()
    })

    ipcMain.on('eq:setEnabled', (_e, enabled: boolean) => {
      this.state.enabled = !!enabled
      this.save()
      this.push()
      this.scheduleApply()
    })
  }

  private push() {
    const w = this.getWindow()
    if (!w?.webContents) return
    try { w.webContents.send('eq:state', this.state) } catch { /* */ }
  }

  private allPresets(): EQPreset[] {
    return [...BUILTIN_PRESETS, ...this.state.customPresets]
  }

  // ─── System apply ──────────────────────────────────────────────────────────

  private scheduleApply() {
    if (this.applyTimer) clearTimeout(this.applyTimer)
    // 700 ms after the last change — gives the user a moment to keep tweaking
    // without forcing a pipewire restart for every ▲/▼ tap.
    this.applyTimer = setTimeout(() => {
      this.applyTimer = null
      this.applyToSystem()
    }, 700)
  }

  private applyToSystem() {
    if (process.platform !== 'linux') {
      console.log('[eq] non-linux: skipping system apply')
      return
    }
    this.writePipewireConfig()
    this.reloadPipewire()
  }

  private writePipewireConfig() {
    if (!this.state.enabled) {
      // Just remove the config so pipewire doesn't load any filter-chain at boot.
      try { if (fs.existsSync(this.pipewireConfFile)) fs.unlinkSync(this.pipewireConfFile) } catch { /* */ }
      return
    }

    const nodeLines: string[] = []
    for (let i = 0; i < BAND_COUNT; i++) {
      const b = BANDS[i]
      const gain = (this.state.bands[i] ?? 0).toFixed(2)
      const label = b.kind === 'lowshelf' ? 'bq_lowshelf'
                  : b.kind === 'highshelf' ? 'bq_highshelf'
                  : 'bq_peaking'
      nodeLines.push(
        `        { type = builtin label = ${label} name = "eq_band_${i}" ` +
        `control = { "Freq" = ${b.frequency} "Q" = 1.0 "Gain" = ${gain} } }`
      )
    }
    const linkLines: string[] = []
    for (let i = 0; i < BAND_COUNT - 1; i++) {
      linkLines.push(`        { output = "eq_band_${i}:Out" input = "eq_band_${i+1}:In" }`)
    }

    const conf = `# Generated by Head Unit — do not edit by hand.
# 10-band parametric EQ as a virtual sink.  Make this the default sink
# (pactl set-default-sink headunit_eq) so A2DP / CarPlay USB audio is EQ'd
# on its way to the real output.
context.modules = [
{ name = libpipewire-module-filter-chain
  args = {
    node.description = "Head Unit EQ"
    media.name       = "Head Unit EQ"
    filter.graph = {
      nodes = [
${nodeLines.join('\n')}
      ]
      links = [
${linkLines.join('\n')}
      ]
    }
    capture.props = {
      node.name        = "headunit_eq"
      node.description = "Head Unit Equalizer"
      media.class      = Audio/Sink
      audio.channels   = 2
      audio.position   = [ FL FR ]
    }
    playback.props = {
      node.name      = "headunit_eq_out"
      node.passive   = true
      audio.channels = 2
      audio.position = [ FL FR ]
    }
  }
}
]
`

    try {
      fs.mkdirSync(path.dirname(this.pipewireConfFile), { recursive: true })
      fs.writeFileSync(this.pipewireConfFile, conf)
      console.log('[eq] wrote pipewire config →', this.pipewireConfFile)
    } catch (err) {
      console.warn('[eq] failed to write pipewire config:', (err as Error).message)
    }
  }

  private reloadPipewire() {
    // Restart user-level pipewire so the new filter-chain config is read.
    // Brief (~1.5 s) audio gap but doesn't require sudo.
    exec('systemctl --user restart pipewire pipewire-pulse wireplumber', (err) => {
      if (err) {
        console.warn('[eq] pipewire restart failed:', err.message)
        return
      }
      console.log('[eq] pipewire reloaded')
      // After the restart, make our EQ sink the default so new audio flows through it.
      setTimeout(() => {
        exec('pactl set-default-sink headunit_eq', (e) => {
          if (e) console.warn('[eq] set-default-sink failed:', e.message)
        })
      }, 800)
    })
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clampGain(v: any): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  // Snap to 0.2 dB grid to match the UI step size.
  const snapped = Math.round(n * 5) / 5
  return Math.max(GAIN_MIN, Math.min(GAIN_MAX, snapped))
}

function sanitize(s: EQState): EQState {
  const bands = Array.isArray(s.bands) && s.bands.length === BAND_COUNT
    ? s.bands.map(clampGain)
    : [...DEFAULT_STATE.bands]
  const customPresets = (Array.isArray(s.customPresets) ? s.customPresets : [])
    .filter(p => p && typeof p.name === 'string' && Array.isArray(p.bands) && p.bands.length === BAND_COUNT)
    .map(p => ({ name: p.name.slice(0, 24), bands: p.bands.map(clampGain) }))
  return {
    bands,
    activePreset: typeof s.activePreset === 'string' ? s.activePreset : DEFAULT_STATE.activePreset,
    customPresets,
    enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULT_STATE.enabled,
  }
}

/** Returns the name of the preset whose band values exactly match `bands`,
 *  or undefined if no preset matches. */
function matchPreset(bands: number[], presets: EQPreset[]): string | undefined {
  for (const p of presets) {
    let ok = true
    for (let i = 0; i < BAND_COUNT; i++) {
      if (Math.abs((p.bands[i] ?? 0) - (bands[i] ?? 0)) > 0.001) { ok = false; break }
    }
    if (ok) return p.name
  }
  return undefined
}
