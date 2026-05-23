import React, { useCallback, useEffect, useRef, useState } from 'react'
import './HeadUnit.css'
import iconMobile   from '../assets/icons/mobile.png'
import iconGauges   from '../assets/icons/gauges.png'
import iconMusic    from '../assets/icons/music.png'
import iconPhone    from '../assets/icons/phone.png'
import iconSettings from '../assets/icons/settings.png'
import iconContacts from '../assets/icons/contacts.png'
import iconRecent   from '../assets/icons/recent.png'
import iconCarplay  from '../assets/icons/carplay.png'

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
  gauges:  iconGauges,
  music:   iconMusic,
  phone:   iconPhone,
}

// ─── Scaling ──────────────────────────────────────────────────────────────────
// The UI is always drawn at 1920×1080 and CSS-transformed to fit the window.

function getScaleState() {
  const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080)
  return {
    scale: s,
    ox: (window.innerWidth  - 1920 * s) / 2,
    oy: (window.innerHeight - 1080 * s) / 2,
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
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`
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

const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function formatClock(d: Date) {
  return {
    dayDate: `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`,
    time: `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`,
  }
}

function formatTime(s: number) {
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2,'0')}`
}

// ─── Header ───────────────────────────────────────────────────────────────────

function HUHeader({ phoneName, batteryPct }: { phoneName: string; batteryPct: number }) {
  const { dayDate, time } = formatClock(useClock())
  const fillW = Math.max(0, (batteryPct / 100) * 19).toFixed(1)
  return (
    <header className="hu-header">
      <div className="hu-header-clock">
        <span className="hu-clock-date">{dayDate}</span>
        <span className="hu-clock-time">{time}</span>
      </div>
      <div className="hu-header-right">
        <span className="hu-phone-name">{phoneName}</span>
        <svg viewBox="0 0 30 14" width="56" height="26">
          <rect x="0.75" y="0.75" width="25.5" height="12.5" rx="0" fill="none" stroke="#00ff0a" strokeWidth="1.5"/>
          <rect x="26.25" y="4" width="3" height="6" rx="0" fill="#00ff0a"/>
          <rect x="2" y="2" width={fillW} height="10" rx="0" fill="#00ff0a"/>
        </svg>
      </div>
    </header>
  )
}

// ─── NavBar ───────────────────────────────────────────────────────────────────
// Five icons (Mobile, Gauges, Music, Phone, Settings) — selected one
// animates to the center slot, others shift around it.

type NavId = ViewName | 'settings'
const NAV_ORDER: NavId[] = ['devices', 'gauges', 'music', 'phone', 'settings']
const NAV_ICONS: Record<NavId, string> = { ...VIEW_ICONS, settings: iconSettings }

const NAV_CENTER = 2     // visual center is slot index 2
const NAV_SLOT_W = 220   // px per slot

function NavBar({
  active,
  onSelect,
  onSettings,
}: {
  active: ViewName
  onSelect: (v: ViewName) => void
  onSettings?: () => void
}) {
  const activeIdx = NAV_ORDER.indexOf(active)
  // shift the whole row so the active button ends up at the navbar center.
  // icons keep their natural order — no wrap-around.
  const shift = (NAV_CENTER - activeIdx) * NAV_SLOT_W
  return (
    <nav className="hu-navbar">
      <div
        className="hu-navbar-row"
        style={{ transform: `translateX(${shift}px)` }}
      >
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
              <img
                src={NAV_ICONS[id]}
                alt=""
                className="hu-nav-icon"
                draggable={false}
              />
            </button>
          )
        })}
      </div>
    </nav>
  )
}

// ─── Music View ───────────────────────────────────────────────────────────────

const NUM_BARS = 24
// Smoothly blend from --hu-green-dim → --hu-green as a bar's height
// crosses from BAR_MIX_LO (cool) up to BAR_MIX_HI (fully bright).
const BAR_MIX_LO = 0.70
const BAR_MIX_HI = 0.85

// Approximate frequency labels for ~24 bars across audible range.
// (Display under every other bar so labels don't overlap on the 5.5" screen.)
const BAR_FREQS = [
  '60','100','160','250','400','630','1k','1.6k','2.5k','4k','6k','8k',
  '10k','12k','13k','14k','15k','16k','17k','18k','19k','20k','21k','22k',
]

