// BluetoothManager — runs in the main process and bridges BlueZ / ofono / obex
// over D-Bus to the renderer.  Linux only at runtime; on other platforms it
// runs in stub mode (just emits a disconnected state) so dev on Windows/macOS
// works.  See BLUETOOTH.md for Raspberry Pi setup.
//
// Why this design: every Bluetooth datum the UI cares about (phone connected,
// battery, music metadata, transport state, call state, contacts) lives in
// a small set of well-known BlueZ / ofono / obex D-Bus interfaces.  We use
// ObjectManager + PropertiesChanged to receive push updates, and methods to
// drive things from the user (Connect, Dial, MediaPlayer1.Play, etc.).

import { ipcMain, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ─── Types pushed to renderer ────────────────────────────────────────────────

export interface BtDevice {
  address: string
  name: string
  paired: boolean
  connected: boolean
  trusted: boolean
  batteryPct?: number
  isPhone?: boolean
}

export interface PhoneState {
  connected: boolean
  address?: string
  name?: string
  batteryPct?: number
  charging?: boolean
}

export interface MediaState {
  hasMetadata: boolean
  title?: string
  artist?: string
  album?: string
  artworkSrc?: string
  durationSec: number
  positionSec: number
  playing: boolean
  playerName?: string
}

export type CallStatus = 'idle' | 'incoming' | 'dialing' | 'active' | 'held'

export interface CallContact { name?: string; number: string; photo?: string }

export interface CallState {
  status: CallStatus
  contact?: CallContact
  durationSec: number
  muted: boolean
}

export interface Contact {
  id: string
  name: string
  numbers: { type?: string; number: string }[]
  photo?: string
}

export interface ContactsState {
  synced: boolean
  syncing: boolean
  contacts: Contact[]
  lastError?: string
}

export interface RecentCall {
  name?: string
  number: string
  time: number              // epoch ms
  dir: 'in' | 'out' | 'miss'
}

export interface RecentCallsState {
  synced: boolean
  syncing: boolean
  calls: RecentCall[]
  lastError?: string
}

// ─── D-Bus constants ─────────────────────────────────────────────────────────

const BLUEZ_BUS         = 'org.bluez'
const BLUEZ_ROOT        = '/'
const IFACE_OBJMGR      = 'org.freedesktop.DBus.ObjectManager'
const IFACE_PROPS       = 'org.freedesktop.DBus.Properties'
const IFACE_ADAPTER     = 'org.bluez.Adapter1'
const IFACE_DEVICE      = 'org.bluez.Device1'
const IFACE_BATTERY     = 'org.bluez.Battery1'
const IFACE_PLAYER      = 'org.bluez.MediaPlayer1'

const OFONO_BUS         = 'org.ofono'
const IFACE_OFONO_MGR   = 'org.ofono.Manager'
const IFACE_VCM         = 'org.ofono.VoiceCallManager'
const IFACE_VOICECALL   = 'org.ofono.VoiceCall'
const IFACE_CALLVOL     = 'org.ofono.CallVolume'

const OBEX_BUS          = 'org.bluez.obex'
const IFACE_OBEX_MGR    = 'org.bluez.obex.Client1'
const IFACE_PBAP        = 'org.bluez.obex.PhonebookAccess1'

// ─── Manager ─────────────────────────────────────────────────────────────────

export class BluetoothManager {
  private getWindow: () => BrowserWindow | undefined

  private dbus: any = null
  private systemBus: any = null
  private sessionBus: any = null

  // Tracked state, keyed by D-Bus object path
  private devicePaths = new Map<string, BtDevice>()
  private activePhonePath: string | null = null
  private activePlayerPath: string | null = null

  // ofono
  private activeModemPath: string | null = null
  private activeCallPath: string | null = null

  // outbound state
  private media: MediaState = { hasMetadata: false, durationSec: 0, positionSec: 0, playing: false }
  private call:  CallState  = { status: 'idle', durationSec: 0, muted: false }
  private contacts: ContactsState = { synced: false, syncing: false, contacts: [] }
  private recents: RecentCallsState = { synced: false, syncing: false, calls: [] }

  // PBAP serialization — iPhone only allows one OBEX session at a time.
  // syncContacts + syncRecentCalls chain off the same promise so they
  // never collide.  500 ms gap after each so the phone releases the old
  // session before we open a new one.
  private pbapChain: Promise<unknown> = Promise.resolve()

  // periodic media-position refresh from the player
  private positionTimer: NodeJS.Timeout | null = null

  constructor(getWindow: () => BrowserWindow | undefined) {
    this.getWindow = getWindow
  }

  /** Run a PBAP/obex operation after any in-flight one finishes. */
  private chainPbap<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.pbapChain
      .catch(() => undefined)
      .then(() => fn())
      .then(async (v) => {
        await new Promise((r) => setTimeout(r, 500))
        return v
      })
    this.pbapChain = next.catch(() => undefined)
    return next
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async start() {
    this.registerIpc()

    if (process.platform !== 'linux') {
      console.log('[bt] non-linux platform — running in stub mode (no real Bluetooth)')
      this.pushAll()
      return
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('dbus-next')
      this.dbus = (mod as any).default ?? mod
    } catch (err: any) {
      if (err?.code === 'MODULE_NOT_FOUND') {
        console.error('[bt] dbus-next not found in the bundle — rebuild the AppImage after running npm install')
      } else {
        console.error('[bt] dbus-next failed to load:', err?.code, err?.message)
      }
      this.pushAll()
      return
    }

    try {
      this.systemBus = this.dbus.systemBus()
    } catch (err) {
      console.warn('[bt] cannot connect to system D-Bus — Bluetooth disabled', err)
      this.pushAll()
      return
    }
    try {
      this.sessionBus = this.dbus.sessionBus()
    } catch (err) {
      console.warn('[bt] cannot connect to session D-Bus (obex / PBAP will not work)', err)
    }

    await this.initBlueZ()
    await this.initOFono()

    // Start a slow timer to refresh player Position (BlueZ does not push every tick)
    this.positionTimer = setInterval(() => this.refreshPlayerPosition().catch(() => undefined), 1000)

    this.pushAll()
  }

  stop() {
    if (this.positionTimer) clearInterval(this.positionTimer)
    this.positionTimer = null
    try { this.systemBus?.disconnect?.() } catch { /* */ }
    try { this.sessionBus?.disconnect?.() } catch { /* */ }
  }

  // ─── IPC wiring (renderer → main) ──────────────────────────────────────────

  private registerIpc() {
    ipcMain.on('bt:requestState', () => this.pushAll())
    ipcMain.on('bt:mediaCmd', (_e, cmd: string) => this.mediaCmd(cmd))
    ipcMain.on('bt:dial',     (_e, num: string) => this.dial(num))
    ipcMain.on('bt:answer',   ()                => this.answer())
    ipcMain.on('bt:reject',   ()                => this.reject())
    ipcMain.on('bt:hangup',   ()                => this.hangup())
    ipcMain.on('bt:mute',     (_e, on: boolean) => this.setMuted(on))
    ipcMain.on('bt:syncContacts', () => this.syncContacts())
    ipcMain.on('bt:syncRecents',  () => this.syncRecentCalls())
    ipcMain.on('bt:scan',     (_e, on: boolean) => this.scan(on))
    ipcMain.on('bt:connect',    (_e, a: string) => this.connectDevice(a))
    ipcMain.on('bt:disconnect', (_e, a: string) => this.disconnectDevice(a))
    ipcMain.on('bt:forget',     (_e, a: string) => this.forgetDevice(a))
  }

  // ─── State push ────────────────────────────────────────────────────────────

  private pushAll() {
    const w = this.getWindow()
    if (!w?.webContents) return
    try {
      w.webContents.send('bt:phone',    this.phoneState())
      w.webContents.send('bt:media',    this.media)
      w.webContents.send('bt:call',     this.call)
      w.webContents.send('bt:contacts', this.contacts)
      w.webContents.send('bt:recents',  this.recents)
      w.webContents.send('bt:devices',  this.deviceList())
    } catch (err) {
      // window may be closing — ignore
    }
  }

  private pushPhone()    { this.getWindow()?.webContents?.send('bt:phone',    this.phoneState()) }
  private pushMedia()    { this.getWindow()?.webContents?.send('bt:media',    this.media) }
  private pushCall()     { this.getWindow()?.webContents?.send('bt:call',     this.call) }
  private pushContacts() { this.getWindow()?.webContents?.send('bt:contacts', this.contacts) }
  private pushRecents()  { this.getWindow()?.webContents?.send('bt:recents',  this.recents) }
  private pushDevices()  { this.getWindow()?.webContents?.send('bt:devices',  this.deviceList()) }

  private phoneState(): PhoneState {
    if (!this.activePhonePath) return { connected: false }
    const d = this.devicePaths.get(this.activePhonePath)
    if (!d) return { connected: false }
    // Note: BlueZ Battery1 doesn't expose charging state for iOS — the
    // charging field stays undefined unless a future BlueZ version surfaces it.
    return { connected: d.connected, address: d.address, name: d.name, batteryPct: d.batteryPct }
  }

  private deviceList(): BtDevice[] {
    return Array.from(this.devicePaths.values())
      .filter((d) => {
        // Always show paired or connected devices.
        if (d.paired || d.connected) return true
        // Otherwise filter discovery noise: drop devices we only know by
        // MAC address (no name), or anonymous BLE advertisers that BlueZ
        // picks up during scan but the user can't meaningfully pair.
        if (!d.name || d.name === d.address) return false
        return true
      })
      .sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name))
  }

  // ─── BlueZ init ────────────────────────────────────────────────────────────

  private async initBlueZ() {
    try {
      const obj = await this.systemBus.getProxyObject(BLUEZ_BUS, BLUEZ_ROOT)
      const om  = obj.getInterface(IFACE_OBJMGR)

      const managed = await om.GetManagedObjects()
      for (const [path, interfaces] of Object.entries(managed)) {
        this.onObjectAdded(path, interfaces as any)
      }

      om.on('InterfacesAdded',   (path: string, ifaces: any) => this.onObjectAdded(path, ifaces))
      om.on('InterfacesRemoved', (path: string, ifaces: string[]) => this.onObjectRemoved(path, ifaces))

      console.log('[bt] BlueZ initialised — tracking', this.devicePaths.size, 'devices')
    } catch (err) {
      console.warn('[bt] BlueZ init failed — bluetoothd running?', err)
    }
  }

  private async onObjectAdded(path: string, interfaces: any) {
    if (interfaces[IFACE_DEVICE]) {
      const props = unwrapVariants(interfaces[IFACE_DEVICE])
      const dev: BtDevice = {
        address:   String(props.Address ?? ''),
        name:      String(props.Name ?? props.Alias ?? props.Address ?? 'Device'),
        paired:    !!props.Paired,
        connected: !!props.Connected,
        trusted:   !!props.Trusted,
        isPhone:   isPhone(props),
      }
      if (interfaces[IFACE_BATTERY]) {
        const b = unwrapVariants(interfaces[IFACE_BATTERY])
        if (typeof b.Percentage === 'number') dev.batteryPct = b.Percentage
      }
      this.devicePaths.set(path, dev)
      await this.subscribeDeviceProps(path)
      await this.subscribeBatteryProps(path)
      this.maybePromoteToActivePhone(path)
      this.pushDevices(); this.pushPhone()
    }
    if (interfaces[IFACE_PLAYER]) {
      const props = unwrapVariants(interfaces[IFACE_PLAYER])
      this.activePlayerPath = path
      this.applyPlayerProps(props)
      await this.subscribePlayerProps(path)
      this.pushMedia()
    }
    if (interfaces[IFACE_BATTERY] && !interfaces[IFACE_DEVICE] && this.devicePaths.has(path)) {
      const b = unwrapVariants(interfaces[IFACE_BATTERY])
      const d = this.devicePaths.get(path)!
      if (typeof b.Percentage === 'number') d.batteryPct = b.Percentage
      // Battery1 appeared AFTER Device1 (typical for HFP-derived battery) —
      // subscribe now or we'll never get updates.
      await this.subscribeBatteryProps(path)
      this.pushDevices(); if (path === this.activePhonePath) this.pushPhone()
    }
  }

  private onObjectRemoved(path: string, ifaces: string[]) {
    if (ifaces.includes(IFACE_DEVICE)) {
      this.devicePaths.delete(path)
      if (path === this.activePhonePath) {
        this.activePhonePath = null
        this.activePlayerPath = null
        this.media = { hasMetadata: false, durationSec: 0, positionSec: 0, playing: false }
        this.contacts = { synced: false, syncing: false, contacts: [] }
        this.recents = { synced: false, syncing: false, calls: [] }
        this.pushPhone()
        this.pushMedia()
        this.pushContacts()
        this.pushRecents()
      }
      this.pushDevices()
    }
    if (ifaces.includes(IFACE_PLAYER) && this.activePlayerPath === path) {
      this.activePlayerPath = null
      this.media = { hasMetadata: false, durationSec: 0, positionSec: 0, playing: false }
      this.pushMedia()
    }
  }

  private async subscribeDeviceProps(path: string) {
    try {
      const obj = await this.systemBus.getProxyObject(BLUEZ_BUS, path)
      const p   = obj.getInterface(IFACE_PROPS)
      p.on('PropertiesChanged', (iface: string, changed: any) => {
        if (iface !== IFACE_DEVICE) return
        const d = this.devicePaths.get(path); if (!d) return
        const c = unwrapVariants(changed)
        const wasActive = this.activePhonePath === path
        const wasConnected = d.connected
        if ('Name'      in c) d.name      = String(c.Name)
        if ('Alias'     in c) d.name      = d.name || String(c.Alias)
        if ('Connected' in c) d.connected = !!c.Connected
        if ('Paired'    in c) d.paired    = !!c.Paired
        if ('Trusted'   in c) d.trusted   = !!c.Trusted
        // On a fresh reconnect, BlueZ doesn't always re-emit
        // InterfacesAdded for sub-objects (MediaPlayer1, Battery1) that
        // existed before the disconnect — only the device's Connected
        // flag flips.  Re-walk GetManagedObjects under this device to
        // re-discover those interfaces so music + battery come back.
        // Also reset contacts/recents so auto-sync re-fires.
        if (!wasConnected && d.connected) {
          console.log('[bt] reconnect detected for', d.name, '— refreshing')
          this.contacts = { synced: false, syncing: false, contacts: [] }
          this.recents  = { synced: false, syncing: false, calls: [] }
          this.pushContacts()
          this.pushRecents()
          this.refreshInterfacesUnder(path).catch((err) =>
            console.warn('[bt] refresh after reconnect failed', err)
          )
        }
        this.maybePromoteToActivePhone(path)
        this.pushDevices()
        // Push phone state when ANYTHING about the active phone changes —
        // including when it has JUST been demoted (Connected=false), so
        // the renderer hears about the disconnect.  Without this the
        // "was active" path was missed and the header stayed connected.
        if (wasActive || path === this.activePhonePath) {
          if (wasActive && this.activePhonePath !== path) {
            // The previously-active phone is gone — also clear the media
            // metadata and contacts that were tied to it.
            this.media = { hasMetadata: false, durationSec: 0, positionSec: 0, playing: false }
            this.contacts = { synced: false, syncing: false, contacts: [] }
            this.recents = { synced: false, syncing: false, calls: [] }
            this.activePlayerPath = null
            this.pushMedia()
            this.pushContacts()
            this.pushRecents()
          }
          this.pushPhone()
        }
      })
    } catch (err) { /* device gone */ }
  }

  private async subscribeBatteryProps(path: string) {
    try {
      const obj = await this.systemBus.getProxyObject(BLUEZ_BUS, path)
      try { obj.getInterface(IFACE_BATTERY) } catch { return } // no battery1 on this object
      // One-time initial read in case the value was set before our subscribe.
      try {
        const p0 = obj.getInterface(IFACE_PROPS)
        const v = await p0.Get(IFACE_BATTERY, 'Percentage')
        const pct = Number(unwrapVariant(v))
        const d0 = this.devicePaths.get(path)
        if (d0 && !isNaN(pct)) {
          d0.batteryPct = pct
          console.log('[bt] battery initial read', d0.name, pct, '%')
          this.pushDevices()
          if (path === this.activePhonePath) this.pushPhone()
        }
      } catch { /* property not yet available */ }
      const p = obj.getInterface(IFACE_PROPS)
      p.on('PropertiesChanged', (iface: string, changed: any) => {
        if (iface !== IFACE_BATTERY) return
        const d = this.devicePaths.get(path); if (!d) return
        const c = unwrapVariants(changed)
        if ('Percentage' in c) {
          d.batteryPct = Number(c.Percentage)
          console.log('[bt] battery updated', d.name, d.batteryPct, '%')
        }
        this.pushDevices()
        if (path === this.activePhonePath) this.pushPhone()
      })
    } catch { /* */ }
  }

  private async subscribePlayerProps(path: string) {
    try {
      const obj = await this.systemBus.getProxyObject(BLUEZ_BUS, path)
      const p   = obj.getInterface(IFACE_PROPS)
      p.on('PropertiesChanged', (iface: string, changed: any) => {
        if (iface !== IFACE_PLAYER) return
        const c = unwrapVariants(changed)
        this.applyPlayerProps(c)
        this.pushMedia()
      })
    } catch { /* */ }
  }

  private applyPlayerProps(props: Record<string, any>) {
    if ('Status' in props) this.media.playing = String(props.Status) === 'playing'
    if ('Name'   in props) this.media.playerName = String(props.Name)
    if ('Position' in props) this.media.positionSec = Math.floor(Number(props.Position) / 1000)
    if ('Track' in props) {
      const t = unwrapVariants(props.Track)
      const newTitle  = t.Title  !== undefined ? String(t.Title)  : this.media.title
      const newArtist = t.Artist !== undefined ? String(t.Artist) : this.media.artist
      const trackChanged = newTitle !== this.media.title || newArtist !== this.media.artist
      this.media.title  = newTitle
      this.media.artist = newArtist
      this.media.album  = t.Album !== undefined ? String(t.Album) : this.media.album
      const dur = t.Duration !== undefined ? Math.floor(Number(t.Duration) / 1000) : 0
      if (dur > 0) this.media.durationSec = dur
      // When the track changes (next/previous), position resets to 0 — most
      // phones don't push Position alongside Track, so do it here.
      if (trackChanged && !('Position' in props)) this.media.positionSec = 0
      this.media.hasMetadata = !!(this.media.title || this.media.artist || this.media.album)

      // AVRCP cover art — BlueZ 5.64+ stores it as a temp file when the
      // phone sends art over AVRCP 1.6.  Clear old art on every track
      // change so the renderer doesn't show stale artwork for new tracks.
      this.media.artworkSrc = undefined
      const coverUri = t.CoverArt ?? t.Image
      if (coverUri) {
        const filePath = String(coverUri).replace(/^file:\/\//, '')
        try {
          const buf = fs.readFileSync(filePath)
          const mime = filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
          this.media.artworkSrc = `data:${mime};base64,${buf.toString('base64')}`
          console.log('[bt] cover art loaded from AVRCP:', filePath, `(${buf.length} bytes)`)
        } catch {
          // File already cleaned up by BlueZ — renderer will fall back to online lookup
        }
      }
    }
  }

  private async refreshPlayerPosition() {
    if (!this.activePlayerPath || !this.systemBus) return
    try {
      const obj = await this.systemBus.getProxyObject(BLUEZ_BUS, this.activePlayerPath)
      const p   = obj.getInterface(IFACE_PROPS)
      const v   = await p.Get(IFACE_PLAYER, 'Position')
      const pos = Math.floor(Number(unwrapVariant(v)) / 1000)
      if (pos !== this.media.positionSec) {
        this.media.positionSec = pos
        this.pushMedia()
      }
    } catch { /* player gone or no Position prop */ }
  }

  /**
   * Pick the most-recently-connected phone-like device as "the phone".
   * Updates this.activePhonePath and pushes if it changed.
   */
  private maybePromoteToActivePhone(path: string) {
    const d = this.devicePaths.get(path); if (!d) return
    if (!d.connected) {
      if (this.activePhonePath === path) {
        // pick another connected phone if any
        const alt = Array.from(this.devicePaths.entries()).find(([_, dv]) => dv.connected && dv.isPhone)
        this.activePhonePath = alt ? alt[0] : null
      }
      return
    }
    if (!d.isPhone) return
    if (this.activePhonePath === path) return
    this.activePhonePath = path
    console.log('[bt] active phone:', d.name, d.address)
    // Auto-sync contacts + recent calls so they appear without manual taps.
    // Small delay so PBAP/obex has time to wake up after pairing.
    setTimeout(() => {
      if (this.activePhonePath !== path) return
      if (!this.contacts.synced && !this.contacts.syncing) {
        console.log('[bt] auto-syncing contacts for', d.name)
        this.syncContacts().catch((err) => console.warn('[bt] auto-sync contacts failed', err))
      }
      if (!this.recents.synced && !this.recents.syncing) {
        console.log('[bt] auto-syncing recent calls for', d.name)
        this.syncRecentCalls().catch((err) => console.warn('[bt] auto-sync recents failed', err))
      }
    }, 2000)
  }

  // ─── BlueZ commands ────────────────────────────────────────────────────────

  private async mediaCmd(cmd: string) {
    if (!this.activePlayerPath || !this.systemBus) return
    try {
      const obj = await this.systemBus.getProxyObject(BLUEZ_BUS, this.activePlayerPath)
      const mp  = obj.getInterface(IFACE_PLAYER)
      if      (cmd === 'play')     await mp.Play()
      else if (cmd === 'pause')    await mp.Pause()
      else if (cmd === 'next')     await mp.Next()
      else if (cmd === 'previous') await mp.Previous()
      else if (cmd.startsWith('seek:')) {
        // BlueZ MediaPlayer1 has no absolute seek; relative seek is rarely
        // supported.  Best-effort: try FastForward / Rewind, or noop.
        const tgt = Number(cmd.slice('seek:'.length))
        const cur = this.media.positionSec
        if (tgt > cur && typeof mp.FastForward === 'function') await mp.FastForward()
        if (tgt < cur && typeof mp.Rewind      === 'function') await mp.Rewind()
      }
    } catch (err) { console.warn('[bt] media cmd failed', cmd, err) }
  }

  private async scan(on: boolean) {
    if (!this.systemBus) return
    try {
      const adapterPath = await this.findAdapterPath()
      if (!adapterPath) return
      const obj = await this.systemBus.getProxyObject(BLUEZ_BUS, adapterPath)
      const a   = obj.getInterface(IFACE_ADAPTER)
      if (on) await a.StartDiscovery()
      else    await a.StopDiscovery()
    } catch (err) { console.warn('[bt] scan failed', err) }
  }

  private async findAdapterPath(): Promise<string | null> {
    try {
      const root = await this.systemBus.getProxyObject(BLUEZ_BUS, BLUEZ_ROOT)
      const om   = root.getInterface(IFACE_OBJMGR)
      const objs = await om.GetManagedObjects()
      for (const [path, ifaces] of Object.entries(objs)) {
        if ((ifaces as any)[IFACE_ADAPTER]) return path
      }
    } catch { /* */ }
    return null
  }

  /** After a device reconnects, walk GetManagedObjects under it and
   *  re-run onObjectAdded for each sub-interface — needed because
   *  BlueZ doesn't always re-emit InterfacesAdded for previously-known
   *  MediaPlayer1 / Battery1 objects. */
  private async refreshInterfacesUnder(devicePath: string) {
    if (!this.systemBus) return
    try {
      const root = await this.systemBus.getProxyObject(BLUEZ_BUS, BLUEZ_ROOT)
      const om   = root.getInterface(IFACE_OBJMGR)
      const all  = await om.GetManagedObjects()
      const prefix = devicePath + '/'
      for (const [p, ifaces] of Object.entries(all)) {
        if (p === devicePath || p.startsWith(prefix)) {
          await this.onObjectAdded(p, ifaces as any)
        }
      }
    } catch (err) {
      console.warn('[bt] refreshInterfacesUnder failed', err)
    }
  }

  private async deviceOp(addr: string, op: 'Connect' | 'Disconnect' | 'Pair' | 'Trust') {
    const path = this.pathForAddress(addr)
    if (!path) return
    try {
      const obj = await this.systemBus.getProxyObject(BLUEZ_BUS, path)
      if (op === 'Trust') {
        const p = obj.getInterface(IFACE_PROPS)
        await p.Set(IFACE_DEVICE, 'Trusted', new this.dbus.Variant('b', true))
      } else {
        const d = obj.getInterface(IFACE_DEVICE)
        await d[op]()
      }
    } catch (err) { console.warn(`[bt] ${op} failed for`, addr, err) }
  }

  private async connectDevice(addr: string) {
    await this.deviceOp(addr, 'Trust').catch(() => undefined)
    await this.deviceOp(addr, 'Connect')
  }
  private async disconnectDevice(addr: string) { await this.deviceOp(addr, 'Disconnect') }

  private async forgetDevice(addr: string) {
    const path = this.pathForAddress(addr)
    if (!path) return
    try {
      const adapterPath = await this.findAdapterPath()
      if (!adapterPath) return
      const obj = await this.systemBus.getProxyObject(BLUEZ_BUS, adapterPath)
      const a   = obj.getInterface(IFACE_ADAPTER)
      await a.RemoveDevice(path)
    } catch (err) { console.warn('[bt] forget failed', err) }
  }

  private pathForAddress(addr: string): string | null {
    const entries = Array.from(this.devicePaths.entries())
    for (const [path, d] of entries) if (d.address === addr) return path
    return null
  }

  // ─── ofono — calls + HFP ───────────────────────────────────────────────────

  private async initOFono(attempt = 0): Promise<void> {
    if (!this.systemBus) return
    try {
      const obj = await this.systemBus.getProxyObject(OFONO_BUS, '/')
      const mgr = obj.getInterface(IFACE_OFONO_MGR)

      const modems = await mgr.GetModems()
      if (Array.isArray(modems) && modems.length > 0) {
        this.activeModemPath = String(modems[0][0])
        console.log('[bt] ofono modem:', this.activeModemPath)
        await this.subscribeVCM(this.activeModemPath)
      }
      mgr.on('ModemAdded', async (path: string) => {
        if (!this.activeModemPath) {
          this.activeModemPath = path
          await this.subscribeVCM(path)
        }
      })
      mgr.on('ModemRemoved', (path: string) => {
        if (this.activeModemPath === path) {
          this.activeModemPath = null
          this.activeCallPath = null
          this.call = { status: 'idle', durationSec: 0, muted: false }
          this.pushCall()
        }
      })
    } catch (err) {
      // ofonod may not be ready yet at boot — retry with backoff before giving up.
      const MAX_ATTEMPTS = 10
      if (attempt < MAX_ATTEMPTS) {
        const delaySec = Math.min((attempt + 1) * 2, 20) // 2 s, 4 s, … 20 s
        console.warn(`[bt] ofono not ready (attempt ${attempt + 1}/${MAX_ATTEMPTS}) — retrying in ${delaySec}s`)
        setTimeout(() => this.initOFono(attempt + 1), delaySec * 1000)
      } else {
        console.warn(
          '[bt] ofono not available after retries — calls will not work.\n' +
          '     Fix: sudo apt-get install ofono && sudo systemctl enable --now ofono\n' +
          '     err:', (err as Error).message
        )
      }
    }
  }

  private async subscribeVCM(modemPath: string) {
    try {
      const obj = await this.systemBus.getProxyObject(OFONO_BUS, modemPath)
      const vcm = obj.getInterface(IFACE_VCM)

      const calls = await vcm.GetCalls()
      if (Array.isArray(calls)) {
        for (const [cpath, props] of calls) this.adoptCall(cpath, unwrapVariants(props))
      }
      vcm.on('CallAdded',   (cpath: string, props: any) => this.adoptCall(cpath, unwrapVariants(props)))
      vcm.on('CallRemoved', (cpath: string)             => this.releaseCall(cpath))
    } catch (err) { console.warn('[bt] VCM subscribe failed', err) }
  }

  private async adoptCall(path: string, props: Record<string, any>) {
    this.activeCallPath = path
    const num  = props.LineIdentification ? String(props.LineIdentification) : ''
    const name = props.Name ? String(props.Name) : this.lookupContactName(num)
    this.call = {
      status:    callStatusFromOfono(String(props.State ?? '')),
      contact:   num ? { number: num, name } : undefined,
      durationSec: 0,
      muted:     this.call.muted,
    }
    console.log('[bt] call:', this.call.status, num || '(no number)')
    this.pushCall()

    try {
      const obj = await this.systemBus.getProxyObject(OFONO_BUS, path)
      const p   = obj.getInterface(IFACE_PROPS)
      p.on('PropertiesChanged', (name2: string, value: any) => {
        if (name2 === 'State') {
          this.call.status = callStatusFromOfono(String(unwrapVariant(value)))
          this.pushCall()
        }
      })
    } catch { /* */ }
  }

  private releaseCall(path: string) {
    if (this.activeCallPath !== path) return
    this.activeCallPath = null
    this.call = { status: 'idle', durationSec: 0, muted: false }
    this.pushCall()
  }

  private async dial(num: string) {
    if (!this.activeModemPath) {
      console.warn('[bt] dial: no modem (ofono running?  HFP connected?)')
      return
    }
    try {
      const obj = await this.systemBus.getProxyObject(OFONO_BUS, this.activeModemPath)
      const vcm = obj.getInterface(IFACE_VCM)
      await vcm.Dial(num, 'default')
    } catch (err) { console.warn('[bt] dial failed', err) }
  }

  private async answer() {
    if (!this.activeCallPath) return
    try {
      const obj = await this.systemBus.getProxyObject(OFONO_BUS, this.activeCallPath)
      await obj.getInterface(IFACE_VOICECALL).Answer()
    } catch (err) { console.warn('[bt] answer failed', err) }
  }

  private async hangup() {
    if (!this.activeCallPath) {
      // No specific call — hangup all
      if (this.activeModemPath) {
        try {
          const obj = await this.systemBus.getProxyObject(OFONO_BUS, this.activeModemPath)
          await obj.getInterface(IFACE_VCM).HangupAll()
        } catch { /* */ }
      }
      return
    }
    try {
      const obj = await this.systemBus.getProxyObject(OFONO_BUS, this.activeCallPath)
      await obj.getInterface(IFACE_VOICECALL).Hangup()
    } catch (err) { console.warn('[bt] hangup failed', err) }
  }

  private async reject() {
    // For an incoming call, Hangup() rejects it.
    return this.hangup()
  }

  private async setMuted(on: boolean) {
    this.call.muted = on
    this.pushCall()
    if (!this.activeModemPath) return
    try {
      const obj = await this.systemBus.getProxyObject(OFONO_BUS, this.activeModemPath)
      const p   = obj.getInterface(IFACE_PROPS)
      await p.Set(IFACE_CALLVOL, 'Muted', new this.dbus.Variant('b', on))
    } catch (err) { console.warn('[bt] mute failed', err) }
  }

  // ─── obex — PBAP phonebook sync ───────────────────────────────────────────

  private syncContacts(): Promise<void> {
    return this.chainPbap(() => this.syncContactsInner())
  }

  private async syncContactsInner() {
    if (!this.sessionBus) {
      this.contacts.lastError = 'session bus unavailable (no user D-Bus)'
      this.pushContacts()
      return
    }
    if (!this.activePhonePath) {
      this.contacts.lastError = 'no phone connected'
      this.pushContacts()
      return
    }
    const phone = this.devicePaths.get(this.activePhonePath)
    if (!phone) return

    this.contacts.syncing = true
    this.contacts.lastError = undefined
    this.pushContacts()

    const tmpFile = path.join(os.tmpdir(), `headunit-pbap-${Date.now()}.vcf`)
    let sessionPath: string | null = null

    try {
      console.log('[bt] PBAP: opening obex Client1 …')
      const obj = await this.sessionBus.getProxyObject(OBEX_BUS, '/org/bluez/obex')
      const client = obj.getInterface(IFACE_OBEX_MGR)

      console.log('[bt] PBAP: CreateSession ->', phone.address)
      sessionPath = await client.CreateSession(
        phone.address,
        { Target: new this.dbus.Variant('s', 'pbap') }
      )
      console.log('[bt] PBAP: session', sessionPath)

      const sobj = await this.sessionBus.getProxyObject(OBEX_BUS, sessionPath!)
      const pb   = sobj.getInterface(IFACE_PBAP)

      console.log('[bt] PBAP: Select(int, pb)')
      await pb.Select('int', 'pb')

      console.log('[bt] PBAP: PullAll ->', tmpFile)
      const result = await pb.PullAll(tmpFile, {
        Format: new this.dbus.Variant('s', 'vcard30'),
      })
      // PullAll returns (transferPath, propertiesDict)
      const transferPath: string = Array.isArray(result) ? result[0] : result
      const transferProps: any   = Array.isArray(result) ? result[1] : {}
      const actualFile = String(unwrapVariant(transferProps?.Filename) || tmpFile)

      console.log('[bt] PBAP: waiting for transfer', transferPath)
      await this.waitForObexTransfer(transferPath)

      console.log('[bt] PBAP: reading', actualFile)
      const vcfText = await readFileSafe(actualFile)
      try { fs.unlinkSync(actualFile) } catch { /* */ }

      const items = parseVcardList(vcfText)
      console.log(`[bt] PBAP: parsed ${items.length} contacts`)

      this.contacts = {
        synced: true, syncing: false,
        contacts: items.sort((a, b) => a.name.localeCompare(b.name)),
      }
      this.pushContacts()
    } catch (err) {
      console.warn('[bt] PBAP sync failed', err)
      this.contacts.syncing = false
      this.contacts.lastError = (err as Error).message ?? String(err) ?? 'pbap error'
      this.pushContacts()
    } finally {
      if (sessionPath) {
        try {
          const obj = await this.sessionBus.getProxyObject(OBEX_BUS, '/org/bluez/obex')
          await obj.getInterface(IFACE_OBEX_MGR).RemoveSession(sessionPath)
        } catch { /* */ }
      }
    }
  }

  /** Pull combined call history (incoming + outgoing + missed) over PBAP.
   *  iPhones expose this as the "cch" folder.  Each vCard includes
   *  X-IRMC-CALL-DATETIME for the timestamp.  Serialised via chainPbap
   *  so it never collides with syncContacts. */
  private syncRecentCalls(): Promise<void> {
    return this.chainPbap(() => this.syncRecentCallsInner())
  }

  private async syncRecentCallsInner() {
    if (!this.sessionBus) {
      this.recents.lastError = 'session bus unavailable'
      this.pushRecents()
      return
    }
    if (!this.activePhonePath) {
      this.recents.lastError = 'no phone connected'
      this.pushRecents()
      return
    }
    const phone = this.devicePaths.get(this.activePhonePath)
    if (!phone) return

    this.recents.syncing = true
    this.recents.lastError = undefined
    this.pushRecents()

    const tmpFile = path.join(os.tmpdir(), `headunit-pbap-cch-${Date.now()}.vcf`)
    let sessionPath: string | null = null

    try {
      console.log('[bt] PBAP cch: opening obex Client1 …')
      const obj = await this.sessionBus.getProxyObject(OBEX_BUS, '/org/bluez/obex')
      const client = obj.getInterface(IFACE_OBEX_MGR)

      sessionPath = await client.CreateSession(
        phone.address,
        { Target: new this.dbus.Variant('s', 'pbap') }
      )
      const sobj = await this.sessionBus.getProxyObject(OBEX_BUS, sessionPath!)
      const pb = sobj.getInterface(IFACE_PBAP)

      // Select the combined call history folder.
      try {
        await pb.Select('int', 'cch')
      } catch {
        // Some phones don't expose 'cch' — fall back to pulling separately
        // and merging.
        await pb.Select('int', 'ich')
      }

      console.log('[bt] PBAP cch: PullAll →', tmpFile)
      const result = await pb.PullAll(tmpFile, {
        Format: new this.dbus.Variant('s', 'vcard30'),
        MaxCount: new this.dbus.Variant('q', 50),
      })
      const transferPath: string = Array.isArray(result) ? result[0] : result
      const transferProps: any = Array.isArray(result) ? result[1] : {}
      const actualFile = String(unwrapVariant(transferProps?.Filename) || tmpFile)

      await this.waitForObexTransfer(transferPath)
      const vcfText = await readFileSafe(actualFile)
      try { fs.unlinkSync(actualFile) } catch { /* */ }

      const calls = parseCallHistoryVcards(vcfText)
      console.log(`[bt] PBAP cch: parsed ${calls.length} recent calls`)

      this.recents = {
        synced: true, syncing: false,
        calls: calls.sort((a, b) => b.time - a.time),
      }
      this.pushRecents()
    } catch (err) {
      console.warn('[bt] PBAP cch sync failed', err)
      this.recents.syncing = false
      this.recents.lastError = (err as Error).message ?? String(err) ?? 'pbap error'
      this.pushRecents()
    } finally {
      if (sessionPath) {
        try {
          const obj = await this.sessionBus.getProxyObject(OBEX_BUS, '/org/bluez/obex')
          await obj.getInterface(IFACE_OBEX_MGR).RemoveSession(sessionPath)
        } catch { /* */ }
      }
    }
  }

  /** Resolves when an obex Transfer1 reaches Status="complete", rejects on "error" or timeout. */
  private waitForObexTransfer(transferPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('PBAP transfer timeout (30s)'))
      }, 30000)

      this.sessionBus.getProxyObject(OBEX_BUS, transferPath).then((obj: any) => {
        const props = obj.getInterface(IFACE_PROPS)

        const finish = (ok: boolean, why?: string) => {
          clearTimeout(timer)
          try { props.removeListener?.('PropertiesChanged', listener) } catch { /* */ }
          ok ? resolve() : reject(new Error(why ?? 'PBAP transfer error'))
        }

        const listener = (iface: string, changed: any) => {
          if (iface !== 'org.bluez.obex.Transfer1') return
          const c = unwrapVariants(changed)
          if ('Status' in c) {
            const status = String(c.Status)
            if (status === 'complete') finish(true)
            else if (status === 'error') finish(false, 'PBAP transfer reported error')
          }
        }
        props.on('PropertiesChanged', listener)

        // Race: it might already be done before we attached the listener.
        props.GetAll('org.bluez.obex.Transfer1').then((all: any) => {
          const status = String(unwrapVariant(all?.Status) ?? '')
          if (status === 'complete') finish(true)
          else if (status === 'error') finish(false, 'PBAP transfer reported error')
        }).catch(() => { /* may already be gone — wait for the signal */ })
      }).catch((err: any) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  private lookupContactName(num: string): string | undefined {
    if (!num) return undefined
    const norm = num.replace(/[^\d]/g, '')
    const tail = norm.slice(-7)
    if (!tail) return undefined
    const hit = this.contacts.contacts.find(c =>
      c.numbers.some(n => n.number.replace(/[^\d]/g, '').endsWith(tail))
    )
    return hit?.name
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Unwrap dbus-next Variant ({signature, value}) to plain JS recursively (one level). */
function unwrapVariants(obj: any): Record<string, any> {
  if (!obj || typeof obj !== 'object') return obj
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(obj)) out[k] = unwrapVariant(v)
  return out
}

function unwrapVariant(v: any): any {
  if (v && typeof v === 'object' && 'value' in v && 'signature' in v) return v.value
  return v
}

const PHONE_ICONS = new Set(['phone', 'phone-cell', 'phone-smartphone'])
const HFP_UUIDS   = new Set([
  '0000111e-0000-1000-8000-00805f9b34fb', // HFP HF
  '0000111f-0000-1000-8000-00805f9b34fb', // HFP AG
  '0000112f-0000-1000-8000-00805f9b34fb', // PBAP PSE
  '00001130-0000-1000-8000-00805f9b34fb', // PBAP PCE
])

function isPhone(props: any): boolean {
  const icon = String(props.Icon ?? '').toLowerCase()
  if (PHONE_ICONS.has(icon)) return true
  const uuids = Array.isArray(props.UUIDs) ? props.UUIDs.map((u: string) => u.toLowerCase()) : []
  return uuids.some((u: string) => HFP_UUIDS.has(u))
}

function callStatusFromOfono(state: string): CallStatus {
  switch (state) {
    case 'incoming':    return 'incoming'
    case 'waiting':     return 'incoming'
    case 'dialing':     return 'dialing'
    case 'alerting':    return 'dialing'
    case 'active':      return 'active'
    case 'held':        return 'held'
    case 'disconnected':
    default:            return 'idle'
  }
}

async function readFileSafe(p: string): Promise<string> {
  // Tiny retry — obexd may have just finished writing.
  for (let i = 0; i < 5; i++) {
    try {
      const buf = fs.readFileSync(p)
      if (buf.length > 0) return buf.toString('utf-8')
    } catch { /* not there yet */ }
    await new Promise(r => setTimeout(r, 100))
  }
  return fs.readFileSync(p).toString('utf-8')
}

/** Split a multi-vCard file into individual vCard blocks and parse each. */
function parseVcardList(text: string): Contact[] {
  const blocks: string[] = []
  let current: string[] = []
  for (const ln of text.split(/\r?\n/)) {
    if (/^BEGIN:VCARD/i.test(ln)) current = [ln]
    else if (/^END:VCARD/i.test(ln)) { current.push(ln); blocks.push(current.join('\n')); current = [] }
    else if (current.length > 0) current.push(ln)
  }
  const items: Contact[] = []
  blocks.forEach((b, idx) => {
    const parsed = parseVcard(b)
    if (parsed.numbers.length > 0) {
      items.push({
        id: `c${idx}`,
        name: parsed.name || 'Unknown',
        numbers: parsed.numbers,
        photo: parsed.photo,
      })
    }
  })
  return items
}

/** Parse a multi-vCard call-history file (PBAP cch/ich/och/mch).
 *  Each vCard has an X-IRMC-CALL-DATETIME extension + a TEL number.
 *  iPhone tags MISSED/RECEIVED/DIALED in the parameter. */
function parseCallHistoryVcards(text: string): RecentCall[] {
  const blocks: string[] = []
  let current: string[] = []
  for (const ln of text.split(/\r?\n/)) {
    if (/^BEGIN:VCARD/i.test(ln)) current = [ln]
    else if (/^END:VCARD/i.test(ln)) { current.push(ln); blocks.push(current.join('\n')); current = [] }
    else if (current.length > 0) current.push(ln)
  }

  const calls: RecentCall[] = []
  for (const block of blocks) {
    // Unfold continued lines (lines starting with space/tab continue prev).
    const unfolded: string[] = []
    for (const ln of block.replace(/\r/g, '').split('\n')) {
      if ((ln.startsWith(' ') || ln.startsWith('\t')) && unfolded.length > 0) {
        unfolded[unfolded.length - 1] += ln.slice(1)
      } else {
        unfolded.push(ln)
      }
    }

    let name = ''
    let number = ''
    let time = 0
    let dir: RecentCall['dir'] = 'out'

    for (const ln of unfolded) {
      if (/^FN:/i.test(ln)) name = ln.slice(3).trim()
      else if (/^TEL/i.test(ln)) {
        const colon = ln.indexOf(':')
        if (colon !== -1 && !number) number = ln.slice(colon + 1).trim()
      } else if (/^X-IRMC-CALL-DATETIME/i.test(ln)) {
        const colon = ln.indexOf(':')
        if (colon !== -1) {
          const params = ln.slice(0, colon).toUpperCase()
          const dt = ln.slice(colon + 1).trim() // e.g. 20240315T134055
          // Parse YYYYMMDDTHHMMSS
          const m = dt.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/)
          if (m) {
            time = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
          }
          // Apple/some phones tag MISSED/RECEIVED/DIALED on the line.
          if (params.includes('MISSED'))   dir = 'miss'
          else if (params.includes('RECEIVED') || params.includes('INCOMING')) dir = 'in'
          else if (params.includes('DIALED')   || params.includes('OUTGOING')) dir = 'out'
        }
      }
    }

    if (number) calls.push({ name: name || undefined, number, time, dir })
  }
  return calls
}

