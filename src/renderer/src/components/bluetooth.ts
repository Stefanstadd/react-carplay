// Renderer-side Bluetooth state + commands.
//
// Subscribes to events pushed from the main-process BluetoothManager via
// window.api.bt.* and re-exposes them as a React hook.  On dev (Windows)
// the IPC bridge is absent — the hook just returns the disconnected default.

import { useEffect, useRef, useState } from 'react'

// ─── Types ───────────────────────────────────────────────────────────────────

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
  /** ofono has an active modem for HFP.  If this is false while `connected`
   *  is true, dialling won't work — usually means ofono isn't running or the
   *  phone hasn't attached the HFP profile yet. */
  hfpReady?: boolean
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
  /** Bumped by useBluetooth whenever the progress bar should skip its
   *  smooth transition and snap to the new positionSec — track change
   *  or a delta > 3 s between local and server position. */
  snapCounter?: number
}

export type CallStatus = 'idle' | 'incoming' | 'dialing' | 'active' | 'held'

export interface CallContact {
  name?: string
  number: string
  photo?: string
}

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
  time: number       // epoch ms
  dir: 'in' | 'out' | 'miss'
}

export interface RecentCallsState {
  synced: boolean
  syncing: boolean
  calls: RecentCall[]
  lastError?: string
}

const DEFAULT_PHONE: PhoneState   = { connected: false }
const DEFAULT_MEDIA: MediaState   = { hasMetadata: false, durationSec: 0, positionSec: 0, playing: false, snapCounter: 0 }
const DEFAULT_CALL:  CallState    = { status: 'idle', durationSec: 0, muted: false }
const DEFAULT_CTS:   ContactsState = { synced: false, syncing: false, contacts: [] }
const DEFAULT_RCS:   RecentCallsState = { synced: false, syncing: false, calls: [] }

// ─── Hook ────────────────────────────────────────────────────────────────────

export interface DialError {
  reason: string
  ts: number
}