interface TrackInfo {
  title: string; artist: string; album: string
  artworkSrc?: string; duration: number; position: number
}

function MusicView({ onLaunchCarplay, onSelectView }: {
  onLaunchCarplay: () => void
  onSelectView: (v: ViewName) => void
}) {
  const targetRef = useRef<number[]>(
    Array.from({ length: NUM_BARS }, (_, i) => (i < 6 ? 0.6 : i < 14 ? 0.4 : 0.25) + Math.random() * 0.2)
  )
  const [eqBars, setEqBars]   = useState<number[]>(targetRef.current.slice())
  const [isPlaying, setIsPlaying] = useState(false)
  const [track, setTrack] = useState<TrackInfo>({
    title: 'No Track', artist: '—', album: '—', duration: 0, position: 0,
  })
  const analyserRef = useRef<AnalyserNode | null>(null)
  const ctxRef      = useRef<AudioContext | null>(null)
  const dataRef     = useRef<Uint8Array | null>(null)
  const frameRef    = useRef(0)

  useEffect(() => {
    const poll = setInterval(() => {
      const meta = navigator.mediaSession?.metadata
      if (meta) {
        setTrack(prev => {
          const newTitle = meta.title || 'No Track'
          if (newTitle !== prev.title)
            return { title: newTitle, artist: meta.artist || '—', album: meta.album || '—',
              artworkSrc: meta.artwork?.[0]?.src, duration: 240, position: 0 }
          return { ...prev, artist: meta.artist || prev.artist, album: meta.album || prev.album,
            artworkSrc: meta.artwork?.[0]?.src ?? prev.artworkSrc }
        })
      }
      const state = navigator.mediaSession?.playbackState
      if (state === 'playing') setIsPlaying(true)
      else if (state === 'paused' || state === 'none') setIsPlaying(false)
    }, 2000)
    return () => clearInterval(poll)
  }, [])

  useEffect(() => {
    if (!isPlaying) return
    const id = setInterval(() => {
      setTrack(prev => prev.duration > 0
        ? { ...prev, position: Math.min(prev.position + 1, prev.duration) } : prev)
    }, 1000)
    return () => clearInterval(id)
  }, [isPlaying])

  useEffect(() => {
    let cancelled = false
    let tick = 0
    const tryAudio = async () => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          audio: true, video: { width: 1, height: 1, frameRate: 1 } as MediaTrackConstraints,
        })
        stream.getVideoTracks().forEach(t => t.stop())
        if (!cancelled && stream.getAudioTracks().length > 0) {
          const ctx = new AudioContext()
          ctxRef.current = ctx
          const analyser = ctx.createAnalyser()
          analyser.fftSize = 64
          dataRef.current = new Uint8Array(analyser.frequencyBinCount)
          analyserRef.current = analyser
          ctx.createMediaStreamSource(stream).connect(analyser)
        }
      } catch { /* simulation fallback */ }
      startLoop()
    }
    const startLoop = () => {
      const loop = () => {
        if (cancelled) return
        tick++
        if (tick % 2 === 0) {
          if (analyserRef.current && dataRef.current) {
            analyserRef.current.getByteFrequencyData(dataRef.current)
            const len = dataRef.current.length
            setEqBars(Array.from({ length: NUM_BARS }, (_, i) =>
              dataRef.current![Math.floor((i / NUM_BARS) * len)] / 255))
          } else {
            setEqBars(prev => prev.map((v, i) => {
              const isBass = i < 4
              const speed  = isBass ? 0.05 : i < 12 ? 0.08 : 0.12
              if (Math.random() < 0.04)
                targetRef.current[i] = Math.random() * (isBass ? 0.95 : i < 12 ? 0.78 : 0.6) + 0.08
              return v + (targetRef.current[i] - v) * speed
            }))
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
      ctxRef.current = null; analyserRef.current = null; dataRef.current = null
    }
  }, [])

  const sendMediaKey = useCallback((key: string) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keyup',   { key, bubbles: true }))
  }, [])

  const progress = track.duration > 0 ? Math.min(1, track.position / track.duration) : 0

  return (
    <div className="hu-screen hu-music-screen">
      {/* Visualizer fills the free vertical space (full width, flex:1) */}
      <div className="hu-viz-area">
        <div className="hu-eq-bars">
          {eqBars.map((h, i) => {
            const t = Math.max(0, Math.min(1, (h - BAR_MIX_LO) / (BAR_MIX_HI - BAR_MIX_LO)))
            const dimPct  = ((1 - t) * 100).toFixed(0)
            const brigPct = (t * 100).toFixed(0)
            return (
              <div
                key={i}
                className="hu-eq-bar"
                style={{
                  '--bar-h': `${Math.max(3, Math.round(h * 100))}%`,
                  background: `color-mix(in srgb, var(--hu-green-dim) ${dimPct}%, var(--hu-green) ${brigPct}%)`,
                } as React.CSSProperties}
              />
            )
          })}
        </div>
        <div className="hu-eq-labels">
          {BAR_FREQS.slice(0, NUM_BARS).map((f, i) => (
            <span key={i} className="hu-eq-label">{i % 2 === 0 ? f : ''}</span>
          ))}
        </div>
      </div>

      {/* Quick-access overlay (top-left, 20% × 20%, covers the bars behind it) */}
      <div className="hu-quick-area">
        <button className="hu-quick-btn" onClick={onLaunchCarplay} aria-label="CarPlay">
          <img src={iconCarplay} alt="" className="hu-quick-btn-img"/>
        </button>
        <button className="hu-quick-btn hu-quick-btn-disabled" disabled aria-label="Android Auto">
          <img src={iconMobile} alt="" className="hu-quick-btn-img"/>
        </button>
        <button className="hu-quick-btn" onClick={() => onSelectView('phone')} aria-label="Recent Calls">
          <img src={iconRecent} alt="" className="hu-quick-btn-img"/>
        </button>
      </div>

      {/* Album art + track info — pushed down by the tall visualizer */}
      <div className="hu-info-area">
        <div className={`hu-music-art${isPlaying ? ' hu-art-pulse' : ''}`}>
          {track.artworkSrc
            ? <img src={track.artworkSrc} alt="album art" className="hu-art-img"/>
            : <svg viewBox="0 0 80 80" width="100" height="100" opacity="0.6" shapeRendering="crispEdges">
                <rect x="14" y="14" width="52" height="52" fill="none" stroke="#00ff0a" strokeWidth="3"/>
                <rect x="36" y="34" width="8" height="14" fill="#00ff0a"/>
                <rect x="44" y="32" width="2" height="14" fill="#00ff0a"/>
              </svg>
          }
        </div>
        <div className="hu-music-text">
          <div className="hu-music-via">via Bluetooth</div>
          <div className="hu-music-title">{track.title}</div>
          <div className="hu-music-artist">{track.artist}</div>
          <div className="hu-music-album">{track.album}</div>
        </div>
      </div>

      {/* Bottom — progress + transport, full width */}
      <div className="hu-controls-area">
          <div className="hu-progress-wrap">
            <div className="hu-progress-track">
              <div className="hu-progress-fill" style={{ width: `${progress * 100}%` }}/>
            </div>
            <div className="hu-progress-times">
              <span>{formatTime(track.position)}</span>
              <span>{track.duration > 0 ? formatTime(track.duration) : '--:--'}</span>
            </div>
          </div>

          <div className="hu-music-controls">
            <button className="hu-transport-btn" onClick={() => sendMediaKey('MediaTrackPrevious')} aria-label="Previous">
              <svg viewBox="0 0 32 32" width="46" height="46">
                <polygon points="28,5 10,16 28,27" fill="currentColor"/>
                <rect x="4" y="5" width="5" height="22" fill="currentColor"/>
              </svg>
            </button>
            <button className="hu-transport-btn hu-play-btn" onClick={() => sendMediaKey('MediaPlayPause')} aria-label="Play/Pause">
              {isPlaying
                ? <svg viewBox="0 0 32 32" width="56" height="56">
                    <rect x="5"  y="4" width="9" height="24" fill="currentColor"/>
                    <rect x="18" y="4" width="9" height="24" fill="currentColor"/>
                  </svg>
                : <svg viewBox="0 0 32 32" width="56" height="56">
                    <polygon points="6,3 28,16 6,29" fill="currentColor"/>
                  </svg>
              }
            </button>
            <button className="hu-transport-btn" onClick={() => sendMediaKey('MediaTrackNext')} aria-label="Next">
              <svg viewBox="0 0 32 32" width="46" height="46">
                <polygon points="4,5 22,16 4,27" fill="currentColor"/>
                <rect x="23" y="5" width="5" height="22" fill="currentColor"/>
              </svg>
            </button>
          </div>
      </div>
    </div>
  )
}

