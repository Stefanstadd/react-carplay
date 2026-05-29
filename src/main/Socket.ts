import { createServer as createHttpServer } from 'http'
import { ExtraConfig } from "./Globals";
import { Server } from 'socket.io'
import { EventEmitter } from 'events'
import { Stream } from "socketmost/dist/modules/Messages";

export enum MessageNames {
  Connection = 'connection',
  GetSettings = 'getSettings',
  SaveSettings = 'saveSettings',
  Stream = 'stream'
}

export class Socket extends EventEmitter {
  config: ExtraConfig
  io: Server
  saveSettings: (settings: ExtraConfig) => void
  constructor(config: ExtraConfig, saveSettings: (settings: ExtraConfig) => void) {
    super()
    this.config = config
    this.saveSettings = saveSettings

    // Create the HTTP server explicitly so we can attach an error handler
    // before listen() — socket.io's internal server has no error listener
    // and EADDRINUSE would propagate as an uncaught exception.
    const httpServer = createHttpServer()
    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.warn('[socket] port 4000 already in use — remote socket server disabled')
      } else {
        console.error('[socket] http server error:', err)
      }
    })

    this.io = new Server(httpServer, { cors: { origin: '*' } })

    this.io.on(MessageNames.Connection, (socket) => {
      this.sendSettings()

      socket.on(MessageNames.GetSettings, () => {
        this.sendSettings()
      })

      socket.on(MessageNames.SaveSettings, (settings: ExtraConfig) => {
        this.saveSettings(settings)
      })

      socket.on(MessageNames.Stream, (stream: Stream) => {
        this.emit(MessageNames.Stream, stream)
      })
    })

    httpServer.listen(4000)
  }

  sendSettings() {
    this.io.emit('settings', this.config)
  }

  sendReverse(reverse: boolean) {
    this.io.emit('reverse', reverse)
  }

  sendLights(lights: boolean) {
    this.io.emit('lights', lights)
  }
}
