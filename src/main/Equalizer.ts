// 10-band parametric EQ that lives at the system level (PipeWire filter-chain)
// so it affects both Bluetooth A2DP and USB CarPlay audio output.
//
// State / persistence:
//   ~/.config/headunit/eq.json    — band gains + active preset + custom presets
//
// System integration:
//   ~/.config/pipewire/filter-chain.conf.d/headunit-eq.conf
//     — generated config that loads libpipewire-module-filter-chain with a
//       chain of biquad filters (lowshelf → 8× peaking → highshelf).  The
//       chain is exposed as a virtual sink ("headunit_eq").  We make it the
//       default sink so A2DP and USB CarPlay audio flow through it.
//
// Live updates (the important bit):
//   On gain change we DO NOT restart pipewire — that drops the A2DP link and
//   kills the music for a few seconds.  Instead we use `pw-cli set-param`
//   against the filter-chain node to update the named per-band controls
//   (e.g. "eq_band_3:Gain") in place.  pipewire reloads its filter only on
//   first install (when the config file didn't exist before).

import { ipcMain, BrowserWindow } from 'electron'
import { exec } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ─── Types ──────────────────────────────────────────────────────────────────

export type BiquadKind = 'lowshelf' | 'peaking' | 'highshelf'
export interface BandSpec { frequency: number; kind: BiquadKind }

// 15-band ISO-spaced graphic EQ.  First band is lowshelf, last is highshelf,
// everything in between is peaking.  Frequencies are the standard 2/3-octave
// graphic-EQ centres used in pro audio (25–16 000 Hz).
export const BANDS: BandSpec[] = [
  { frequency:    25, kind: 'lowshelf'  },
  { frequency:    40, kind: 'peaking'   },
  { frequency:    63, kind: 'peaking'   },
  { frequency:   100, kind: 'peaking'   },
  { frequency:   160, kind: 'peaking'   },
  { frequency:   250, kind: 'peaking'   },
  { frequency:   400, kind: 'peaking'   },
  { frequency:   630, kind: 'peaking'   },
  { frequency:  1000, kind: 'peaking'   },
  { frequency:  1600, kind: 'peaking'   },
  { frequency:  2500, kind: 'peaking'   },
  { frequency:  4000, kind: 'peaking'   },
  { frequency:  6300, kind: 'peaking'   },
  { frequency: 10000, kind: 'peaking'   },
  { frequency: 16000, kind: 'highshelf' },
]

export const BAND_COUNT = BANDS.length
export const GAIN_MIN = -12
export const GAIN_MAX =  12

const CHAIN_NODE_NAME = 'headunit_eq'    // node.name of the filter-chain sink

export interface EQPreset {
  name: string
  bands: number[]    // length === BAND_COUNT, values in [-12, +12], step 0.2
  builtin?: boolean
}

// 15-band preset values, ordered low → high frequency.
export const BUILTIN_PRESETS: EQPreset[] = [
  { name: 'Flat',         bands: [ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], builtin: true },
  { name: 'Bass Boosted', bands: [ 6, 5, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], builtin: true },
  { name: 'Rock',         bands: [ 3, 2, 2, 1, 0,-1,-1, 0, 0, 1, 2, 2, 3, 3, 2], builtin: true },
  { name: 'Electronic',   bands: [ 4, 4, 3, 2, 1, 0,-1,-2,-1, 0, 1, 2, 3, 3, 3], builtin: true },
  { name: 'Jazz',         bands: [ 2, 2, 1, 1, 0, 0, 1, 1, 0,-1,-1, 0, 1, 1, 2], builtin: true },
]

export interface EQState {
  bands: number[]
  activePreset: string
  customPresets: EQPreset[]
  enabled: boolean
}