// ─── Devices View ─────────────────────────────────────────────────────────────

const MOCK_PAIRED = ['iPhone 14 Pro', 'AirPods Pro']

function DevicesView({ onLaunchCarplay }: { onLaunchCarplay: () => void }) {
  return (
    <div className="hu-screen">
      {/* LEFT: connection options */}
      <div className="hu-sidebar">
        <div className="hu-panel-label">CONNECT VIA</div>

        <button className="hu-list-btn">
          <img src={iconMobile} alt="" className="hu-list-btn-icon"/>
          <span>Phone</span>
        </button>

        <button className="hu-list-btn hu-list-btn-disabled" disabled>
          <img src={iconMobile} alt="" className="hu-list-btn-icon" style={{ opacity: 0.4 }}/>
          <span>Android Auto</span>
          <span className="hu-opt-tag">—</span>
        </button>

        <button className="hu-list-btn" onClick={onLaunchCarplay}>
          <img src={iconCarplay} alt="" className="hu-list-btn-icon"/>
          <span>Apple CarPlay</span>
          <span className="hu-opt-tag">▶</span>
        </button>
      </div>

      {/* RIGHT: paired devices */}
      <div className="hu-main-area">
        <div className="hu-panel-label">PAIRED DEVICES</div>
        {MOCK_PAIRED.map(d => (
          <div key={d} className="hu-device-row">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="#00ff0a" shapeRendering="crispEdges">
              <path d="M12 2l5 5-4 4 4 4-5 5V14l-3 3-1.5-1.5L11 12 7.5 8.5 9 7l3 3V2z"/>
            </svg>
            <span>{d}</span>
            <span className="hu-device-tag">BT</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Gauge widget ─────────────────────────────────────────────────────────────

const G_START = 120
const G_SWEEP = 300

interface GaugeWidgetProps {
  label: string; value: number; min: number; max: number; unit: string
  warnAbove?: number
}

function GaugeWidget({ label, value, min, max, unit, warnAbove }: GaugeWidgetProps) {
  const pct  = Math.min(1, Math.max(0, (value - min) / (max - min)))
  const fill = pct * G_SWEEP
  const cx = 60, cy = 60, r = 42
  const warn  = warnAbove !== undefined && value > warnAbove
  const green = warn ? '#ff6b1a' : '#00ff0a'
  const dim   = warn ? '#8a3a0f' : '#008a06'

  const nDeg = G_START + pct * G_SWEEP
  const nTip = polarToCartesian(cx, cy, r - 6, nDeg)
  const nL   = polarToCartesian(cx, cy, 7, nDeg + 90)
  const nR   = polarToCartesian(cx, cy, 7, nDeg - 90)

  const ticks = Array.from({ length: 6 }, (_, i) => {
    const deg = G_START + (i / 5) * G_SWEEP
    return { o: polarToCartesian(cx, cy, r, deg), i: polarToCartesian(cx, cy, r - 7, deg) }
  })

  const displayVal = value % 1 === 0 ? String(value) : value.toFixed(1)

  return (
    <div className="hu-gauge-wrap">
      <svg viewBox="0 0 120 112" width="260" height="243" shapeRendering="crispEdges">
        <path d={gaugeArc(cx, cy, r, G_START, G_SWEEP)} fill="none" stroke={dim}   strokeWidth={4.5} strokeLinecap="butt"/>
        {fill > 0 && (
          <path d={gaugeArc(cx, cy, r, G_START, fill)} fill="none" stroke={green} strokeWidth={4.5} strokeLinecap="butt"/>
        )}
        {ticks.map((t, i) => (
          <line key={i} x1={t.o.x} y1={t.o.y} x2={t.i.x} y2={t.i.y} stroke={dim} strokeWidth="1.5"/>
        ))}
        <polygon
          points={`${nTip.x.toFixed(1)},${nTip.y.toFixed(1)} ${nL.x.toFixed(1)},${nL.y.toFixed(1)} ${nR.x.toFixed(1)},${nR.y.toFixed(1)}`}
          fill={green}
        />
        <rect x={cx - 4} y={cy - 4} width="8" height="8" fill={green}/>
        <text x={cx} y={cy + 20} textAnchor="middle" fill={green} fontSize={13}
          fontFamily="'VT323'">{displayVal}</text>
        <text x={cx} y={cy + 31} textAnchor="middle" fill={dim} fontSize={8.5}
          fontFamily="'VT323'">{unit}</text>
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
      {/* LEFT: slim sidebar with numeric readouts */}
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

      {/* RIGHT: gauges in a flex-wrap grid (handles more gauges later) */}
      <div className="hu-main-area">
        <div className="hu-gauges">
          <GaugeWidget label="OIL TEMP" value={vd.oilTempC ?? 90}  min={40} max={150}  unit="°C"   warnAbove={120}/>
          <GaugeWidget label="SPEED"    value={vd.speedKmh ?? 0}   min={0}  max={260}  unit="km/h"/>
          <GaugeWidget label="RPM"      value={vd.rpm      ?? 800} min={0}  max={8000} unit="RPM"  warnAbove={6500}/>
        </div>
      </div>
    </div>
  )
}

// ─── Phone View ───────────────────────────────────────────────────────────────

type PhoneTab = 'contacts' | 'recent' | 'call'

const PHONE_TAB_ICONS: Record<PhoneTab, string> = {
  contacts: iconContacts,
  recent:   iconRecent,
  call:     iconPhone,
}
const PHONE_TAB_LABEL: Record<PhoneTab, string> = {
  contacts: 'CONTACTS',
  recent:   'RECENT',
  call:     'CALL',
}

const CONTACTS = [
  { name: 'Alice',   num: '+31 6 1234 5678' },
  { name: 'Bob',     num: '+31 6 8765 4321' },
  { name: 'Charlie', num: '+31 6 1122 3344' },
  { name: 'Diane',   num: '+31 6 9988 7766' },
]
const RECENTS = [
  { name: 'Bob',     num: '+31 6 8765 4321', time: '14:23',     dir: 'out'  },
  { name: 'Unknown', num: '+31 6 5555 6666', time: 'Yesterday', dir: 'in'   },
  { name: 'Alice',   num: '+31 6 1234 5678', time: 'Yesterday', dir: 'miss' },
]

function PhoneView() {
  const [tab,  setTab]  = useState<PhoneTab>('contacts')
  const [dial, setDial] = useState('')

  return (
    <div className="hu-screen">
      {/* LEFT: vertical tab buttons with icons */}
      <div className="hu-sidebar">
        <div className="hu-panel-label">PHONE</div>
        <div className="hu-phone-sidebar-tabs">
          {(['contacts','recent','call'] as PhoneTab[]).map(t => (
            <button
              key={t}
              className={`hu-list-btn${tab === t ? ' hu-list-btn-active' : ''}`}
              onClick={() => setTab(t)}
            >
              <img src={PHONE_TAB_ICONS[t]} alt="" className="hu-list-btn-icon"/>
              <span>{PHONE_TAB_LABEL[t]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* RIGHT: content */}
      <div className="hu-main-area">
        <div className="hu-phone-content">
          {tab === 'contacts' && (
            <div className="hu-list">
              {CONTACTS.map(c => (
                <div key={c.name} className="hu-list-row">
                  <div className="hu-avatar">{c.name[0]}</div>
                  <div>
                    <div className="hu-list-name">{c.name}</div>
                    <div className="hu-list-sub">{c.num}</div>
                  </div>
                  <button className="hu-call-icon-btn">
                    <img src={iconPhone} alt="call" className="hu-call-icon-img"/>
                  </button>
                </div>
              ))}
            </div>
          )}

          {tab === 'recent' && (
            <div className="hu-list">
              {RECENTS.map((r, i) => (
                <div key={i} className="hu-list-row">
                  <span className={`hu-call-dir hu-call-${r.dir}`}>
                    {r.dir === 'miss' ? '↘' : r.dir === 'in' ? '↙' : '↗'}
                  </span>
                  <div>
                    <div className="hu-list-name">{r.name}</div>
                    <div className="hu-list-sub">{r.num}</div>
                  </div>
                  <span className="hu-call-time">{r.time}</span>
                </div>
              ))}
            </div>
          )}

          {tab === 'call' && (
            <div className="hu-numpad">
              <div className="hu-dial-display">
                {dial || <span className="hu-dial-placeholder">Enter number</span>}
              </div>
              {[['1','2','3'],['4','5','6'],['7','8','9'],['*','0','#']].map((row, ri) => (
                <div key={ri} className="hu-numpad-row">
                  {row.map(k => (
                    <button key={k} className="hu-numpad-key" onClick={() => setDial(p => p + k)}>{k}</button>
                  ))}
                </div>
              ))}
              <div className="hu-numpad-row">
                <button className="hu-numpad-key hu-call-green">
                  <img src={iconPhone} alt="call" className="hu-numpad-call-icon"/>
                </button>
                <button className="hu-numpad-key" onClick={() => setDial(p => p.slice(0, -1))}>⌫</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── HeadUnit root ────────────────────────────────────────────────────────────

export default function HeadUnit({ onLaunchCarplay, onOpenSettings, vehicleData }: HeadUnitProps) {
  const [activeView, setActiveView] = useState<ViewName>('music')
  const [prevView,   setPrevView]   = useState<ViewName | null>(null)
  const [slideDir,   setSlideDir]   = useState<'left' | 'right'>('right')
  const [ss, setSS] = useState(getScaleState)

  useEffect(() => {
    const onResize = () => setSS(getScaleState())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const handleSelect = useCallback((v: ViewName) => {
    setActiveView(curr => {
      if (v === curr) return curr
      const ci = CYCLE.indexOf(curr)
      const ni = CYCLE.indexOf(v)
      // If new view is to the right of current → slide left (current goes left, new comes from right)
      // If new view is to the left of current → slide right (current goes right, new comes from left)
      setSlideDir(ni > ci ? 'left' : 'right')
      setPrevView(curr)
      return v
    })
  }, [])

  // Clear the outgoing screen once its slide-out animation finishes.
  useEffect(() => {
    if (prevView === null) return
    const t = setTimeout(() => setPrevView(null), 360)
    return () => clearTimeout(t)
  }, [prevView, activeView])

  const renderView = (v: ViewName) => {
    switch (v) {
      case 'music':   return <MusicView   onLaunchCarplay={onLaunchCarplay} onSelectView={handleSelect}/>
      case 'devices': return <DevicesView onLaunchCarplay={onLaunchCarplay}/>
      case 'gauges':  return <GaugesView  vehicleData={vehicleData}/>
      case 'phone':   return <PhoneView/>
    }
  }

  // outgoing slide direction matches the user's request:
  //  - user clicks a screen LEFT of current → current slides RIGHT, new comes from LEFT
  //  - user clicks a screen RIGHT of current → current slides LEFT, new comes from RIGHT
  const outClass = slideDir === 'left'  ? 'hu-slide-out-left'  : 'hu-slide-out-right'
  const inClass  = slideDir === 'left'  ? 'hu-slide-in-right'  : 'hu-slide-in-left'

  return (
    <div className="hu-viewport">
      <div
        className="hu-canvas"
        style={{ transform: `translate(${ss.ox}px, ${ss.oy}px) scale(${ss.scale})` }}
      >
        <div className="hu-root">
          <div className="hu-scanlines" aria-hidden="true"/>
          <HUHeader phoneName="iPhone 14 Pro" batteryPct={78}/>
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
          <NavBar active={activeView} onSelect={handleSelect} onSettings={onOpenSettings}/>
        </div>
      </div>
    </div>
  )
}
