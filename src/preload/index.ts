import { IpcRendererEvent, contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { ExtraConfig} from "../main/Globals";
import { Stream } from "socketmost/dist/modules/Messages";

type ApiCallback = (event: IpcRendererEvent, ...args: any[]) => void

export interface BtApi {
  onPhone:    (cb: ApiCallback) => void
  onMedia:    (cb: ApiCallback) => void
  onCall:     (cb: ApiCallback) => void
  onContacts: (cb: ApiCallback) => void
  onRecents:  (cb: ApiCallback) => void
  onDevices:  (cb: ApiCallback) => void

  requestState:  () => void
  mediaCmd:      (cmd: string) => void
  dial:          (number: string) => void
  answer:        () => void
  reject:        () => void
  hangup:        () => void
  mute:          (on: boolean) => void
  syncContacts:  () => void
  syncRecents:   () => void
  scan:          (on: boolean) => void
  connect:       (address: string) => void
  disconnect:    (address: string) => void
  forget:        (address: string) => void
}

export interface Api {
  settings: (callback: ApiCallback) => void
  reverse: (callback: ApiCallback) => void
  getSettings: () => void
  saveSettings: (settings: ExtraConfig) => void
  stream?: (stream: Stream) =>  void
  quit: () =>  void
  bt: BtApi
  onAudioPcm: (cb: (chunk: Uint8Array) => void) => void
}

const bt: BtApi = {
  onPhone:    (cb) => ipcRenderer.on('bt:phone',    cb),
  onMedia:    (cb) => ipcRenderer.on('bt:media',    cb),
  onCall:     (cb) => ipcRenderer.on('bt:call',     cb),
  onContacts: (cb) => ipcRenderer.on('bt:contacts', cb),
  onRecents:  (cb) => ipcRenderer.on('bt:recents',  cb),
  onDevices:  (cb) => ipcRenderer.on('bt:devices',  cb),

  requestState: ()         => ipcRenderer.send('bt:requestState'),
  mediaCmd:     (cmd)      => ipcRenderer.send('bt:mediaCmd', cmd),
  dial:         (number)   => ipcRenderer.send('bt:dial', number),
  answer:       ()         => ipcRenderer.send('bt:answer'),
  reject:       ()         => ipcRenderer.send('bt:reject'),
  hangup:       ()         => ipcRenderer.send('bt:hangup'),
  mute:         (on)       => ipcRenderer.send('bt:mute', on),
  syncContacts: ()         => ipcRenderer.send('bt:syncContacts'),
  syncRecents:  ()         => ipcRenderer.send('bt:syncRecents'),
  scan:         (on)       => ipcRenderer.send('bt:scan', on),
  connect:      (address)  => ipcRenderer.send('bt:connect', address),
  disconnect:   (address)  => ipcRenderer.send('bt:disconnect', address),
  forget:       (address)  => ipcRenderer.send('bt:forget', address),
}

// Custom APIs for renderer
const api: Api = {
  settings: (callback: ApiCallback) => ipcRenderer.on('settings', callback),
  reverse: (callback: ApiCallback) => ipcRenderer.on('reverse', callback),
  getSettings: () => ipcRenderer.send('getSettings'),
  saveSettings: (settings: ExtraConfig) => ipcRenderer.send('saveSettings', settings),
  // stream: (stream: Stream) => ipcRenderer.send('startStream', stream),
  quit: () => ipcRenderer.send('quit'),
  bt,
  onAudioPcm: (cb: (chunk: Uint8Array) => void) => {
    ipcRenderer.on('audio:pcm', (_e, chunk: Uint8Array | Buffer) => cb(chunk as Uint8Array))
  },
}

try {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
  contextBridge.exposeInMainWorld('electronAPI', {
    settings: (callback: ApiCallback) => ipcRenderer.on('settings', callback),
    getSettings: () => ipcRenderer.send('getSettings'),
    saveSettings: (settings: ExtraConfig) => ipcRenderer.send('saveSettings', settings),
    // stream: (stream: Stream) => ipcRenderer.send('startStream', stream),
    quit: () => ipcRenderer.send('quit')
  })
} catch (error) {
  console.error(error)
}
