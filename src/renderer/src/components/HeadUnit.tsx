import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './HeadUnit.css'
import iconMobile from '../assets/icons/mobile.png'
import iconGauges from '../assets/icons/gauges.png'
import iconMusic from '../assets/icons/music.png'
import iconPhone from '../assets/icons/phone.png'
import iconSettings from '../assets/icons/settings.png'
import iconContacts from '../assets/icons/contacts.png'
import iconRecent from '../assets/icons/recent.png'
import iconCarplay from '../assets/icons/carplay.png'
import {
  useBluetooth,
  filterContactsByDial,
  formatDuration,
  type Contact,
  type PhoneState,
  type CallState,
  type BtDevice
} from './bluetooth'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VehicleData {
  oilTempC?: number
  oilPressurePsi?: number
  speedKmh?: number
  rpm?: number
  batteryV?: number
}

interface HeadUnitProps {
  onLaunchCarplay: () => void
  onOpenSettings?: () => void
  vehicleData?: VehicleData
}

type ViewName = 'devices' | 'gauges' | 'music' | 'phone'
const CYCLE: ViewName[] = ['devices', 'gauges', 'music', 'phone']

const VIEW_ICONS: Record<ViewName, string> = {
  devices: iconMobile,
  gauges: iconGauges,
  music: iconMusic,
  phone: iconPhone
}

// ─── Scaling ──────────────────────────────────────────────────────────────────
// The UI is always drawn at 1920×1080 and CSS-transformed to fit the window.

function getScaleState() {
  const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080)
  return {
    scale: s,
    ox: (window.innerWidth - 1920 * s) / 2,
    oy: (window.innerHeight - 1080 * s) / 2
  }
}

// ─── Gauge math ───────────────────────────────────────────────────────────────

function polarToCartesian(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

function gaugeArc(cx: number, cy: number, r: number, startDeg: number, sweepDeg: number): string {
  if (sweepDeg <= 0) {
    const p = polarToCartesian(cx, cy, r, startDeg)
    return `M ${p.x.toFixed(2)} ${p.y.toFixed(2)}`
  }
  const s = polarToCartesian(cx, cy, r, startDeg)
  const e = polarToCartesian(cx, cy, r, startDeg + sweepDeg)
  const large = sweepDeg > 180 ? 1 : 0
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(
    2
  )} ${e.y.toFixed(2)}`
}

// ─── Clock ────────────────────────────────────────────────────────────────────

function useClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])
  return now
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatClock(d: Date) {
  return {
    dayDate: `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`,
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
}

function formatTime(s: number) {
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

// ─── Header ───────────────────────────────────────────────────────────────────

function HUHeader({ phone }: { phone: PhoneState }) {
  const { dayDate, time } = formatClock(useClock())
  const battery = phone.connected ? phone.batteryPct ?? 0 : 0
  const fillW = Math.max(0, (battery / 100) * 19).toFixed(1)
  return (
    <header className="hu-header">
      <div className="hu-header-clock">
        <span className="hu-clock-date">{dayDate}</span>
        <span className="hu-clock-time">{time}</span>
      </div>
      <div className="hu-header-right">
        {phone.connected ? (
          <>
            <span className="hu-phone-name">{phone.name ?? 'Phone'}</span>
            <svg viewBox="0 0 30 14" width="56" height="26" className="hu-batt-svg">
              <rect
                x="0.75"
                y="0.75"
                width="25.5"
                height="12.5"
                rx="0"
                fill="none"
                stroke="#00ff0a"
                strokeWidth="1.5"
              />
              <rect x="26.25" y="4" width="3" height="6" rx="0" fill="#00ff0a" />
              <rect x="2" y="2" width={fillW} height="10" rx="0" fill="#00ff0a" />
              {phone.charging && (
                <polygon
                  points="14,3 9,8 13,8 11,12 16,7 12,7"
                  fill="#001500"
                  stroke="#001500"
                  strokeWidth="0.4"
                />
              )}
            </svg>
            {phone.batteryPct !== undefined && (
              <span className="hu-phone-batt">
                {Math.round(phone.batteryPct)}%
                {phone.charging && (
                  <span className="hu-phone-charging" aria-label="charging">
                    ⚡
                  </span>
                )}
              </span>
            )}
          </>
        ) : (
          <span className="hu-phone-name hu-phone-name-dim">NO PHONE</span>
        )}
      </div>
    </header>
  )
}

// ─── NavBar ───────────────────────────────────────────────────────────────────

type NavId = ViewName | 'settings'
const NAV_ORDER: NavId[] = ['devices', 'gauges', 'music', 'phone', 'settings']
const NAV_ICONS: Record<NavId, string> = { ...VIEW_ICONS, settings: iconSettings }

const NAV_CENTER = 2 // visual center is slot index 2
const NAV_SLOT_W = 220 // px per slot

function NavBar({
  active,
  onSelect,
  onSettings
}: {
  active: ViewName
  onSelect: (v: ViewName) => void
  onSettings?: () => void
}) {
  const activeIdx = NAV_ORDER.indexOf(active)
  const shift = (NAV_CENTER - activeIdx) * NAV_SLOT_W
  return (
    <nav className="hu-navbar">
      <div className="hu-navbar-row" style={{ transform: `translateX(${shift}px)` }}>
        {NAV_ORDER.map((id) => {
          const isActive = id === active
          const onClick = () => {
            if (id === 'settings') onSettings?.()
            else onSelect(id as ViewName)
          }
          return (
            <button
              key={id}
              className={`hu-nav-btn${isActive ? ' hu-nav-active' : ''}`}
              onClick={onClick}
              aria-label={id}
            >
              <img src={NAV_ICONS[id]} alt="" className="hu-nav-icon" draggable={false} />
            </button>
          )
        })}
      </div>
    </nav>
  )
}

// ─── Music View ───────────────────────────────────────────────────────────────

// Number of EQ bars across the visualizer.  Bars stay log-spaced from
// F_MIN_HZ → F_MAX_HZ no matter how many you pick.  More bars = thinner,
// finer detail; fewer = wider/chunkier.  Tested up to 64.
const NUM_BARS = 32
const BAR_MIX_LO = 0.6
const BAR_MIX_HI = 0.9

// Frequency range covered by the visualiser, log-spaced.  Tighter range
// means more resolution where music actually lives.  30 Hz → 20 kHz is
// the "full audible" range but the bottom octave is mostly sub-bass
// rumble that visually dominates.  50 Hz → 18 kHz is a good musical
// default.
const F_MIN_HZ = 50
const F_MAX_HZ = 18000
const BAR_RATIO = Math.pow(F_MAX_HZ / F_MIN_HZ, 1 / (NUM_BARS - 1)) // ≈1/3 octave per bar
const BAR_CENTERS_HZ = Array.from({ length: NUM_BARS }, (_, i) => F_MIN_HZ * Math.pow(BAR_RATIO, i))

// ─── EQ responsiveness + contrast — tweak these to taste ─────────────────
// Peak-hold decay: each frame the previous bar height is multiplied by this
// factor, and the bar shows max(decayedPrev, freshValue).  Lower = snappier
// (bars track audio tightly, snap down fast), higher = smoother fall.
//   0.0 → bars snap to value every frame (jittery)
//   0.5 → drops to half each frame → ~12% after 3 frames (~100 ms)
//   0.8 → smoother, slower drop
//   1.0 → bars never fall (only ever rise)
const EQ_FALL_FACTOR = 0.5
// Web Audio's temporal smoothing on the raw FFT data.  Stacked with FALL.
//   0.0 → frame-fresh FFT bins (most responsive, can look noisy)
//   0.3 → mild smoothing
//   0.8 → heavy averaging
const EQ_ANALYSER_SMOOTHING = 0.2
// Gamma curve on the bar value — >1 squashes mid values and emphasises
// peaks (more contrast: peakier peaks, deeper depths).  <1 expands the
// middle so quiet sounds still register.
//   0.5 → boost everything (everything looks active)
//   1.0 → linear
//   1.4 → moderate contrast (default — still leaves moderate audio visible)
//   2.0 → strong contrast (only loud transients reach the top)
const EQ_GAMMA = 1.3
// Noise gate: anything below this fraction (after smoothing) is clamped
// to zero so quiet bars actually fall to nothing instead of hovering.
//   0.0  → no gate
//   0.04 → eat just floor noise (default)
//   0.10 → also kill very quiet music tails
//   0.20 → only mid-loud parts register
const EQ_NOISE_GATE = 0.04
// Frequency tilt — boosts high-freq bars relative to lows, compensating
// for music's natural bass-heavy energy distribution.  Same idea as
// FL Studio's spectrum analyzer tilt or pink-noise compensation.  Each
// bar's value is multiplied by (centerHz / 1000) ^ EQ_TILT, capped at 2x.
//   0.0  → no tilt (raw spectrum — bass dominates as captured)
//   0.25 → mild musical balance (default)
//   0.5  → moderate (pink-noise compensation)
//   0.8  → aggressive (highs dominate)
const EQ_TILT = 0.25
const EQ_TILT_MAX_GAIN = 2.0
const BAR_TILT_GAINS = BAR_CENTERS_HZ.map((hz) =>
  Math.min(EQ_TILT_MAX_GAIN, Math.pow(hz / 1000, EQ_TILT))
)
const formatHz = (hz: number): string => {
  if (hz >= 1000) {
    const k = hz / 1000
    return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, '')}k`
  }
  return `${Math.round(hz)}`
}
const BAR_FREQS = BAR_CENTERS_HZ.map(formatHz)

