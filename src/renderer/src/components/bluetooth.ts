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

const DEFAULT_PHONE: PhoneState   = { connected: false }
const DEFAULT_MEDIA: MediaState   = { hasMetadata: false, durationSec: 0, positionSec: 0, playing: false }
const DEFAULT_CALL:  CallState    = { status: 'idle', durationSec: 0, muted: false }
const DEFAULT_CTS:   ContactsState = { synced: false, syncing: false, contacts: [] }

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useBluetooth() {
  const [phone,    setPhone]    = useState<PhoneState>(DEFAULT_PHONE)
  const [media,    setMedia]    = useState<MediaState>(DEFAULT_MEDIA)
  const [call,     setCall]     = useState<CallState>(DEFAULT_CALL)
  const [contacts, setContacts] = useState<ContactsState>(DEFAULT_CTS)
  const [devices,  setDevices]  = useState<BtDevice[]>([])
  // Timestamp (ms) of the last user-driven seek/prev/next.  For 800 ms
  // after that we ignore positionSec updates from main, otherwise the
  // BlueZ position poller snaps the bar back to the OLD position while
  // the phone hasn't actually responded yet (= the visible "0 → old → 1"
  // flicker on previous-button press).
  const userSeekAtRef = useRef(0)

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
        const sameTrack = next.title === prev.title && next.artist === prev.artist
        const recentlySeeked = Date.now() - userSeekAtRef.current < 800
        const smallDrift =
          sameTrack && Math.abs((next.positionSec ?? 0) - prev.positionSec) < 2
        // Trust local positionSec over main when the user just seeked OR
        // when the diff is small (BlueZ polls 1Hz; our local tick is 10Hz
        // so the local value is always ahead by up to 1 s — that's not
        // a real seek, it's just clock drift).
        if (recentlySeeked || smallDrift) {
          return { ...next, positionSec: prev.positionSec }
        }
        return next
      })
    })
    bt.onCall    ((_: any, d: CallState)     => setCall(d ?? DEFAULT_CALL))
    bt.onContacts((_: any, d: ContactsState) => setContacts(d ?? DEFAULT_CTS))
    bt.onDevices ((_: any, d: BtDevice[])    => setDevices(d ?? []))

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
                : prev.positionSec + dt,
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
    phone, media, call, contacts, devices,

    // Media transport.  prev/next optimistically snap position to 0 and
    // mark a "user just seeked" timestamp so the BlueZ position poller
    // doesn't yank us back to the old time during the next 800 ms.
    mediaPlay:    () => bt?.mediaCmd?.('play'),
    mediaPause:   () => bt?.mediaCmd?.('pause'),
    mediaToggle:  () => bt?.mediaCmd?.(media.playing ? 'pause' : 'play'),
    mediaNext: () => {
      bt?.mediaCmd?.('next')
      userSeekAtRef.current = Date.now()
      setMedia((p) => ({ ...p, positionSec: 0 }))
    },
    mediaPrev: () => {
      bt?.mediaCmd?.('previous')
      userSeekAtRef.current = Date.now()
      setMedia((p) => ({ ...p, positionSec: 0 }))
    },
    mediaSeek: (sec: number) => {
      bt?.mediaCmd?.(`seek:${Math.max(0, Math.floor(sec))}`)
      userSeekAtRef.current = Date.now()
      setMedia((p) => ({ ...p, positionSec: Math.max(0, sec) }))
    },

    // Calls
    dial:    (num: string)     => bt?.dial?.(num),
    answer:  ()                => bt?.answer?.(),
    reject:  ()                => bt?.reject?.(),
    hangup:  ()                => bt?.hangup?.(),
    mute:    (on: boolean)     => bt?.mute?.(on),
    toggleMute: ()             => bt?.mute?.(!call.muted),

    // Contacts
    syncContacts: () => bt?.syncContacts?.(),

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
