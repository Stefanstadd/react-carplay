// Captures audio from a PulseAudio/PipeWire monitor source in the main
// process via the `parec` CLI (which exists on every Pi with pipewire-pulse
// installed) and streams raw s16le PCM to the renderer over IPC.  The
// renderer accumulates the samples in a ring buffer and runs an FFT in JS.
//
// This replaces the previous getUserMedia + module-remap-source dance which
// kept breaking because (a) Chromium hides PA monitor sources from
// enumerateDevices() and (b) pactl-loaded remap-sources don't always wire
// their master link properly on PipeWire-pulse.

import { spawn, ChildProcess } from 'child_process'
import { BrowserWindow } from 'electron'

const DEFAULT_TARGETS = [
  'headunit_eq.monitor',
  'alsa_output.usb-C-Media_Electronics_Inc._USB_Audio_Device-00.analog-stereo.monitor',
  '@DEFAULT_MONITOR@',
]

export class AudioCapture {
  private proc: ChildProcess | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private currentTargetIdx = 0
  private targets: string[] = DEFAULT_TARGETS

  constructor(private getWindow: () => BrowserWindow | undefined) {}

  setTargets(list: string[]) {
    this.targets = list.length > 0 ? list : DEFAULT_TARGETS
    this.currentTargetIdx = 0
    this.restart()
  }

  start() {
    if (process.platform !== 'linux') {
      console.log('[audio] non-linux, skipping audio capture (EQ will use simulation)')
      return
    }
    this.spawnParec()
  }

  stop() {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.proc) {
      try { this.proc.kill('SIGTERM') } catch { /* */ }
      this.proc = null
    }
  }

  private restart() {
    this.stop()
    this.retryTimer = setTimeout(() => this.spawnParec(), 200)
  }

  private spawnParec() {
    const target = this.targets[this.currentTargetIdx % this.targets.length]
    console.log('[audio] spawning parec on target:', target)

    const args = [
      `--device=${target}`,
      '--rate=48000',
      '--channels=1',
      '--format=s16le',
      '--latency-msec=50',
      '--raw',
    ]
    let proc: ChildProcess
    try {
      proc = spawn('parec', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      console.warn('[audio] failed to spawn parec — is pipewire-pulse / pulseaudio installed?', err)
      return
    }
    this.proc = proc

    proc.stdout?.on('data', (chunk: Buffer) => {
      const w = this.getWindow()
      if (w?.webContents && !w.webContents.isDestroyed()) {
        try {
          w.webContents.send('audio:pcm', chunk)
        } catch { /* renderer closing */ }
      }
    })

    proc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) console.log('[audio:parec]', msg)
    })

    proc.on('exit', (code) => {
      console.log('[audio] parec exited code=', code, ' target=', target)
      this.proc = null
      // If parec failed quickly on this target, advance to the next.
      this.currentTargetIdx++
      this.retryTimer = setTimeout(() => this.spawnParec(), 1500)
    })

    proc.on('error', (err) => {
      console.warn('[audio] parec child error', err)
    })
  }
}
