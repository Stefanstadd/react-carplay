import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import './Carplay.css'
import { findDevice, requestDevice, CommandMapping } from 'node-carplay/web'
import { CarPlayWorker } from './worker/types'
import useCarplayAudio from './useCarplayAudio'
import { useCarplayTouch } from './useCarplayTouch'
import { useLocation } from 'react-router-dom'
import { ExtraConfig } from '../../../main/Globals'
import { useCarplayStore, useStatusStore } from '../store/store'
import { InitEvent } from './worker/render/RenderEvents'
import { CARPLAY_EXIT_BTN_SCALE } from './headunit.config'

const RETRY_DELAY_MS = 15000

interface CarplayProps {
  receivingVideo: boolean
  setReceivingVideo: (receivingVideo: boolean) => void
  settings: ExtraConfig
  command: string
  commandCounter: number
  onHostUIRequested?: () => void
}

function Carplay({
  receivingVideo,
  setReceivingVideo,
  settings,
  command,
  commandCounter,
  onHostUIRequested
}: CarplayProps) {
  const [isPlugged, setPlugged] = useStatusStore((state) => [state.isPlugged, state.setPlugged])
  const [deviceFound, setDeviceFound] = useState(false)
  const { pathname } = useLocation()

  const width = window.innerWidth
  const height = window.innerHeight

  // Channels must be per-instance: module-level channels get their ports neutered
  // after the first mount and can't be reused on re-entry to the /carplay route.
  const videoChannel = useMemo(() => new MessageChannel(), [])
  const micChannel = useMemo(() => new MessageChannel(), [])

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [canvasElement, setCanvasElement] = useState<HTMLCanvasElement | null>(null)
  const mainElem = useRef<HTMLDivElement>(null)
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const stream = useCarplayStore((state) => state.stream)
  const config = {
    fps: settings.fps,
    width: width,
    height: height,
    mediaDelay: settings.mediaDelay
  }
  // const pathname = "/"
  console.log(pathname)

  const renderWorker = useMemo(() => {
    if (!canvasElement) return

    const worker = new Worker(new URL('./worker/render/Render.worker.ts', import.meta.url), {
      type: 'module'
    })
    const canvas = canvasElement.transferControlToOffscreen()
    worker.postMessage(new InitEvent(canvas, videoChannel.port2), [canvas, videoChannel.port2])
    return worker
  }, [canvasElement])

  useLayoutEffect(() => {
    if (canvasRef.current) {
      setCanvasElement(canvasRef.current)
    }
  }, [])

  const carplayWorker = useMemo(() => {
    const worker = new Worker(new URL('./worker/CarPlay.worker.ts', import.meta.url), {
      type: 'module'
    }) as CarPlayWorker
    const payload = {
      videoPort: videoChannel.port1,
      microphonePort: micChannel.port1
    }
    worker.postMessage({ type: 'initialise', payload }, [videoChannel.port1, micChannel.port1])
    return worker
  }, [])

  const { processAudio, getAudioPlayer, startRecording, stopRecording } = useCarplayAudio(
    carplayWorker,
    micChannel.port2
  )

  const clearRetryTimeout = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
  }, [])

  // subscribe to worker messages
  useEffect(() => {
    carplayWorker.onmessage = (ev) => {
      const { type } = ev.data
      switch (type) {
        case 'plugged':
          setPlugged(true)
          if (settings.piMost && settings?.most?.stream) {
            console.log('setting most stream')
            stream(settings.most.stream)
          }
          break
        case 'unplugged':
          setPlugged(false)
          break
        case 'requestBuffer':
          clearRetryTimeout()
          getAudioPlayer(ev.data.message)
          break
        case 'audio':
          clearRetryTimeout()
          processAudio(ev.data.message)
          break
        case 'media':
          //TODO: implement
          break
        case 'command':
          const {
            message: { value }
          } = ev.data
          switch (value) {
            case CommandMapping.startRecordAudio:
              startRecording()
              break
            case CommandMapping.stopRecordAudio:
              stopRecording()
              break
            case CommandMapping.requestHostUI:
              onHostUIRequested?.()
          }
          break
        case 'failure':
          if (retryTimeoutRef.current == null) {
            console.error(`Carplay initialization failed -- Reloading page in ${RETRY_DELAY_MS}ms`)
            retryTimeoutRef.current = setTimeout(() => {
              window.location.reload()
            }, RETRY_DELAY_MS)
          }
          break
      }
    }
  }, [
    carplayWorker,
    clearRetryTimeout,
    getAudioPlayer,
    processAudio,
    renderWorker,
    startRecording,
    stopRecording
  ])

  useEffect(() => {
    const element = mainElem?.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      console.log('size change')
      carplayWorker.postMessage({ type: 'frame' })
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    carplayWorker.postMessage({ type: 'keyCommand', command: command })
  }, [commandCounter])

  const checkDevice = useCallback(
    async (request: boolean = false) => {
      const device = request ? await requestDevice() : await findDevice()
      if (device) {
        console.log('starting in check')
        setDeviceFound(true)
        setReceivingVideo(true)
        carplayWorker.postMessage({ type: 'start', payload: { config } })
      } else {
        setDeviceFound(false)
      }
    },
    [carplayWorker]
  )

  // Start device check on mount; stop worker on unmount
  useEffect(() => {
    checkDevice()
    return () => {
      carplayWorker.postMessage({ type: 'stop' })
    }
  }, [checkDevice, carplayWorker])

  // usb connect/disconnect handling and device check
  useEffect(() => {
    navigator.usb.onconnect = async () => {
      checkDevice()
    }

    navigator.usb.ondisconnect = async () => {
      const device = await findDevice()
      if (!device) {
        carplayWorker.postMessage({ type: 'stop' })
        setDeviceFound(false)
      }
    }

    //checkDevice()
  }, [carplayWorker, checkDevice])

  // const onClick = useCallback(() => {
  //   checkDevice(true)
  // }, [checkDevice])

  const sendTouchEvent = useCarplayTouch(carplayWorker, width, height)

  const isLoading = !isPlugged
  const active = pathname === '/carplay'

  // Tell the render worker to stop decoding H264 frames when CarPlay isn't
  // the active view.  Decoding is the heaviest CPU cost; skipping it while
  // the user is on the head unit dashboard keeps the UI responsive.
  useEffect(() => {
    if (!renderWorker) return
    renderWorker.postMessage({ type: 'setActive', active })
  }, [active, renderWorker])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: active ? 100 : -1,
        visibility: active ? 'visible' : 'hidden',
        pointerEvents: active ? 'auto' : 'none',
        touchAction: 'none',
        background: '#001500'
      }}
      id={'main'}
      className="App"
      ref={mainElem}
    >
      {/* Escape hatch: while /carplay is showing, always keep an EXIT button
       *  reachable — even after a successful `plugged` handshake — because
       *  the worker can silently die (H.264 decoder crash, USB reset,
       *  dongle firmware panic) and we then have no other way back to the
       *  head unit.  It's a small overlay in the corner; taps go through
       *  to the video canvas everywhere else. */}
      {active && (
        <button
          className="cp-exit-btn"
          onClick={() => onHostUIRequested?.()}
          style={{ ['--cp-exit-scale' as any]: CARPLAY_EXIT_BTN_SCALE }}
        >
          ← EXIT
        </button>
      )}
      {active && (deviceFound === false || isLoading) && (
        <div className="cp-loading">
          <div className="cp-loading-inner">
            <div className="cp-loading-title">
              {deviceFound ? 'Waiting for Phone' : 'Waiting for Dongle'}
            </div>
            <div className="cp-loading-bar">
              <div className="cp-loading-bar-fill" />
            </div>
            <div className="cp-loading-sub">
              {deviceFound
                ? 'Connect your phone via USB or Bluetooth'
                : 'Plug in the CarPlay adapter'}
            </div>
          </div>
        </div>
      )}
      <div
        id="videoContainer"
        onPointerDown={sendTouchEvent}
        onPointerMove={sendTouchEvent}
        onPointerUp={sendTouchEvent}
        onPointerCancel={sendTouchEvent}
        onPointerOut={sendTouchEvent}
        style={{
          height: '100%',
          width: '100%',
          padding: 0,
          margin: 0,
          display: 'flex',
          visibility: isPlugged ? 'visible' : 'hidden'
        }}
      >
        <canvas
          ref={canvasRef}
          id={'video'}
          style={isPlugged ? { height: '100%' } : { height: '0%' }}
        />
      </div>
    </div>
  )
}

export default React.memo(Carplay)