// Album art fallback chain.  AVRCP rarely carries cover art (and BlueZ
// doesn't expose what little there is), so we look it up online: iTunes
// first (best match for major-label music), then Deezer (covers a lot of
// what iTunes misses, including Spotify-exclusive / Canvas tracks).
// Several query shapes are tried per service before giving up.
const artCache = new Map<string, string | null>()

/** Strip "(feat. ...)", "[Remix]", " - Remaster", and Spotify's
 * " • Video beschikbaar" / " • Music Video" Canvas annotations that
 * confuse the iTunes/Deezer search. */
function cleanForSearch(s: string): string {
  return s
    // Spotify appends "• <something>" to the artist or title for tracks
    // that have a Canvas video.  In any language.  Strip everything from
    // the bullet onward.
    .replace(/\s*[•·]\s*.*$/u, '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s*-\s*(remaster(ed)?|remix|edit|version|mix|live|mono|stereo).*$/i, '')
    .replace(/\s+feat\.?.*$/i, '')
    .replace(/\s+ft\.?.*$/i, '')
    .replace(/\s+,.*$/, '')
    .trim()
}

async function searchItunes(query: string): Promise<string | null> {
  try {
    const r = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&limit=5&media=music`
    )
    const data = await r.json()
    for (const result of data?.results ?? []) {
      const url100 = result?.artworkUrl100 as string | undefined
      if (url100) return url100.replace(/100x100bb/, '600x600bb')
    }
  } catch { /* network / parse fail */ }
  return null
}

async function searchDeezer(query: string): Promise<string | null> {
  try {
    const r = await fetch(
      `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=5`
    )
    const data = await r.json()
    for (const result of data?.data ?? []) {
      const big = result?.album?.cover_xl ?? result?.album?.cover_big ?? result?.album?.cover_medium
      if (big) return big as string
    }
  } catch { /* network / parse fail */ }
  return null
}

function useArt(
  title?: string,
  artist?: string,
  album?: string,
  embedded?: string
): string | undefined {
  const [art, setArt] = useState<string | undefined>(embedded)
  useEffect(() => {
    if (embedded) {
      setArt(embedded)
      return
    }
    if (!title || !artist || title === 'No Track') {
      setArt(undefined)
      return
    }
    const key = `${artist}|${title}|${album ?? ''}`
    if (artCache.has(key)) {
      setArt(artCache.get(key) ?? undefined)
      return
    }
    let cancelled = false
    const cleanTitle  = cleanForSearch(title)
    const cleanArtist = cleanForSearch(artist)
    const queries = [
      `${cleanArtist} ${cleanTitle}`,
      album ? `${cleanArtist} ${album}` : null,
      `${cleanArtist} ${album ?? ''} ${cleanTitle}`,
    ].filter(Boolean) as string[]

    ;(async () => {
      console.log('[art] looking up:', artist, '—', title, album ? `(album: ${album})` : '')
      for (const q of queries) {
        const hit = await searchItunes(q)
        if (hit) {
          console.log('[art] iTunes hit for query:', q)
          if (!cancelled) { artCache.set(key, hit); setArt(hit) }
          return
        }
      }
      for (const q of queries) {
        const hit = await searchDeezer(q)
        if (hit) {
          console.log('[art] Deezer hit for query:', q)
          if (!cancelled) { artCache.set(key, hit); setArt(hit) }
          return
        }
      }
      console.warn('[art] no hit on any service for', artist, '—', title)
      if (!cancelled) { artCache.set(key, null); setArt(undefined) }
    })()

    return () => { cancelled = true }
  }, [title, artist, album, embedded])
  return art
}

function MusicView({
  onLaunchCarplay,
  onSelectView,
  bt
}: {
  onLaunchCarplay: () => void
  onSelectView: (v: ViewName) => void
  bt: ReturnType<typeof useBluetooth>
}) {
  const targetRef = useRef<number[]>(
    Array.from(
      { length: NUM_BARS },
      (_, i) => (i < 6 ? 0.6 : i < 14 ? 0.4 : 0.25) + Math.random() * 0.2
    )
  )
  const [eqBars, setEqBars] = useState<number[]>(targetRef.current.slice())
  const analyserRef = useRef<AnalyserNode | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const dataRef = useRef<Uint8Array | null>(null)
  const frameRef = useRef(0)

  const phoneConnected = bt.phone.connected
  const media = bt.media
  const isPlaying = media.playing && phoneConnected
  const artworkSrc = useArt(media.title, media.artist, media.album, media.artworkSrc)

  // isPlaying via a ref so the simulation fallback can react to play/pause
  // without retearing the analyser on every state change.
  const isPlayingRef = useRef(isPlaying)
  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])

  // EQ analyser — capture audio from a PulseAudio monitor source (the
  // standard way to expose what's being played out the BT/HDMI/jack sink).
  // Falls back to a tasteful idle animation if no monitor source exists.
  // Set up ONCE on mount — re-acquiring getUserMedia on every play/pause
  // creates a gap where the simulation takes over.
  useEffect(() => {
    let cancelled = false
    let tick = 0
    const attach = (stream: MediaStream) => {
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      const ctx = new AudioContext()
      ctxRef.current = ctx
      if (ctx.state === 'suspended') ctx.resume().catch(() => undefined)
      const analyser = ctx.createAnalyser()
      // 2048 → 1024 bins at 48kHz = 23.4 Hz/bin, enough resolution to
      // distinguish 30 Hz from 60 Hz at the bottom of the band.
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = EQ_ANALYSER_SMOOTHING
      analyser.minDecibels = -85
      analyser.maxDecibels = -25
      dataRef.current = new Uint8Array(analyser.frequencyBinCount)
      analyserRef.current = analyser
      ctx.createMediaStreamSource(stream).connect(analyser)
      console.log(
        '[eq] analyser attached, tracks:',
        stream.getAudioTracks().map((t) => t.label)
      )
    }
    const tryAudio = async () => {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
        const devs = await navigator.mediaDevices.enumerateDevices()
        const inputs = devs.filter((d) => d.kind === 'audioinput')
        console.log(
          '[eq] audio inputs:',
          inputs.map((d) => ({ label: d.label, id: d.deviceId.slice(0, 8) }))
        )
        const monitor = inputs.find((d) => /monitor|bluez|bluetooth/i.test(d.label))
        if (monitor && monitor.deviceId) {
          console.log('[eq] using monitor source:', monitor.label)
          probe.getTracks().forEach((t) => t.stop())
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: monitor.deviceId } } as MediaTrackConstraints
          })
          attach(stream)
        } else {
          console.log(
            '[eq] no monitor source labelled — using default input (set PA default-source to capture speaker output)'
          )
          attach(probe)
        }
      } catch (err) {
        console.warn('[eq] getUserMedia failed — using simulation fallback', err)
      }
      startLoop()
    }
    const startLoop = () => {
      const loop = () => {
        if (cancelled) return
        tick++
        if (tick % 2 === 0) {
          if (analyserRef.current && dataRef.current) {
            analyserRef.current.getByteFrequencyData(dataRef.current)
            // DEBUG: once per second, log the max raw byte value from the
            // FFT.  0 = analyser is reading silence (audio not reaching
            // the captured source).  >0 = signal IS there → tuning issue.
            if (tick % 60 === 0) {
              let max = 0
              for (let b = 0; b < dataRef.current.length; b++) {
                if (dataRef.current[b] > max) max = dataRef.current[b]
              }
              console.log('[eq] raw analyser max byte:', max, '/ 255')
            }
            const sampleRate = ctxRef.current?.sampleRate ?? 48000
            const bins = dataRef.current.length
            const binWidth = sampleRate / 2 / bins
            const edge = Math.sqrt(BAR_RATIO)
            // Each bar covers center / sqrt(ratio) … center * sqrt(ratio).
            // Average the FFT bins in that range, then apply peak-hold
            // decay: rise instantly to the new value, fall by
            // EQ_FALL_FACTOR per frame.  Tune EQ_FALL_FACTOR at the top
            // of this file for snappiness vs. smoothness.
            setEqBars((prev) =>
              Array.from({ length: NUM_BARS }, (_, i) => {
                const center = BAR_CENTERS_HZ[i]
                const lo = Math.max(0, Math.floor(center / edge / binWidth))
                const hi = Math.min(bins - 1, Math.ceil((center * edge) / binWidth))
                let sum = 0
                let n = 0
                for (let b = lo; b <= hi; b++) {
                  sum += dataRef.current![b]
                  n++
                }
                let value = n > 0 ? sum / n / 255 : 0
                // Frequency tilt — multiply by the precomputed per-bar
                // gain so high frequencies aren't dwarfed by bass.
                value = Math.min(1, value * BAR_TILT_GAINS[i])
                // Noise gate — drop quiet bars to zero and rescale the
                // remaining [gate, 1] range back to [0, 1] so the gate
                // doesn't visibly lower the loud parts.
                if (value < EQ_NOISE_GATE) value = 0
                else value = (value - EQ_NOISE_GATE) / (1 - EQ_NOISE_GATE)
                // Gamma curve for visual contrast.
                if (value > 0) value = Math.pow(value, EQ_GAMMA)
                const decayed = prev[i] * EQ_FALL_FACTOR
                return Math.max(value, decayed)
              })
            )
          } else {
            const playing = isPlayingRef.current
            setEqBars((prev) =>
              prev.map((v, i) => {
                const isBass = i < 4
                const speed = isBass ? 0.05 : i < 12 ? 0.08 : 0.12
                const ceiling = playing ? (isBass ? 0.95 : i < 12 ? 0.78 : 0.6) : 0.18
                if (Math.random() < 0.04)
                  targetRef.current[i] = Math.random() * ceiling + (playing ? 0.08 : 0.02)
                return v + (targetRef.current[i] - v) * speed
              })
            )
          }
        }
        frameRef.current = requestAnimationFrame(loop)
      }
      frameRef.current = requestAnimationFrame(loop)
    }
    tryAudio()
    return () => {
      cancelled = true
      cancelAnimationFrame(frameRef.current)
      ctxRef.current?.close()
      ctxRef.current = null
      analyserRef.current = null
      dataRef.current = null
    }
  }, [])

  const progress = media.durationSec > 0 ? Math.min(1, media.positionSec / media.durationSec) : 0

  const title = phoneConnected ? media.title ?? 'No Track' : 'No Phone'
  const artist = phoneConnected ? media.artist ?? '—' : 'Connect a phone via Bluetooth'
  const album = phoneConnected ? media.album ?? '—' : '—'

  const onSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!media.durationSec) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = (e.clientX - rect.left) / rect.width
    bt.mediaSeek(pct * media.durationSec)
  }

  return (
    <div className="hu-screen hu-music-screen">
      <div className="hu-viz-area">
        <div className="hu-eq-bars">
          {eqBars.map((h, i) => {
            const t = Math.max(0, Math.min(1, (h - BAR_MIX_LO) / (BAR_MIX_HI - BAR_MIX_LO)))
            const dimPct = ((1 - t) * 100).toFixed(0)
            const brigPct = (t * 100).toFixed(0)
            return (
              <div
                key={i}
                className="hu-eq-bar"
                style={
                  {
                    '--bar-h': `${Math.max(3, Math.round(h * 100))}%`,
                    background: `color-mix(in srgb, var(--hu-green-dim) ${dimPct}%, var(--hu-green) ${brigPct}%)`
                  } as React.CSSProperties
                }
              />
            )
          })}
        </div>
        <div className="hu-eq-labels">
          {BAR_FREQS.slice(0, NUM_BARS).map((f, i) => {
            // Thin labels as bar count grows so they don't overlap on
            // the 5.5" screen.  Always show the first and last bar's label.
            const step =
              NUM_BARS <= 24 ? 2 : NUM_BARS <= 32 ? 3 : NUM_BARS <= 48 ? 4 : 6
            const show = i === 0 || i === NUM_BARS - 1 || i % step === 0
            return (
              <span key={i} className="hu-eq-label">
                {show ? f : ''}
              </span>
            )
          })}
        </div>
      </div>

      <div className="hu-quick-area">
        <button className="hu-quick-btn" onClick={onLaunchCarplay} aria-label="CarPlay">
          <img src={iconCarplay} alt="" className="hu-quick-btn-img" />
        </button>
        <button className="hu-quick-btn hu-quick-btn-disabled" disabled aria-label="Android Auto">
          <img src={iconMobile} alt="" className="hu-quick-btn-img" />
        </button>
        <button
          className="hu-quick-btn"
          onClick={() => onSelectView('phone')}
          aria-label="Recent Calls"
        >
          <img src={iconRecent} alt="" className="hu-quick-btn-img" />
        </button>
      </div>

      <div className="hu-info-area">
        <div className={`hu-music-art${isPlaying ? ' hu-art-pulse' : ''}`}>
          {artworkSrc ? (
            <img
              src={artworkSrc}
              alt=""
              crossOrigin="anonymous"
              className="hu-art-img"
              onError={(e) => {
                // Image was returned but failed to load (network, CORS, CORP).
                // Hide so the SVG fallback shows instead of broken alt text.
                ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                console.warn('[art] image failed to load', artworkSrc)
              }}
            />
          ) : (
            <svg
              viewBox="0 0 80 80"
              width="100%"
              height="100%"
              opacity="0.6"
              shapeRendering="crispEdges"
              preserveAspectRatio="xMidYMid meet"
            >
              <rect
                x="14"
                y="14"
                width="52"
                height="52"
                fill="none"
                stroke="#00ff0a"
                strokeWidth="3"
              />
              <rect x="36" y="34" width="8" height="14" fill="#00ff0a" />
              <rect x="44" y="32" width="2" height="14" fill="#00ff0a" />
            </svg>
          )}
        </div>
        <div className="hu-music-text">
          <div className="hu-music-via">
            {phoneConnected ? 'via Bluetooth' : 'Bluetooth Disconnected'}
          </div>
          <div className="hu-music-title">{title}</div>
          <div className="hu-music-artist">{artist}</div>
          <div className="hu-music-album">{album}</div>
        </div>
      </div>

      <div className="hu-controls-area">
        <div className="hu-progress-wrap">
          <div className="hu-progress-track" onClick={onSeek}>
            <div className="hu-progress-fill" style={{ width: `${progress * 100}%` }} />
          </div>
          <div className="hu-progress-times">
            <span>{formatTime(media.positionSec)}</span>
            <span>{media.durationSec > 0 ? formatTime(media.durationSec) : '--:--'}</span>
          </div>
        </div>

        <div className="hu-music-controls">
          <button
            className="hu-transport-btn"
            onClick={bt.mediaPrev}
            disabled={!phoneConnected}
            aria-label="Previous"
          >
            <svg viewBox="0 0 32 32" width="46" height="46">
              <polygon points="28,5 10,16 28,27" fill="currentColor" />
              <rect x="4" y="5" width="5" height="22" fill="currentColor" />
            </svg>
          </button>
          <button
            className="hu-transport-btn hu-play-btn"
            onClick={bt.mediaToggle}
            disabled={!phoneConnected}
            aria-label="Play/Pause"
          >
            {isPlaying ? (
              <svg viewBox="0 0 32 32" width="56" height="56">
                <rect x="5" y="4" width="9" height="24" fill="currentColor" />
                <rect x="18" y="4" width="9" height="24" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 32 32" width="56" height="56">
                <polygon points="6,3 28,16 6,29" fill="currentColor" />
              </svg>
            )}
          </button>
          <button
            className="hu-transport-btn"
            onClick={bt.mediaNext}
            disabled={!phoneConnected}
            aria-label="Next"
          >
            <svg viewBox="0 0 32 32" width="46" height="46">
              <polygon points="4,5 22,16 4,27" fill="currentColor" />
              <rect x="23" y="5" width="5" height="22" fill="currentColor" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Devices View ─────────────────────────────────────────────────────────────

function DevicesView({
  onLaunchCarplay,
  bt
}: {
  onLaunchCarplay: () => void
  bt: ReturnType<typeof useBluetooth>
}) {
  const [scanning, setScanning] = useState(false)

  const toggleScan = () => {
    const next = !scanning
    setScanning(next)
    bt.scan(next)
  }

  return (
    <div className="hu-screen">
      <div className="hu-sidebar">
        <div className="hu-panel-label">CONNECT VIA</div>

        <button className="hu-list-btn">
          <img src={iconMobile} alt="" className="hu-list-btn-icon" />
          <span>Phone</span>
        </button>

        <button className="hu-list-btn hu-list-btn-disabled" disabled>
          <img src={iconMobile} alt="" className="hu-list-btn-icon" style={{ opacity: 0.4 }} />
          <span>Android Auto</span>
          <span className="hu-opt-tag">—</span>
        </button>

        <button className="hu-list-btn" onClick={onLaunchCarplay}>
          <img src={iconCarplay} alt="" className="hu-list-btn-icon" />
          <span>Apple CarPlay</span>
          <span className="hu-opt-tag">▶</span>
        </button>

        <div style={{ flex: 1 }} />

        <button
          className={`hu-list-btn${scanning ? ' hu-list-btn-active' : ''}`}
          onClick={toggleScan}
        >
          <span>{scanning ? 'STOP SCAN' : 'SCAN'}</span>
        </button>
      </div>

      <div className="hu-main-area">
        <div className="hu-panel-label">DEVICES</div>
        {bt.devices.length === 0 ? (
          <div className="hu-empty-state">
            <div className="hu-empty-title">NO DEVICES</div>
            <div className="hu-empty-sub">
              {scanning ? 'Scanning…' : 'Tap SCAN to discover phones nearby.'}
            </div>
          </div>
        ) : (
          bt.devices.map((d) => <DeviceRow key={d.address} d={d} bt={bt} />)
        )}
      </div>
    </div>
  )
}

function DeviceRow({ d, bt }: { d: BtDevice; bt: ReturnType<typeof useBluetooth> }) {
  const action = d.connected ? () => bt.disconnect(d.address) : () => bt.connect(d.address)
  const label = d.connected ? 'CONN' : d.paired ? 'PAIRED' : 'NEW'
  return (
    <div className="hu-device-row">
      <svg viewBox="0 0 24 24" width="28" height="28" fill="#00ff0a" shapeRendering="crispEdges">
        <path d="M12 2l5 5-4 4 4 4-5 5V14l-3 3-1.5-1.5L11 12 7.5 8.5 9 7l3 3V2z" />
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span>{d.name || d.address}</span>
        {d.batteryPct !== undefined && (
          <span className="hu-device-sub">{Math.round(d.batteryPct)}% battery</span>
        )}
      </div>
      <span className="hu-device-tag">{label}</span>
      <button className="hu-list-btn hu-device-action" onClick={action}>
        {d.connected ? '✕' : '⟶'}
      </button>
    </div>
  )
}

// ─── Gauge widget ─────────────────────────────────────────────────────────────

const G_START = 120
const G_SWEEP = 300

interface GaugeWidgetProps {
  label: string
  value: number
  min: number
  max: number
  unit: string
  warnAbove?: number
}

function GaugeWidget({ label, value, min, max, unit, warnAbove }: GaugeWidgetProps) {
  const pct = Math.min(1, Math.max(0, (value - min) / (max - min)))
  const fill = pct * G_SWEEP
  const cx = 60,
    cy = 60,
    r = 42
  const warn = warnAbove !== undefined && value > warnAbove
  const green = warn ? '#ff6b1a' : '#00ff0a'
  const dim = warn ? '#8a3a0f' : '#008a06'

  const nDeg = G_START + pct * G_SWEEP
  const nTip = polarToCartesian(cx, cy, r - 6, nDeg)
  const nL = polarToCartesian(cx, cy, 7, nDeg + 90)
  const nR = polarToCartesian(cx, cy, 7, nDeg - 90)

  const ticks = Array.from({ length: 6 }, (_, i) => {
    const deg = G_START + (i / 5) * G_SWEEP
    return { o: polarToCartesian(cx, cy, r, deg), i: polarToCartesian(cx, cy, r - 7, deg) }
  })

  const displayVal = value % 1 === 0 ? String(value) : value.toFixed(1)

  return (
    <div className="hu-gauge-wrap">
      <svg viewBox="0 0 120 112" width="260" height="243" shapeRendering="crispEdges">
        <path
          d={gaugeArc(cx, cy, r, G_START, G_SWEEP)}
          fill="none"
          stroke={dim}
          strokeWidth={4.5}
          strokeLinecap="butt"
        />
        {fill > 0 && (
          <path
            d={gaugeArc(cx, cy, r, G_START, fill)}
            fill="none"
            stroke={green}
            strokeWidth={4.5}
            strokeLinecap="butt"
          />
        )}
        {ticks.map((t, i) => (
          <line
            key={i}
            x1={t.o.x}
            y1={t.o.y}
            x2={t.i.x}
            y2={t.i.y}
            stroke={dim}
            strokeWidth="1.5"
          />
        ))}
        <polygon
          points={`${nTip.x.toFixed(1)},${nTip.y.toFixed(1)} ${nL.x.toFixed(1)},${nL.y.toFixed(
            1
          )} ${nR.x.toFixed(1)},${nR.y.toFixed(1)}`}
          fill={green}
        />
        <rect x={cx - 4} y={cy - 4} width="8" height="8" fill={green} />
        <text
          x={cx}
          y={cy + 20}
          textAnchor="middle"
          fill={green}
          fontSize={13}
          fontFamily="'VT323'"
        >
          {displayVal}
        </text>
        <text x={cx} y={cy + 31} textAnchor="middle" fill={dim} fontSize={8.5} fontFamily="'VT323'">
          {unit}
        </text>
      </svg>
      <div className="hu-gauge-label" style={{ color: warn ? '#ff6b1a' : undefined }}>
        {label}
      </div>
    </div>
  )
}

function GaugesView({ vehicleData }: { vehicleData?: VehicleData }) {
  const vd = vehicleData ?? {}
  return (
    <div className="hu-screen">
      <div className="hu-sidebar hu-sidebar-slim">
        <div className="hu-panel-label">SENSORS</div>
        <div className="hu-gauge-sidebar">
          <div className="hu-gauge-text-row">
            <span className="hu-gauge-text-label">OIL PRESS</span>
            <span className="hu-gauge-text-value">
              {vd.oilPressurePsi ?? 45}
              <small className="hu-gauge-text-unit">PSI</small>
            </span>
          </div>
          <div className="hu-gauge-text-row">
            <span className="hu-gauge-text-label">BATTERY</span>
            <span className="hu-gauge-text-value">
              {vd.batteryV ?? 12.6}
              <small className="hu-gauge-text-unit">V</small>
            </span>
          </div>
        </div>
      </div>

      <div className="hu-main-area">
        <div className="hu-gauges">
          <GaugeWidget
            label="OIL TEMP"
            value={vd.oilTempC ?? 90}
            min={40}
            max={150}
            unit="°C"
            warnAbove={120}
          />
          <GaugeWidget label="SPEED" value={vd.speedKmh ?? 0} min={0} max={260} unit="km/h" />
          <GaugeWidget
            label="RPM"
            value={vd.rpm ?? 800}
            min={0}
            max={8000}
            unit="RPM"
            warnAbove={6500}
          />
        </div>
      </div>
    </div>
  )
}

// ─── Phone View ───────────────────────────────────────────────────────────────

type PhoneTab = 'contacts' | 'recent' | 'call'

const PHONE_TAB_ICONS: Record<PhoneTab, string> = {
  contacts: iconContacts,
  recent: iconRecent,
  call: iconPhone
}
const PHONE_TAB_LABEL: Record<PhoneTab, string> = {
  contacts: 'CONTACTS',
  recent: 'RECENT',
  call: 'CALL'
}

// Recent-calls store lives entirely on the renderer for now — every outgoing
// dial we push and every incoming/missed event we record.  Persisting via
// localStorage so the list survives across reloads.
interface RecentEntry {
  name?: string
  number: string
  time: number
  dir: 'in' | 'out' | 'miss'
}

function loadRecents(): RecentEntry[] {
  try {
    return JSON.parse(localStorage.getItem('hu.recents') || '[]')
  } catch {
    return []
  }
}
function saveRecents(r: RecentEntry[]) {
  try {
    localStorage.setItem('hu.recents', JSON.stringify(r.slice(0, 50)))
  } catch {
    /* ignore */
  }
}

function formatRecentTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const yesterday = new Date()
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

function PhoneView({
  bt,
  recents
}: {
  bt: ReturnType<typeof useBluetooth>
  recents: RecentEntry[]
}) {
  const [tab, setTab] = useState<PhoneTab>('contacts')
  const [dial, setDial] = useState('')
  // Currently-selected contact / recent — tap to select, tap CALL to dial.
  // Switching tabs clears the selection so it doesn't bleed across screens.
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)
  const [selectedRecentIdx, setSelectedRecentIdx] = useState<number | null>(null)

  useEffect(() => {
    setSelectedContactId(null)
    setSelectedRecentIdx(null)
  }, [tab])

  const dialMatches = useMemo(
    () => filterContactsByDial(bt.contacts.contacts, dial).slice(0, 8),
    [bt.contacts.contacts, dial]
  )

  const onCallContact = (c: Contact) => {
    const num = c.numbers[0]?.number
    if (num) bt.dial(num)
  }

  const onCallDial = () => {
    if (!dial) return
    bt.dial(dial)
  }

  return (
    <div className="hu-screen">
      <div className="hu-sidebar">
        <div className="hu-panel-label">PHONE</div>
        <div className="hu-phone-sidebar-tabs">
          {(['contacts', 'recent', 'call'] as PhoneTab[]).map((t) => (
            <button
              key={t}
              className={`hu-list-btn${tab === t ? ' hu-list-btn-active' : ''}`}
              onClick={() => setTab(t)}
            >
              <img src={PHONE_TAB_ICONS[t]} alt="" className="hu-list-btn-icon" />
              <span>{PHONE_TAB_LABEL[t]}</span>
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {tab === 'contacts' && bt.phone.connected && (
          <button className="hu-list-btn" onClick={bt.syncContacts}>
            <span>{bt.contacts.syncing ? 'SYNCING…' : 'SYNC'}</span>
          </button>
        )}
      </div>

      <div className="hu-main-area">
        <div className="hu-phone-content">
          {!bt.phone.connected && (
            <div className="hu-empty-state">
              <div className="hu-empty-title">NO PHONE CONNECTED</div>
              <div className="hu-empty-sub">
                Pair a phone in the Devices screen to use contacts and calling.
              </div>
            </div>
          )}

          {bt.phone.connected && tab === 'contacts' && (
            <ContactsList
              contacts={bt.contacts.contacts}
              synced={bt.contacts.synced}
              syncing={bt.contacts.syncing}
              lastError={bt.contacts.lastError}
              selectedId={selectedContactId}
              onSelect={(id) => setSelectedContactId((prev) => (prev === id ? null : id))}
              onCall={onCallContact}
            />
          )}

          {bt.phone.connected && tab === 'recent' && (
            <RecentsList
              recents={recents}
              selectedIdx={selectedRecentIdx}
              onSelect={(i) => setSelectedRecentIdx((prev) => (prev === i ? null : i))}
              onCall={(n) => bt.dial(n)}
            />
          )}

          {bt.phone.connected && tab === 'call' && (
            <DialerView
              dial={dial}
              setDial={setDial}
              matches={dialMatches}
              onCall={onCallDial}
              onCallContact={onCallContact}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function ContactsList({
  contacts,
  synced,
  syncing,
  lastError,
  selectedId,
  onSelect,
  onCall
}: {
  contacts: Contact[]
  synced: boolean
  syncing: boolean
  lastError?: string
  selectedId: string | null
  onSelect: (id: string) => void
  onCall: (c: Contact) => void
}) {
  if (lastError && !syncing) {
    return (
      <div className="hu-empty-state">
        <div className="hu-empty-title">SYNC FAILED</div>
        <div className="hu-empty-sub">{lastError}</div>
        <div className="hu-empty-sub" style={{ fontSize: 22, opacity: 0.7 }}>
          On iPhone: Settings → Bluetooth → tap (i) next to the head unit → enable Sync Contacts.
          Then tap SYNC again.
        </div>
      </div>
    )
  }
  if (!synced && !syncing && contacts.length === 0) {
    return (
      <div className="hu-empty-state">
        <div className="hu-empty-title">CONTACTS NOT SYNCED</div>
        <div className="hu-empty-sub">
          Tap SYNC in the sidebar to import contacts from your phone (PBAP).
        </div>
      </div>
    )
  }
  if (syncing && contacts.length === 0) {
    return (
      <div className="hu-empty-state">
        <div className="hu-empty-title">SYNCING…</div>
      </div>
    )
  }
  if (contacts.length === 0) {
    return (
      <div className="hu-empty-state">
        <div className="hu-empty-title">NO CONTACTS</div>
      </div>
    )
  }

  // Group by first letter (A-Z, then '#' for everything else).
  const grouped: Record<string, Contact[]> = {}
  for (const c of contacts) {
    const ch = (c.name[0] ?? '#').toUpperCase()
    const key = /[A-Z]/.test(ch) ? ch : '#'
    ;(grouped[key] ??= []).push(c)
  }
  const sections = Object.keys(grouped).sort((a, b) => {
    if (a === '#') return 1
    if (b === '#') return -1
    return a.localeCompare(b)
  })

  return (
    <div className="hu-list">
      {sections.map((letter) => (
        <div key={letter}>
          <div className="hu-list-section">{letter}</div>
          {grouped[letter].map((c) => (
            <ContactRow
              key={c.id}
              contact={c}
              selected={c.id === selectedId}
              onSelect={() => onSelect(c.id)}
              onCall={() => onCall(c)}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function ContactRow({
  contact,
  selected,
  onSelect,
  onCall
}: {
  contact: Contact
  selected: boolean
  onSelect: () => void
  onCall: () => void
}) {
  return (
    <div className={`hu-list-row${selected ? ' hu-list-row-selected' : ''}`} onClick={onSelect}>
      <div className="hu-avatar">
        {contact.photo ? (
          <img src={contact.photo} alt="" className="hu-avatar-img" />
        ) : (
          contact.name[0]
        )}
      </div>
      <div className="hu-list-info">
        <div className="hu-list-name">{contact.name}</div>
        <div className="hu-list-sub">{contact.numbers[0]?.number ?? ''}</div>
      </div>
      {selected && (
        <button
          className="hu-call-icon-btn"
          onClick={(e) => {
            e.stopPropagation()
            onCall()
          }}
          aria-label="Call"
        >
          <img src={iconPhone} alt="call" className="hu-call-icon-img" />
        </button>
      )}
    </div>
  )
}

function RecentsList({
  recents,
  selectedIdx,
  onSelect,
  onCall
}: {
  recents: RecentEntry[]
  selectedIdx: number | null
  onSelect: (i: number) => void
  onCall: (n: string) => void
}) {
  if (recents.length === 0) {
    return (
      <div className="hu-empty-state">
        <div className="hu-empty-title">NO RECENT CALLS</div>
        <div className="hu-empty-sub">Calls you make or receive will appear here.</div>
      </div>
    )
  }
  return (
    <div className="hu-list">
      {recents.map((r, i) => {
        const selected = i === selectedIdx
        return (
          <div
            key={i}
            className={`hu-list-row${selected ? ' hu-list-row-selected' : ''}`}
            onClick={() => onSelect(i)}
          >
            <span className={`hu-call-dir hu-call-${r.dir}`}>
              {r.dir === 'miss' ? '↘' : r.dir === 'in' ? '↙' : '↗'}
            </span>
            <div className="hu-list-info">
              <div className="hu-list-name">{r.name ?? 'Unknown'}</div>
              <div className="hu-list-sub">{r.number}</div>
            </div>
            <span className="hu-call-time">{formatRecentTime(r.time)}</span>
            {selected && (
              <button
                className="hu-call-icon-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  onCall(r.number)
                }}
                aria-label="Call"
              >
                <img src={iconPhone} alt="call" className="hu-call-icon-img" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

// T9-style letters shown below each digit on the dialer numpad.  Also
// used by the contact filter (see filterContactsByDial) so typing "262"
// matches both phone numbers containing 262 and names like "Bob".
const KEY_LETTERS: Record<string, string> = {
  '1': '',
  '2': 'ABC',
  '3': 'DEF',
  '4': 'GHI',
  '5': 'JKL',
  '6': 'MNO',
  '7': 'PQRS',
  '8': 'TUV',
  '9': 'WXYZ',
  '*': '',
  '0': '+',
  '#': ''
}

function DialerView({
  dial,
  setDial,
  matches,
  onCall,
  onCallContact
}: {
  dial: string
  setDial: (v: string | ((p: string) => string)) => void
  matches: Contact[]
  onCall: () => void
  onCallContact: (c: Contact) => void
}) {
  const [matchSelected, setMatchSelected] = useState<string | null>(null)

  return (
    <div className="hu-dialer">
      <div className="hu-numpad">
        <div className="hu-dial-display">
          {dial || <span className="hu-dial-placeholder">Enter number</span>}
        </div>
        {[
          ['1', '2', '3'],
          ['4', '5', '6'],
          ['7', '8', '9'],
          ['*', '0', '#']
        ].map((row, ri) => (
          <div key={ri} className="hu-numpad-row">
            {row.map((k) => (
              <button key={k} className="hu-numpad-key" onClick={() => setDial((p) => p + k)}>
                <span className="hu-numpad-digit">{k}</span>
                {KEY_LETTERS[k] && <span className="hu-numpad-letters">{KEY_LETTERS[k]}</span>}
              </button>
            ))}
          </div>
        ))}
        <div className="hu-numpad-row">
          <button
            className="hu-numpad-key hu-call-green"
            onClick={onCall}
            disabled={!dial}
            aria-label="Call"
          >
            <img src={iconPhone} alt="call" className="hu-numpad-call-icon" />
          </button>
          <button className="hu-numpad-key" onClick={() => setDial((p) => p.slice(0, -1))}>
            <span className="hu-numpad-digit">⌫</span>
          </button>
        </div>
      </div>

      <div className="hu-dial-matches">
        <div className="hu-panel-label" style={{ marginBottom: 12 }}>
          {dial ? `MATCHES (${matches.length})` : 'CONTACTS'}
        </div>
        {matches.length === 0 ? (
          <div className="hu-empty-sub" style={{ paddingTop: 16 }}>
            No matches
          </div>
        ) : (
          matches.map((c) => {
            const selected = c.id === matchSelected
            return (
              <div
                key={c.id}
                className={`hu-list-row${selected ? ' hu-list-row-selected' : ''}`}
                onClick={() => setMatchSelected((prev) => (prev === c.id ? null : c.id))}
              >
                <div className="hu-avatar">{c.name[0]}</div>
                <div className="hu-list-info">
                  <div className="hu-list-name">{c.name}</div>
                  <div className="hu-list-sub">{c.numbers[0]?.number}</div>
                </div>
                {selected && (
                  <button
                    className="hu-call-icon-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      onCallContact(c)
                    }}
                    aria-label="Call"
                  >
                    <img src={iconPhone} alt="call" className="hu-call-icon-img" />
                  </button>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ─── In-call screen (full overlay) ───────────────────────────────────────────

function InCallScreen({
  call,
  bt,
  onMinimise
}: {
  call: CallState
  bt: ReturnType<typeof useBluetooth>
  onMinimise: () => void
}) {
  const name = call.contact?.name ?? 'Unknown'
  const num = call.contact?.number ?? ''
  return (
    <div className="hu-incall">
      <div className="hu-incall-top">
        <div className="hu-incall-status">
          {call.status === 'dialing'
            ? 'DIALING'
            : call.status === 'incoming'
            ? 'INCOMING'
            : 'IN CALL'}
        </div>
        <div className="hu-incall-duration">
          {call.status === 'active' ? formatDuration(call.durationSec) : ''}
        </div>
      </div>

      <div className="hu-incall-photo">
        {call.contact?.photo ? (
          <img src={call.contact.photo} alt="" className="hu-incall-photo-img" />
        ) : (
          <div className="hu-incall-photo-fallback">{(name[0] || '?').toUpperCase()}</div>
        )}
      </div>

      <div className="hu-incall-name">{name}</div>
      <div className="hu-incall-num">{num}</div>

      <div className="hu-incall-buttons">
        <button
          className={`hu-incall-btn${call.muted ? ' hu-incall-btn-on' : ''}`}
          onClick={bt.toggleMute}
        >
          <span className="hu-incall-btn-glyph">{call.muted ? 'UN-MUTE' : 'MUTE'}</span>
        </button>
        <button className="hu-incall-btn hu-incall-hangup" onClick={bt.hangup}>
          <img src={iconPhone} alt="" className="hu-incall-btn-img hu-incall-hangup-icon" />
        </button>
        <button className="hu-incall-btn" onClick={onMinimise}>
          <span className="hu-incall-btn-glyph">SCREENS</span>
        </button>
      </div>
    </div>
  )
}

// ─── Incoming call + in-call popup (floats over any screen) ──────────────────

function CallPopup({
  call,
  bt,
  onOpen
}: {
  call: CallState
  bt: ReturnType<typeof useBluetooth>
  onOpen: () => void
}) {
  const name = call.contact?.name ?? 'Unknown'
  const num = call.contact?.number ?? ''

  if (call.status === 'incoming') {
    return (
      <div className="hu-call-popup hu-call-popup-incoming">
        <div className="hu-call-popup-photo">
          {call.contact?.photo ? (
            <img src={call.contact.photo} alt="" className="hu-call-popup-photo-img" />
          ) : (
            <div className="hu-call-popup-photo-fallback">{(name[0] || '?').toUpperCase()}</div>
          )}
        </div>
        <div className="hu-call-popup-body">
          <div className="hu-call-popup-status">INCOMING CALL</div>
          <div className="hu-call-popup-name">{name}</div>
          <div className="hu-call-popup-num">{num}</div>
        </div>
        <div className="hu-call-popup-actions">
          <button className="hu-call-popup-btn hu-call-popup-reject" onClick={bt.reject}>
            ✕
          </button>
          <button className="hu-call-popup-btn hu-call-popup-accept" onClick={bt.answer}>
            <img src={iconPhone} alt="" className="hu-call-popup-icon" />
          </button>
        </div>
      </div>
    )
  }

  // active / dialing — small persistent strip with the call info, click to open
  return (
    <div className="hu-call-popup hu-call-popup-active" onClick={onOpen}>
      <div className="hu-call-popup-photo">
        {call.contact?.photo ? (
          <img src={call.contact.photo} alt="" className="hu-call-popup-photo-img" />
        ) : (
          <div className="hu-call-popup-photo-fallback">{(name[0] || '?').toUpperCase()}</div>
        )}
      </div>
      <div className="hu-call-popup-body">
        <div className="hu-call-popup-status">
          {call.status === 'dialing' ? 'DIALING' : 'IN CALL'} · {formatDuration(call.durationSec)}
        </div>
        <div className="hu-call-popup-name">{name}</div>
      </div>
      <button
        className="hu-call-popup-btn hu-call-popup-reject"
        onClick={(e) => {
          e.stopPropagation()
          bt.hangup()
        }}
      >
        ✕
      </button>
    </div>
  )
}

// ─── HeadUnit root ────────────────────────────────────────────────────────────

export default function HeadUnit({ onLaunchCarplay, onOpenSettings, vehicleData }: HeadUnitProps) {
  const bt = useBluetooth()
  const [activeView, setActiveView] = useState<ViewName>('music')
  const [prevView, setPrevView] = useState<ViewName | null>(null)
  const [slideDir, setSlideDir] = useState<'left' | 'right'>('right')
  const [ss, setSS] = useState(getScaleState)
  const [recents, setRecents] = useState<RecentEntry[]>(loadRecents)
  // Whether the in-call full screen is showing (vs. the small popup).
  // Auto-opens when a call becomes active, can be minimised back.
  const [callFull, setCallFull] = useState(false)

  // Open the full call screen when an active call appears; reset when idle.
  useEffect(() => {
    if (bt.call.status === 'active' || bt.call.status === 'dialing') setCallFull(true)
    if (bt.call.status === 'idle') setCallFull(false)
  }, [bt.call.status])

  // Session-based call logging: open a session when a call appears (idle →
  // non-idle), remember whether it ever went to active, close the session
  // when it goes back to idle and push one recents entry with the right
  // direction.  This catches every call shape — answered outgoing, answered
  // incoming, missed incoming, AND outgoing-never-answered (which the
  // earlier dialing→active-only logic dropped).
  const lastCallRef = useRef<CallState>(bt.call)
  const sessionRef = useRef<{
    dir: 'in' | 'out'
    name?: string
    number: string
    started: number
    answered: boolean
  } | null>(null)

  useEffect(() => {
    const prev = lastCallRef.current
    const curr = bt.call

    // Open a session when a call appears.
    if (prev.status === 'idle' && curr.status !== 'idle' && curr.contact?.number) {
      sessionRef.current = {
        dir: curr.status === 'incoming' ? 'in' : 'out',
        name: curr.contact.name,
        number: curr.contact.number,
        started: Date.now(),
        answered: curr.status === 'active'
      }
    }
    // Mark answered the moment we see active.
    if (curr.status === 'active' && sessionRef.current) sessionRef.current.answered = true
    // Update contact name if we learn it after the call started.
    if (curr.contact?.name && sessionRef.current && !sessionRef.current.name) {
      sessionRef.current.name = curr.contact.name
    }
    // Close the session on idle.
    if (prev.status !== 'idle' && curr.status === 'idle' && sessionRef.current) {
      const s = sessionRef.current
      const dir: RecentEntry['dir'] = s.dir === 'in' && !s.answered ? 'miss' : s.dir
      pushRecent({ name: s.name, number: s.number, time: s.started, dir })
      sessionRef.current = null
    }

    lastCallRef.current = curr
  }, [bt.call])

  const pushRecent = (entry: RecentEntry) => {
    setRecents((prev) => {
      const next = [entry, ...prev].slice(0, 50)
      saveRecents(next)
      return next
    })
  }

  useEffect(() => {
    const onResize = () => setSS(getScaleState())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const handleSelect = useCallback((v: ViewName) => {
    setActiveView((curr) => {
      if (v === curr) return curr
      const ci = CYCLE.indexOf(curr)
      const ni = CYCLE.indexOf(v)
      setSlideDir(ni > ci ? 'left' : 'right')
      setPrevView(curr)
      return v
    })
  }, [])

  useEffect(() => {
    if (prevView === null) return
    const t = setTimeout(() => setPrevView(null), 360)
    return () => clearTimeout(t)
  }, [prevView, activeView])

  const renderView = (v: ViewName) => {
    switch (v) {
      case 'music':
        return <MusicView onLaunchCarplay={onLaunchCarplay} onSelectView={handleSelect} bt={bt} />
      case 'devices':
        return <DevicesView onLaunchCarplay={onLaunchCarplay} bt={bt} />
      case 'gauges':
        return <GaugesView vehicleData={vehicleData} />
      case 'phone':
        return <PhoneView bt={bt} recents={recents} />
    }
  }

  const outClass = slideDir === 'left' ? 'hu-slide-out-left' : 'hu-slide-out-right'
  const inClass = slideDir === 'left' ? 'hu-slide-in-right' : 'hu-slide-in-left'

  const showFullCall = callFull && (bt.call.status === 'active' || bt.call.status === 'dialing')
  const showPopup = !showFullCall && bt.call.status !== 'idle'

  return (
    <div className="hu-viewport">
      <div
        className="hu-canvas"
        style={{ transform: `translate(${ss.ox}px, ${ss.oy}px) scale(${ss.scale})` }}
      >
        <div className="hu-root">
          <div className="hu-scanlines" aria-hidden="true" />
          <HUHeader phone={bt.phone} />
          <main className="hu-content">
            <div className="hu-screen-stack">
              {prevView && (
                <div key={`out-${prevView}`} className={`hu-screen-slot ${outClass}`}>
                  {renderView(prevView)}
                </div>
              )}
              <div key={`in-${activeView}`} className={`hu-screen-slot ${prevView ? inClass : ''}`}>
                {renderView(activeView)}
              </div>
            </div>
          </main>
          <NavBar active={activeView} onSelect={handleSelect} onSettings={onOpenSettings} />

          {showFullCall && (
            <div className="hu-incall-overlay">
              <InCallScreen call={bt.call} bt={bt} onMinimise={() => setCallFull(false)} />
            </div>
          )}
          {showPopup && <CallPopup call={bt.call} bt={bt} onOpen={() => setCallFull(true)} />}
        </div>
      </div>
    </div>
  )
}
