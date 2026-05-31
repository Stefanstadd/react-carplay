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
  type RecentCall,
  type PhoneState,
  type CallState,
  type BtDevice
} from './bluetooth'

// ─── MarqueeText: auto-scrolling text when it overflows its container ─────
// Measures whether the inner span overflows and, if so, runs a ping-pong
// CSS animation that translates it from 0 to -overflowPx.  No animation
// when the text fits.
function MarqueeText({
  children, className, speedPxPerSec = 60,
}: {
  children: React.ReactNode
  className?: string
  speedPxPerSec?: number
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(0)

  useEffect(() => {
    const measure = () => {
      const w = wrapRef.current
      const t = textRef.current
      if (!w || !t) return
      const o = t.scrollWidth - w.clientWidth
      setOverflow(o > 4 ? o : 0)
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [children])

  const styleObj: React.CSSProperties | undefined =
    overflow > 0
      ? ({
          ['--marquee-end' as any]: `-${overflow}px`,
          ['--marquee-dur' as any]: `${Math.max(6, (overflow / speedPxPerSec) * 2.4)}s`,
        } as React.CSSProperties)
      : undefined

  return (
    <div ref={wrapRef} className={`hu-marquee-wrap ${className ?? ''}`}>
      <span
        ref={textRef}
        className={`hu-marquee-text${overflow > 0 ? ' is-scrolling' : ''}`}
        style={styleObj}
      >
        {children}
      </span>
    </div>
  )
}

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
  // Box is 25.5 wide between x=0.75..26.25.  Inside the 1.5px border the
  // fillable area starts at x=2 and ends at x=25, so max width 23.
  const fillW = Math.max(0, (battery / 100) * 23).toFixed(1)
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
// All tweakable knobs live in headunit.config.ts — edit there, not here.

import {
  VIZ_CONFIG,
  ALBUM_ART_SIZE,
  TITLE_SCROLL_SPEED,
  QUICK_BTN_ICON_SIZE,
  QUICK_BTN_CELL_SIZE,
} from './headunit.config'
import { useAudioVisualizer, barColor } from './audioVisualizer'

// Album art fallback chain.  AVRCP rarely carries cover art (and BlueZ
// doesn't expose what little there is), so we look it up online: iTunes
// first (best match for major-label music), then Deezer (covers a lot of
// what iTunes misses, including Spotify-exclusive / Canvas tracks).
// Several query shapes are tried per service before giving up.
//
// The cache is persisted to localStorage (URL strings only, no image bytes).
// On next launch, Electron's Chromium disk cache serves those URLs without
// a network round-trip, so previously-seen art still shows when offline.
const ART_CACHE_LS_KEY = 'hu.artCache.v1'
const ART_CACHE_MAX    = 400

const artCache: Map<string, string | null> = (() => {
  try {
    const raw = localStorage.getItem(ART_CACHE_LS_KEY)
    if (raw) return new Map(JSON.parse(raw) as [string, string | null][])
  } catch { /* corrupted */ }
  return new Map()
})()

function persistArtEntry(key: string, url: string) {
  artCache.set(key, url)
  try {
    // Map preserves insertion order — keep the newest MAX entries
    const entries = Array.from(artCache.entries()).filter(([, v]) => v !== null)
    const trimmed = entries.length > ART_CACHE_MAX ? entries.slice(-ART_CACHE_MAX) : entries
    localStorage.setItem(ART_CACHE_LS_KEY, JSON.stringify(trimmed))
  } catch { /* quota exceeded — skip persist */ }
}

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
          if (!cancelled) { persistArtEntry(key, hit); setArt(hit) }
          return
        }
      }
      for (const q of queries) {
        const hit = await searchDeezer(q)
        if (hit) {
          console.log('[art] Deezer hit for query:', q)
          if (!cancelled) { persistArtEntry(key, hit); setArt(hit) }
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
  const phoneConnected = bt.phone.connected
  const media = bt.media
  const isPlaying = media.playing && phoneConnected
  const artworkSrc = useArt(media.title, media.artist, media.album, media.artworkSrc)

  // Professional spectrum analyser — see audioVisualizer.ts.  Reads PCM
  // from the main-process parec stream, runs a 4096-pt windowed FFT,
  // returns smoothed bar heights + peak-hold positions every animation
  // frame.  All tuning lives in VIZ_CONFIG (headunit.config.ts).
  const { bars: vizBars, peaks: vizPeaks, labels: vizLabels } = useAudioVisualizer(VIZ_CONFIG)

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
          {Array.from({ length: VIZ_CONFIG.bars }, (_, i) => {
            const h = vizBars[i] || 0
            const p = vizPeaks[i] || 0
            const bg = barColor(h, VIZ_CONFIG.colorCurve)
            const glowPx = (4 + 14 * h) * VIZ_CONFIG.glowStrength
            const glowAlpha = (0.18 + 0.5 * h) * VIZ_CONFIG.glowStrength
            return (
              <div key={i} className="hu-eq-bar-wrap">
                <div
                  className="hu-eq-bar"
                  style={{
                    height: `${Math.max(2, h * 100)}%`,
                    background: bg,
                    boxShadow:
                      glowPx > 0.1
                        ? `0 0 ${glowPx.toFixed(1)}px rgba(0, 255, 10, ${glowAlpha.toFixed(2)})`
                        : 'none',
                  }}
                />
                {p > 0.02 && (
                  <div
                    className="hu-eq-peak"
                    style={{ bottom: `${(p * 100).toFixed(2)}%` }}
                  />
                )}
              </div>
            )
          })}
        </div>
        {VIZ_CONFIG.showFrequencyLabels && (
          <div className="hu-eq-labels">
            {vizLabels.map((f, i) => {
              // Thin labels as bar count grows so they don't overlap on
              // the 5.5" screen.  Always show the first and last bar's label.
              const n = VIZ_CONFIG.bars
              const step = n <= 24 ? 2 : n <= 32 ? 3 : n <= 48 ? 4 : 6
              const show = i === 0 || i === n - 1 || i % step === 0
              return (
                <span key={i} className="hu-eq-label">
                  {show ? f : ''}
                </span>
              )
            })}
          </div>
        )}
      </div>

      <div
        className="hu-quick-area hu-quick-grid"
        style={{
          ['--quick-cell' as any]: `${QUICK_BTN_CELL_SIZE}px`,
          ['--quick-icon' as any]: `${QUICK_BTN_ICON_SIZE}px`,
        }}
      >
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
        <button
          className="hu-quick-btn"
          onClick={() => onSelectView('phone')}
          aria-label="Contacts"
        >
          <img src={iconContacts} alt="" className="hu-quick-btn-img" />
        </button>
      </div>

      <div className="hu-info-area">
        <div
          className={`hu-music-art${isPlaying ? ' hu-art-pulse' : ''}`}
          style={{ ['--art-size' as any]: `${ALBUM_ART_SIZE}px` }}
        >
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
          <MarqueeText className="hu-music-title" speedPxPerSec={TITLE_SCROLL_SPEED}>{title}</MarqueeText>
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
            <span>{media.durationSec > 0 ? formatTime(media.positionSec) : '--:--'}</span>
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

type PhoneTab = 'recent' | 'call'

const PHONE_TAB_ICONS: Record<PhoneTab, string> = {
  recent: iconRecent,
  call: iconPhone
}
const PHONE_TAB_LABEL: Record<PhoneTab, string> = {
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
}: {
  bt: ReturnType<typeof useBluetooth>
}) {
  const scroll = useScrollContainer<HTMLDivElement>()
  const [tab, setTab] = useState<PhoneTab>('call')
  const [dial, setDial] = useState('')
  // Currently-selected match/recent — tap to select, tap CALL to dial.
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null)
  const [selectedRecentIdx, setSelectedRecentIdx] = useState<number | null>(null)

  useEffect(() => {
    setSelectedMatchId(null)
    setSelectedRecentIdx(null)
  }, [tab])

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
          {(['recent', 'call'] as PhoneTab[]).map((t) => (
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

        {bt.phone.connected && (
          <button
            className="hu-list-btn"
            onClick={() => {
              bt.syncContacts()
              bt.syncRecents()
            }}
          >
            <span>
              {bt.contacts.syncing || bt.recents.syncing ? 'SYNCING…' : 'SYNC'}
            </span>
          </button>
        )}
      </div>

      <div className="hu-main-area">
        <div className="hu-phone-content" ref={scroll.ref} {...scroll.handlers}>
          {!bt.phone.connected && (
            <div className="hu-empty-state">
              <div className="hu-empty-title">NO PHONE CONNECTED</div>
              <div className="hu-empty-sub">
                Pair a phone in the Devices screen to use the dialer + recent calls.
              </div>
            </div>
          )}

          {bt.phone.connected && tab === 'recent' && (
            <RecentsList
              recents={bt.recents.calls}
              syncing={bt.recents.syncing}
              synced={bt.recents.synced}
              lastError={bt.recents.lastError}
              selectedIdx={selectedRecentIdx}
              onSelect={(i) => setSelectedRecentIdx((prev) => (prev === i ? null : i))}
              onCall={(n) => bt.dial(n)}
            />
          )}

          {bt.phone.connected && tab === 'call' && (
            <DialerView
              dial={dial}
              setDial={setDial}
              contacts={bt.contacts.contacts}
              selectedMatchId={selectedMatchId}
              onSelectMatch={(id) =>
                setSelectedMatchId((prev) => (prev === id ? null : id))
              }
              onCall={onCallDial}
              onCallContact={onCallContact}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// Manual touch scroll for containers that sit under the global
// touchAction:'none' (set on the App root to protect the CarPlay canvas).
// Native browser scroll is disabled there; we re-implement it via pointer
// events.  Once a scroll is detected (> 8 px vertical) the container calls
// setPointerCapture so future move/up events bypass the child rows entirely —
// that prevents any useTap from firing at the end of a drag.
function useScrollContainer<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null)
  const st = useRef({
    active: false, captured: false, pointerId: -1,
    startY: 0, startScroll: 0, lastY: 0, lastT: 0, vel: 0, rafId: 0,
  })

  const stopMomentum = () => {
    if (st.current.rafId) cancelAnimationFrame(st.current.rafId)
    st.current.rafId = 0
  }

  const onPointerDown = useCallback((e: React.PointerEvent<T>) => {
    stopMomentum()
    const c = st.current
    c.active = true; c.captured = false
    c.pointerId = e.pointerId
    c.startY = c.lastY = e.clientY
    c.lastT = e.timeStamp; c.vel = 0
    c.startScroll = ref.current?.scrollTop ?? 0
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent<T>) => {
    const c = st.current
    if (!c.active || e.pointerId !== c.pointerId) return
    const dt = e.timeStamp - c.lastT
    if (dt > 0) c.vel = (e.clientY - c.lastY) / dt
    c.lastY = e.clientY; c.lastT = e.timeStamp
    const totalDy = e.clientY - c.startY
    if (!c.captured && Math.abs(totalDy) > 8) {
      ref.current?.setPointerCapture(e.pointerId)
      c.captured = true
    }
    if (c.captured && ref.current) ref.current.scrollTop = c.startScroll - totalDy
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent<T>) => {
    const c = st.current
    if (!c.active || e.pointerId !== c.pointerId) return
    c.active = false
    if (!c.captured || !ref.current) return
    const el = ref.current
    let v = c.vel * 16  // px per frame at ~60 fps
    const tick = () => {
      el.scrollTop -= v
      v *= 0.92
      c.rafId = Math.abs(v) > 0.5 ? requestAnimationFrame(tick) : 0
    }
    c.rafId = requestAnimationFrame(tick)
  }, [])

  const onPointerCancel = useCallback((e: React.PointerEvent<T>) => {
    if (e.pointerId === st.current.pointerId) st.current.active = false
    stopMomentum()
  }, [])

  return { ref, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel } }
}

// Distinguishes a tap (finger down + up in place) from a scroll (finger
// moves > 8 px vertically). Replaces onClick on list rows so that a scroll
// gesture never accidentally selects an item.
function useTap(onTap: () => void) {
  const startY = useRef(0)
  const scrolled = useRef(false)
  return {
    onPointerDown(e: React.PointerEvent) {
      startY.current = e.clientY
      scrolled.current = false
    },
    onPointerMove(e: React.PointerEvent) {
      if (Math.abs(e.clientY - startY.current) > 8) scrolled.current = true
    },
    onPointerUp() {
      if (!scrolled.current) onTap()
    },
    onPointerCancel() {
      scrolled.current = true
    },
  }
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
  const tap = useTap(onSelect)
  return (
    <div className={`hu-list-row${selected ? ' hu-list-row-selected' : ''}`} {...tap}>
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
          onClick={(e) => { e.stopPropagation(); onCall() }}
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
  syncing,
  synced,
  lastError,
  onCall
}: {
  recents: RecentCall[]
  syncing: boolean
  synced: boolean
  lastError?: string
  selectedIdx: number | null
  onSelect: (i: number) => void
  onCall: (n: string) => void
}) {
  if (lastError && !syncing) {
    return (
      <div className="hu-empty-state">
        <div className="hu-empty-title">SYNC FAILED</div>
        <div className="hu-empty-sub">{lastError}</div>
        <div className="hu-empty-sub" style={{ fontSize: 22, opacity: 0.7 }}>
          On iPhone: Settings → Bluetooth → tap (i) next to the head unit →
          enable Sync Contacts.  Recent calls share the same toggle.
        </div>
      </div>
    )
  }
  if (syncing && recents.length === 0) {
    return (
      <div className="hu-empty-state">
        <div className="hu-empty-title">SYNCING…</div>
      </div>
    )
  }
  if (!synced && recents.length === 0) {
    return (
      <div className="hu-empty-state">
        <div className="hu-empty-title">RECENT CALLS NOT SYNCED</div>
        <div className="hu-empty-sub">
          Tap SYNC in the sidebar to import call history from your phone.
        </div>
      </div>
    )
  }
  if (recents.length === 0) {
    return (
      <div className="hu-empty-state">
        <div className="hu-empty-title">NO RECENT CALLS</div>
      </div>
    )
  }
  return (
    <div className="hu-list">
      {recents.map((r, i) => (
        <RecentRow
          key={i}
          recent={r}
          selected={i === selectedIdx}
          onSelect={() => onSelect(i)}
          onCall={() => onCall(r.number)}
        />
      ))}
    </div>
  )
}

function RecentRow({
  recent: r,
  selected,
  onSelect,
  onCall,
}: {
  recent: RecentCall
  selected: boolean
  onSelect: () => void
  onCall: () => void
}) {
  const tap = useTap(onSelect)
  return (
    <div className={`hu-list-row${selected ? ' hu-list-row-selected' : ''}`} {...tap}>
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
          onClick={(e) => { e.stopPropagation(); onCall() }}
          aria-label="Call"
        >
          <img src={iconPhone} alt="call" className="hu-call-icon-img" />
        </button>
      )}
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
  contacts,
  selectedMatchId,
  onSelectMatch,
  onCall,
  onCallContact
}: {
  dial: string
  setDial: (v: string | ((p: string) => string)) => void
  contacts: Contact[]
  selectedMatchId: string | null
  onSelectMatch: (id: string) => void
  onCall: () => void
  onCallContact: (c: Contact) => void
}) {
  const scroll = useScrollContainer<HTMLDivElement>()
  // Filter + group by first letter.  When no digits typed, every section
  // is shown; as the user types, only sections whose contacts still
  // match remain visible.
  const grouped = useMemo(() => {
    const matches = filterContactsByDial(contacts, dial)
    const g: Record<string, Contact[]> = {}
    for (const c of matches) {
      const ch = (c.name[0] ?? '#').toUpperCase()
      const key = /[A-Z]/.test(ch) ? ch : '#'
      ;(g[key] ??= []).push(c)
    }
    return g
  }, [contacts, dial])

  const letters = Object.keys(grouped).sort((a, b) => {
    if (a === '#') return 1
    if (b === '#') return -1
    return a.localeCompare(b)
  })
  const matchCount = letters.reduce((n, l) => n + grouped[l].length, 0)

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

      <div className="hu-dial-matches" ref={scroll.ref} {...scroll.handlers}>
        <div className="hu-panel-label" style={{ marginBottom: 12 }}>
          {dial ? `MATCHES (${matchCount})` : `CONTACTS (${matchCount})`}
        </div>
        {letters.length === 0 ? (
          <div className="hu-empty-sub" style={{ paddingTop: 16 }}>
            No matches
          </div>
        ) : (
          <div className="hu-list">
            {letters.map((letter) => (
              <div key={letter}>
                <div className="hu-list-section">{letter}</div>
                {grouped[letter].map((c) => (
                  <ContactRow
                    key={c.id}
                    contact={c}
                    selected={c.id === selectedMatchId}
                    onSelect={() => onSelectMatch(c.id)}
                    onCall={() => onCallContact(c)}
                  />
                ))}
              </div>
            ))}
          </div>
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
    setActiveView(v)
  }, [])

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
            {/* Slide-strip carousel — all 4 views stay mounted so their
                local state (visualizer rings, phone tab selection, scan
                state, etc.) survives screen switches.  The strip is
                translated horizontally so the active screen sits in the
                viewport; transition gives the slide animation. */}
            <div
              className="hu-screen-strip"
              style={{
                transform: `translateX(${-CYCLE.indexOf(activeView) * 100}%)`,
              }}
            >
              {CYCLE.map((v) => (
                <div key={v} className="hu-screen-slot">
                  {renderView(v)}
                </div>
              ))}
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