/** Tiny vCard 3.0 parser — extracts FN + TEL entries + PHOTO if present. */
function parseVcard(text: string): { name: string; numbers: { type?: string; number: string }[]; photo?: string } {
  const lines = text.replace(/\r/g, '').split('\n')
  // RFC 2425: lines starting with space/tab continue the previous line.
  const unfolded: string[] = []
  for (const ln of lines) {
    if (ln.startsWith(' ') || ln.startsWith('\t')) unfolded[unfolded.length - 1] += ln.slice(1)
    else unfolded.push(ln)
  }
  let name = ''
  const numbers: { type?: string; number: string }[] = []
  let photo: string | undefined
  for (const ln of unfolded) {
    if (ln.startsWith('FN:')) name = ln.slice(3).trim()
    else if (/^TEL/i.test(ln)) {
      const colon = ln.indexOf(':')
      if (colon === -1) continue
      const params = ln.slice(0, colon).toUpperCase()
      const value  = ln.slice(colon + 1).trim()
      if (!value) continue
      const type = params.includes('CELL') ? 'mobile'
                 : params.includes('HOME') ? 'home'
                 : params.includes('WORK') ? 'work'
                 : undefined
      numbers.push({ type, number: value })
    } else if (/^PHOTO/i.test(ln)) {
      const colon = ln.indexOf(':')
      if (colon !== -1 && /b/i.test(ln.slice(0, colon))) {
        // base64-encoded inline photo
        const mime = /JPEG/i.test(ln) ? 'image/jpeg' : /PNG/i.test(ln) ? 'image/png' : 'image/jpeg'
        photo = `data:${mime};base64,${ln.slice(colon + 1).trim()}`
      }
    }
  }
  return { name, numbers, photo }
}
