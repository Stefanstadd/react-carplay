import { useEffect, useState } from "react";
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
      setVehicleData(data)
    })
  }, [])

  const showNav = pathname !== '/' && pathname !== '/carplay'

  return (
    <div
      style={{ height: '100%', touchAction: 'none' }}
      id={'main'}
      className="App"
    >
      {showNav && <Nav receivingVideo={receivingVideo} settings={settings}/>}

      {/* Persistent CarPlay layer — stays mounted across nav changes so that
          returning to /carplay is seamless and the dongle doesn't re-init.   */}
      {settings && (
        <Carplay
          receivingVideo={receivingVideo}
          setReceivingVideo={setReceivingVideo}
          settings={settings}
          command={keyCommand}
          commandCounter={commandCounter}
          onHostUIRequested={() => navigate('/')}
        />
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
