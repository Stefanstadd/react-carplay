import React, { useEffect, useState } from "react";
import { HashRouter as Router, Route, Routes, useNavigate, useLocation } from "react-router-dom";
import Settings from "./components/Settings";
import './App.css'
import Info from "./components/Info";
import Nav from "./components/Nav";
import Carplay from './components/Carplay'
import Camera from './components/Camera'
import HeadUnit, { VehicleData } from './components/HeadUnit'
import { Box, Modal } from '@mui/material'
import { useCarplayStore, useStatusStore } from "./store/store";
import { ThemeProvider, createTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';

const style = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  height: '95%',
  width: '95%',
  boxShadow: 24,
  display: "flex"
};

interface InnerProps {
  receivingVideo: boolean
  setReceivingVideo: (v: boolean) => void
  keyCommand: string
  commandCounter: number
}

function AppInner({ receivingVideo, setReceivingVideo, keyCommand, commandCounter }: InnerProps) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [reverse, setReverse] = useStatusStore(state => [state.reverse, state.setReverse])
  const settings = useCarplayStore((state) => state.settings)
  const [vehicleData, setVehicleData] = useState<VehicleData | undefined>(undefined)

  useEffect(() => {
    ;(window.api as any)?.onVehicleData?.((data: VehicleData) => {
      // Only replace the ref when a field has actually changed — the CAN
      // bridge streams updates faster than the gauges need to redraw, so
      // this guard cuts unnecessary re-renders across the whole HeadUnit
      // subtree.  Shallow compare is enough: VehicleData is a flat object
      // of scalars.
      setVehicleData((prev) => {
        if (!prev) return data
        for (const k of Object.keys(data) as (keyof VehicleData)[]) {
          if (prev[k] !== data[k]) return data
        }
        for (const k of Object.keys(prev) as (keyof VehicleData)[]) {
          if (prev[k] !== data[k]) return data
        }
        return prev
      })
    })
  }, [])

  const showNav = pathname !== '/' && pathname !== '/carplay'

  // Global keyboard escape from /carplay — Escape / Backspace always send
  // the user back to the head unit.  This is a hard safety net for when
  // the Carplay component crashes or the video canvas locks up: no matter
  // what the render layer is doing, this listener still fires and the
  // user can get out.
  useEffect(() => {
    if (pathname !== '/carplay') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault()
        navigate('/')
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [pathname, navigate])

  return (
    <div
      style={{ height: '100%', touchAction: 'none' }}
      id={'main'}
      className="App"
    >
      {showNav && <Nav receivingVideo={receivingVideo} settings={settings}/>}

      {/* Persistent CarPlay layer — stays mounted across nav changes so that
          returning to /carplay is seamless and the dongle doesn't re-init.
          Wrapped in an error boundary so a worker/decoder crash inside
          Carplay can't take the whole app down and strand the user with a
          white screen. */}
      {settings && (
        <CarplayErrorBoundary onExit={() => navigate('/')}>
          <Carplay
            receivingVideo={receivingVideo}
            setReceivingVideo={setReceivingVideo}
            settings={settings}
            command={keyCommand}
            commandCounter={commandCounter}
            onHostUIRequested={() => navigate('/')}
          />
        </CarplayErrorBoundary>
      )}

      <Routes>
        <Route
          path={"/"}
          element={
            <HeadUnit
              onLaunchCarplay={() => navigate('/carplay')}
              onOpenSettings={() => navigate('/settings')}
              vehicleData={vehicleData}
            />
          }
        />
        {/* /carplay renders nothing here — the persistent Carplay layer above
            handles its visibility via z-index. */}
        <Route path={"/carplay"} element={null} />
        <Route path={"/settings"} element={<Settings settings={settings!}/>} />
        <Route path={"/info"} element={<Info />} />
        <Route path={"/camera"} element={<Camera settings={settings!}/>} />
      </Routes>
      <Modal
        open={reverse}
        onClick={() => setReverse(false)}
      >
        <Box sx={style}>
          <Camera settings={settings}/>
        </Box>
      </Modal>
    </div>
  )
}

// Error boundary specifically for the Carplay layer.  When the dongle
// worker or H.264 decoder throws, the persistent Carplay layer would
// otherwise unmount and leave the /carplay route with nothing to render
// (HeadUnit isn't rendered at that path).  The fallback UI shows an
// EXIT button + the error message so the user is never stranded.
class CarplayErrorBoundary extends React.Component<
  { onExit: () => void; children: React.ReactNode },
  { err: Error | null }
> {
  state: { err: Error | null } = { err: null }
  static getDerivedStateFromError(err: Error) { return { err } }
  componentDidCatch(err: Error, info: React.ErrorInfo) {
    console.error('[Carplay] crashed:', err, info)
  }
  render() {
    if (!this.state.err) return this.props.children
    return (
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 999,
          background: 'var(--hu-bg-deep, #001500)',
          color: 'var(--hu-primary, #00ff0a)',
          fontFamily: "'VT323', monospace",
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 24, padding: 40, textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 56, letterSpacing: '0.18em' }}>CARPLAY CRASHED</div>
        <div style={{ fontSize: 28, opacity: 0.75, maxWidth: 900 }}>
          {this.state.err.message || String(this.state.err)}
        </div>
        <button
          onClick={() => { this.setState({ err: null }); this.props.onExit() }}
          style={{
            fontSize: 32, padding: '14px 34px',
            background: 'transparent',
            border: '1.5px solid var(--hu-primary, #00ff0a)',
            color: 'var(--hu-primary, #00ff0a)',
            fontFamily: "'VT323', monospace",
            cursor: 'pointer',
          }}
        >
          ← BACK TO HEAD UNIT
        </button>
      </div>
    )
  }
}

function App() {
  const [receivingVideo, setReceivingVideo] = useState(false)
  const [commandCounter, setCommandCounter] = useState(0)
  const [keyCommand, setKeyCommand] = useState('')
  const settings = useCarplayStore((state) => state.settings)

  const prefersDarkMode = useMediaQuery('(prefers-color-scheme: dark)');

  const theme = createTheme({
    palette: {
      mode: prefersDarkMode ? 'dark': "light",
    }
  });

  useEffect(() => {
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [settings]);

  const onKeyDown = (event: KeyboardEvent) => {
    if(Object.values(settings!.bindings).includes(event.code)) {
      let action = Object.keys(settings!.bindings).find(key =>
        settings!.bindings[key] === event.code
      )
      console.log(action)
      if(action !== undefined) {
        setKeyCommand(action)
        setCommandCounter(prev => prev + 1)
        if(action === 'selectDown') {
          console.log('select down')
          setTimeout(() => {
            setKeyCommand('selectUp')
            setCommandCounter(prev => prev + 1)
          }, 200)
        }
      }
    }
  }

  return (
    <ThemeProvider theme={theme}>
      <Router>
        <AppInner
          receivingVideo={receivingVideo}
          setReceivingVideo={setReceivingVideo}
          keyCommand={keyCommand}
          commandCounter={commandCounter}
        />
      </Router>
    </ThemeProvider>
  )
}

export default App
