import { IpcRendererEvent, contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { ExtraConfig} from "../main/Globals";
import { Stream } from "socketmost/dist/modules/Messages";

type ApiCallback = (event: IpcRendererEvent, ...args: any[]) => void

export interface BtApi {
  onPhone:     (cb: ApiCallback) => void
  onMedia:     (cb: ApiCallback) => void
  onCall:      (cb: ApiCallback) => void
  onContacts:  (cb: ApiCallback) => void
  onRecents:   (cb: ApiCallback) => void
  onDevices:   (cb: ApiCallback) => void
  onDialError: (cb: ApiCallback) => void

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

export interface EqApi {
  onState:         (cb: ApiCallback) => void
  requestState:    () => void
  setBands:        (bands: number[]) => void
  setActivePreset: (name: string) => void
  savePreset:      (name: string) => void
  deletePreset:    (name: string) => void
  setEnabled:      (enabled: boolean) => void
}

export interface UserApi {
  onState:            (cb: ApiCallback) => void
  requestState:       () => void
  setTheme:           (patch: { primary?: string; peak?: string; activePreset?: string }) => void
  saveThemePreset:    (name: string) => void
  deleteThemePreset:  (name: string) => void
  setViz:             (patch: any) => void
  resetViz:           () => void
  upsertGauge:        (g: any) => void
  deleteGauge:        (id: string) => void
}

export interface Api {
  settings: (callback: ApiCallback) => void
  reverse: (callback: ApiCallback) => void
  getSettings: () => void
  saveSettings: (settings: ExtraConfig) => void
  stream?: (stream: Stream) =>  void
  quit: () =>  void
  bt: BtApi
  eq: EqApi
  user: UserApi
  onAudioPcm: (cb: (chunk: Uint8Array) => void) => void
}

const bt: BtApi = {
  onPhone:     (cb) => ipcRenderer.on('bt:phone',     cb),
  onMedia:     (cb) => ipcRenderer.on('bt:media',     cb),
  onCall:      (cb) => ipcRenderer.on('bt:call',      cb),
  onContacts:  (cb) => ipcRenderer.on('bt:contacts',  cb),
  onRecents:   (cb) => ipcRenderer.on('bt:recents',   cb),
  onDevices:   (cb) => ipcRenderer.on('bt:devices',   cb),
  onDialError: (cb) => ipcRenderer.on('bt:dialError', cb),

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

const eq: EqApi = {
  onState:         (cb)    => ipcRenderer.on('eq:state', cb),
  requestState:    ()      => ipcRenderer.send('eq:requestState'),
  setBands:        (b)     => ipcRenderer.send('eq:setBands', b),
  setActivePreset: (n)     => ipcRenderer.send('eq:setActivePreset', n),
  savePreset:      (n)     => ipcRenderer.send('eq:savePreset', n),
  deletePreset:    (n)     => ipcRenderer.send('eq:deletePreset', n),
  setEnabled:      (e)     => ipcRenderer.send('eq:setEnabled', e),
}

const user: UserApi = {
  onState:           (cb)    => ipcRenderer.on('user:state', cb),
  requestState:      ()      => ipcRenderer.send('user:requestState'),
  setTheme:          (p)     => ipcRenderer.send('user:setTheme', p),
  saveThemePreset:   (n)     => ipcRenderer.send('user:saveThemePreset', n),
  deleteThemePreset: (n)     => ipcRenderer.send('user:deleteThemePreset', n),
  setViz:            (p)     => ipcRenderer.send('user:setViz', p),
  resetViz:          ()      => ipcRenderer.send('user:resetViz'),
  upsertGauge:       (g)     => ipcRenderer.send('user:upsertGauge', g),
  deleteGauge:       (id)    => ipcRenderer.send('user:deleteGauge', id),
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
  eq,
  user,
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