const DEFAULT_STATE: EQState = {
  bands: new Array(BAND_COUNT).fill(0),
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
  private lastAppliedBands: number[] = [...DEFAULT_STATE.bands]
  /** PipeWire node-id of the filter-chain sink.  Cached to avoid re-running
   *  pw-dump on every band change.  Cleared (and re-discovered) if pw-cli
   *  reports a failure — the most common cause is pipewire having restarted. */
  private chainNodeId: number | null = null
  private discoverInFlight: Promise<number | null> | null = null

  constructor(getWindow: () => BrowserWindow | undefined) {
    this.getWindow = getWindow

    const home = os.homedir()
    this.stateFile        = path.join(home, '.config', 'headunit', 'eq.json')
    this.pipewireConfFile = path.join(home, '.config', 'pipewire', 'filter-chain.conf.d', 'headunit-eq.conf')

    this.load()
    this.lastAppliedBands = [...this.state.bands]
    this.registerIpc()
  }

  start() {
    if (process.platform !== 'linux') {
      this.push()
      return
    }
    // On a brand-new install the filter-chain config doesn't exist yet, so
    // pipewire isn't running our chain.  Detect that ONCE and trigger a
    // single reload — every later change is a live pw-cli set-param.
    const isFirstInstall = !fs.existsSync(this.pipewireConfFile)
    this.writePipewireConfig()

    if (isFirstInstall) {
      console.log('[eq] first install — reloading pipewire to load filter-chain (one-time)')
      this.reloadPipewire()
    } else {
      // Filter-chain should already be running.  Push current gains live so
      // any value we changed while the app was offline shows up immediately.
      setTimeout(() => this.applyLive(BANDS.map((_, i) => i)).catch(() => undefined), 500)
    }
    // Always re-assert `headunit_eq` as the default sink at startup — this
    // used to only happen on first install, so any Pi session that ended
    // up with a different default (USB DAC hot-plugged, wireplumber
    // policy chose something else) left the EQ chain dangling with the
    // phone linked directly to the hardware sink, bypassing the filter
    // graph entirely.  Also moves any existing sink-inputs onto the EQ
    // sink so already-connected phones start getting EQ'd without a
    // disconnect/reconnect.
    this.ensureDefaultSink()
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

  // ─── IPC ────────────────────────────────────────────────────────────────────

  private registerIpc() {
    ipcMain.on('eq:requestState', () => this.push())

    ipcMain.on('eq:setBands', (_e, bands: number[]) => {
      if (!Array.isArray(bands) || bands.length !== BAND_COUNT) return
      this.state.bands = bands.map(clampGain)
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
      if (BUILTIN_PRESETS.find(p => p.name.toLowerCase() === clean.toLowerCase())) return
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

  // ─── Apply / live update ────────────────────────────────────────────────────

  /** Schedule a live apply.  Short debounce coalesces bursts from press-and-hold
   *  / drag without keeping the user waiting. */
  private scheduleApply() {
    if (this.applyTimer) clearTimeout(this.applyTimer)
    this.applyTimer = setTimeout(() => {
      this.applyTimer = null
      this.applyToSystem().catch(err => console.warn('[eq] apply failed:', err))
    }, 60)
  }

  private async applyToSystem() {
    if (process.platform !== 'linux') return

    // Always rewrite the config so the next boot picks up the latest gains
    // (pipewire only re-reads it at start-up — we don't restart here).
    this.writePipewireConfig()

    // Find the bands whose values have changed and update each one live.
    const changed: number[] = []
    for (let i = 0; i < BAND_COUNT; i++) {
      if (Math.abs((this.state.bands[i] ?? 0) - (this.lastAppliedBands[i] ?? 0)) > 0.001) {
        changed.push(i)
      }
    }
    if (changed.length === 0) return

    await this.applyLive(changed)
    this.lastAppliedBands = [...this.state.bands]
  }

  /** Push the given band indices' current gain values to the running
   *  filter-chain node via `pw-cli set-param`.  No pipewire restart. */
  private async applyLive(bandIndices: number[]) {
    const id = await this.getChainNodeId()
    if (id == null) {
      console.warn('[eq] chain node not found — live update skipped (will write config and retry next reload)')
      return
    }
    // Build one Props payload that sets every changed band's Gain at once —
    // the chain exposes per-band controls as "<node.name>:<control>".
    const pairs = bandIndices
      .map(i => `"eq_band_${i}:Gain" ${(this.state.bands[i] ?? 0).toFixed(2)}`)
      .join(' ')
    const cmd = `pw-cli set-param ${id} Props '{ params = [ ${pairs} ] }'`
    await new Promise<void>((resolve) => {
      exec(cmd, (err, _out, stderr) => {
        if (err) {
          console.warn('[eq] pw-cli set-param failed:', err.message, stderr?.trim())
          // pipewire may have been restarted by the system — invalidate the
          // cached node id so the next change re-discovers.
          this.chainNodeId = null
        }
        resolve()
      })
    })
  }

  private getChainNodeId(): Promise<number | null> {
    if (this.chainNodeId != null) return Promise.resolve(this.chainNodeId)
    if (this.discoverInFlight) return this.discoverInFlight
    this.discoverInFlight = new Promise<number | null>((resolve) => {
      exec('pw-dump', { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        this.discoverInFlight = null
        if (err) {
          console.warn('[eq] pw-dump failed:', err.message)
          resolve(null); return
        }
        try {
          const dump = JSON.parse(stdout)
          for (const o of dump) {
            const name = o?.info?.props?.['node.name']
            if (name === CHAIN_NODE_NAME) {
              this.chainNodeId = Number(o.id)
              console.log('[eq] filter-chain node id =', this.chainNodeId)
              resolve(this.chainNodeId); return
            }
          }
        } catch (e) {
          console.warn('[eq] pw-dump parse failed:', (e as Error).message)
        }
        resolve(null)
      })
    })
    return this.discoverInFlight
  }

  private writePipewireConfig() {
    if (!this.state.enabled) {
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
# 10-band parametric EQ exposed as a virtual sink (headunit_eq).
# Make this the default sink so A2DP / CarPlay audio is EQ'd.
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
      node.name        = "${CHAIN_NODE_NAME}"
      node.description = "Head Unit Equalizer"
      media.class      = Audio/Sink
      audio.channels   = 2
      audio.position   = [ FL FR ]
    }
    playback.props = {
      node.name      = "${CHAIN_NODE_NAME}_out"
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
    } catch (err) {
      console.warn('[eq] failed to write pipewire config:', (err as Error).message)
    }
  }

  /** Force `headunit_eq` to be the pactl default sink and move every
   *  currently-connected sink-input onto it.  Waits a moment so pipewire
   *  has time to expose the filter-chain node before we address it.  Any
   *  step that fails is logged but not fatal — the user can still fix it
   *  by hand with `pactl set-default-sink headunit_eq`. */
  private ensureDefaultSink(): void {
    if (process.platform !== 'linux') return
    setTimeout(() => {
      // Only re-assert if headunit_eq actually exists — otherwise we'd
      // clobber a working setup while the filter-chain is still coming
      // up on first install.
      exec(`pactl list short sinks`, (err, stdout) => {
        if (err) { console.warn('[eq] pactl list sinks failed:', err.message); return }
        const hasChain = stdout.split('\n').some(l => l.includes(CHAIN_NODE_NAME))
        if (!hasChain) {
          console.warn(`[eq] ${CHAIN_NODE_NAME} not present yet — skipping default-sink assertion`)
          return
        }
        exec(`pactl set-default-sink ${CHAIN_NODE_NAME}`, (e1) => {
          if (e1) { console.warn('[eq] set-default-sink failed:', e1.message); return }
          console.log(`[eq] default sink → ${CHAIN_NODE_NAME}`)
          // Move any active streams (esp. bluez A2DP) onto the chain so
          // the user hears EQ'd audio without disconnecting the phone.
          exec('pactl list short sink-inputs', (e2, out2) => {
            if (e2) return
            for (const line of out2.split('\n')) {
              const id = line.split(/\s+/)[0]
              if (!id) continue
              exec(`pactl move-sink-input ${id} ${CHAIN_NODE_NAME}`, () => undefined)
            }
          })
        })
      })
    }, 300)
  }

  /** One-time pipewire restart used ONLY on first install (filter-chain
   *  config didn't exist before).  After this, every gain change goes
   *  through pw-cli live updates and there are no more audio gaps. */
  private reloadPipewire() {
    exec('systemctl --user restart pipewire pipewire-pulse wireplumber', (err) => {
      if (err) {
        console.warn('[eq] pipewire restart failed:', err.message)
        return
      }
      console.log('[eq] pipewire reloaded — filter-chain should be live')
      setTimeout(() => {
        exec(`pactl set-default-sink ${CHAIN_NODE_NAME}`, (e) => {
          if (e) console.warn('[eq] set-default-sink failed:', e.message)
        })
        // Re-discover the new chain node id.
        this.chainNodeId = null
        this.getChainNodeId().catch(() => undefined)
      }, 800)
    })
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clampGain(v: any): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
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