export function useBluetooth() {
  const [phone,    setPhone]    = useState<PhoneState>(DEFAULT_PHONE)
  const [media,    setMedia]    = useState<MediaState>(DEFAULT_MEDIA)
  const [call,     setCall]     = useState<CallState>(DEFAULT_CALL)
  const [contacts, setContacts] = useState<ContactsState>(DEFAULT_CTS)
  const [recents,  setRecents]  = useState<RecentCallsState>(DEFAULT_RCS)
  const [devices,  setDevices]  = useState<BtDevice[]>([])
  const [dialError, setDialError] = useState<DialError | null>(null)
  // Wall-clock (perf.now) of the last local self-seek (prev/next/seek).  For
  // ~2 s after a self-seek we ignore any wildly different position that main
  // pushes — that push is almost always the stale AVRCP poll from just
  // *before* the phone restarted the track.  Without this the bar bounces
  // back to the pre-replay position for a second.
  const lastSelfSeekRef = useRef(0)

  useEffect(() => {
    const bt = (window as any).api?.bt
    if (!bt) return

    bt.onPhone((_: any, d: PhoneState) => {
      console.log('[bt:hook] phone state:', d)
      setPhone(d ?? DEFAULT_PHONE)
    })
    bt.onMedia((_: any, d: MediaState) => {
      setMedia((prev) => {
        const next = d ?? DEFAULT_MEDIA
        const trackChanged = next.title !== prev.title || next.artist !== prev.artist
        const prevSnap = prev.snapCounter ?? 0
        if (trackChanged) {
          // New track — always trust the server position and mark a snap so
          // the progress bar jumps rather than sliding backward from the old track.
          return { ...next, snapCounter: prevSnap + 1 }
        }
        // Just performed a local seek/prev/next?  Main's 1 Hz AVRCP poll is
        // usually captured *before* the phone restarted the track, so its
        // position push arrives 500 ms–1 s late and would bounce our bar
        // back to the pre-restart position.  Ignore that push for ~2 s and
        // trust the optimistic value we set locally.  Once the window
        // closes, the normal delta > 3 s → snap path takes over.
        const sinceSelfSeek = performance.now() - lastSelfSeekRef.current
        if (sinceSelfSeek < 2000) {
          return { ...next, positionSec: prev.positionSec, snapCounter: prevSnap }
        }
        const delta = Math.abs(next.positionSec - prev.positionSec)
        if (delta > 3) {
          // Big jump (external seek, big drift) — trust the server and snap.
          return { ...next, snapCounter: prevSnap + 1 }
        }
        // Small drift: local 10 Hz counter is authoritative. Never let BlueZ's
        // 1 Hz poll snap the bar back mid-play.
        return { ...next, positionSec: prev.positionSec, snapCounter: prevSnap }
      })
    })
    bt.onCall    ((_: any, d: CallState)         => setCall(d ?? DEFAULT_CALL))
    bt.onContacts((_: any, d: ContactsState) => {
      if (!d) { setContacts(DEFAULT_CTS); return }
      // Phones (esp. iPhones synced across multiple accounts) send the same
      // contact multiple times.  Collapse duplicates by name + primary number.
      const seen = new Set<string>()
      const uniq: Contact[] = []
      for (const c of d.contacts) {
        const primary = c.numbers[0]?.number
          ? normaliseNumber(c.numbers[0].number).replace(/^\+/, '')
          : ''
        const key = `${c.name.trim().toLowerCase()}|${primary}`
        if (seen.has(key)) continue
        seen.add(key)
        uniq.push(c)
      }
      setContacts({ ...d, contacts: uniq })
    })
    bt.onRecents ((_: any, d: RecentCallsState)  => setRecents(d ?? DEFAULT_RCS))
    bt.onDevices ((_: any, d: BtDevice[])        => setDevices(d ?? []))
    bt.onDialError?.((_: any, d: { reason: string }) => {
      console.warn('[bt:dial] failed:', d?.reason)
      setDialError({ reason: d?.reason ?? 'Call failed', ts: Date.now() })
    })

    bt.requestState?.()
  }, [])

  // Smooth local position tick — 10 Hz so the progress bar slides
  // continuously instead of jumping in 1-second chunks like main's poll.
  useEffect(() => {
    if (!media.playing) return
    let last = performance.now()
    const id = setInterval(() => {
      const now = performance.now()
      const dt = (now - last) / 1000
      last = now
      setMedia((prev) =>
        prev.playing
          ? {
              ...prev,
              positionSec: prev.durationSec > 0
                ? Math.min(prev.positionSec + dt, prev.durationSec)
                : prev.positionSec,
            }
          : prev
      )
    }, 100)
    return () => clearInterval(id)
  }, [media.playing])

  // Local duration tick for the active call.
  useEffect(() => {
    if (call.status !== 'active') return
    const id = setInterval(() => {
      setCall(prev => prev.status === 'active'
        ? { ...prev, durationSec: prev.durationSec + 1 }
        : prev)
    }, 1000)
    return () => clearInterval(id)
  }, [call.status])

  const bt = (window as any).api?.bt

  return {
    phone, media, call, contacts, recents, devices, dialError,
    clearDialError: () => setDialError(null),

    mediaPlay:    () => bt?.mediaCmd?.('play'),
    mediaPause:   () => bt?.mediaCmd?.('pause'),
    mediaToggle:  () => bt?.mediaCmd?.(media.playing ? 'pause' : 'play'),
    // prev/next/seek all move the position optimistically so the bar reflects
    // the user's intent instantly.  `lastSelfSeekRef` gates the onMedia
    // handler so it ignores the stale AVRCP poll main is about to send.
    mediaNext: () => {
      bt?.mediaCmd?.('next')
      lastSelfSeekRef.current = performance.now()
      setMedia((p) => ({ ...p, positionSec: 0, snapCounter: (p.snapCounter ?? 0) + 1 }))
    },
    mediaPrev: () => {
      bt?.mediaCmd?.('previous')
      lastSelfSeekRef.current = performance.now()
      setMedia((p) => ({ ...p, positionSec: 0, snapCounter: (p.snapCounter ?? 0) + 1 }))
    },
    mediaSeek: (sec: number) => {
      bt?.mediaCmd?.(`seek:${Math.max(0, Math.floor(sec))}`)
      lastSelfSeekRef.current = performance.now()
      setMedia((p) => ({
        ...p,
        positionSec: Math.max(0, sec),
        snapCounter: (p.snapCounter ?? 0) + 1,
      }))
    },

    // Calls
    dial:    (num: string)     => bt?.dial?.(num),
    answer:  ()                => bt?.answer?.(),
    reject:  ()                => bt?.reject?.(),
    hangup:  ()                => bt?.hangup?.(),
    mute:    (on: boolean)     => bt?.mute?.(on),
    toggleMute: ()             => bt?.mute?.(!call.muted),

    // Contacts + recents
    syncContacts: () => bt?.syncContacts?.(),
    syncRecents:  () => bt?.syncRecents?.(),

    // Devices
    scan:       (on: boolean)  => bt?.scan?.(on),
    connect:    (addr: string) => bt?.connect?.(addr),
    disconnect: (addr: string) => bt?.disconnect?.(addr),
    forget:     (addr: string) => bt?.forget?.(addr),
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalise a number for matching: keep digits + leading '+'. */
export function normaliseNumber(n: string): string {
  const trimmed = n.trim()
  const plus = trimmed.startsWith('+') ? '+' : ''
  return plus + trimmed.replace(/[^\d]/g, '')
}

// T9 letter-to-digit mapping for dial-pad name search.
const T9: Record<string, string> = {
  a:'2', b:'2', c:'2',
  d:'3', e:'3', f:'3',
  g:'4', h:'4', i:'4',
  j:'5', k:'5', l:'5',
  m:'6', n:'6', o:'6',
  p:'7', q:'7', r:'7', s:'7',
  t:'8', u:'8', v:'8',
  w:'9', x:'9', y:'9', z:'9',
}

function nameToT9(name: string): string {
  return name.toLowerCase().split('').map(c => T9[c] ?? '').join('')
}

/**
 * Match contacts whose numbers contain the typed digits (in order), OR
 * whose name (T9-encoded) starts with the typed digits.  So "262" matches
 * both the phone number 026...262... AND the name "Bob" (B=2, o=6, b=2).
 */
export function filterContactsByDial(contacts: Contact[], dial: string): Contact[] {
  const digits = dial.replace(/[^\d]/g, '')
  if (!digits) return contacts
  return contacts.filter(c =>
    c.numbers.some(n => normaliseNumber(n.number).replace(/^\+/, '').includes(digits)) ||
    nameToT9(c.name).startsWith(digits) ||
    // Also match against individual words in the name ("john smith" → 5646...7648)
    c.name.toLowerCase().split(/\s+/).some(word => nameToT9(word).startsWith(digits))
  )
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`
}
