// Captures audio from a PulseAudio/PipeWire monitor source in the main
// process via the `parec` CLI (which exists on every Pi with pipewire-pulse
// installed) and streams raw s16le PCM to the renderer over IPC.  The
// renderer accumulates the samples in a ring buffer and runs an FFT in JS.
//
// This replaces the previous getUserMedia + module-remap-source dance which
// kept breaking because (a) Chromium hides PA monitor sources from
// enumerateDevices() and (b) pactl-loaded remap-sources don't always wire
// their master link properly on PipeWire-pulse.

import { spawn, ChildProcess, execFile } from 'child_process'
import { BrowserWindow } from 'electron'

// Preferred sink monitors — tried in order.  @DEFAULT_MONITOR@ is a
// pipewire-pulse magic name that resolves to whatever sink is currently
// default; putting it first means we track whatever the user has selected
// system-wide (built-in audio, HDMI, BT sink, etc.).  The named targets
// stay as fallbacks so the visualiser still works if the default sink
// isn't a monitor-capable device (or hasn't loaded yet at boot).
//
// Explicitly NOT tied to the CarPlay dongle's audio device — the viz
// must work regardless of whether the dongle is plugged in.
const DEFAULT_TARGETS = [
  '@DEFAULT_MONITOR@',
  'headunit_eq.monitor',
  'alsa_output.usb-C-Media_Electronics_Inc._USB_Audio_Device-00.analog-stereo.monitor',
]

export class AudioCapture {
  private proc: ChildProcess | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private currentTargetIdx = 0
  private targets: string[] = DEFAULT_TARGETS
  private detectedTargets: string[] | null = null

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
    // Probe pactl for whichever monitor sources currently exist, then
    // start parec on the first one that also happens to be in our
    // preferred list.  Falls back to the static DEFAULT_TARGETS if pactl
    // isn't available or the probe returns nothing.
    this.detectMonitors().then(() => this.spawnParec())
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

  /** Ask pactl what monitor sources are actually available right now and
   *  build a target list that prepends them ahead of the static defaults.
   *  This is what makes the visualiser work on a bare Pi without a
   *  specific dongle — we don't cycle through non-existent devices for
   *  seconds before landing on something that exists. */
  private detectMonitors(): Promise<void> {
    return new Promise((resolve) => {
      execFile('pactl', ['list', 'sources', 'short'], (err, stdout) => {
        if (err) {
          console.warn('[audio] pactl probe failed, using static target list:', err.message)
          return resolve()
        }
        const monitors: string[] = []
        for (const line of stdout.split('\n')) {
          const cols = line.trim().split(/\s+/)
          const name = cols[1]
          if (!name) continue
          // Keep only *.monitor sources — those expose the audio being
          // played by a sink, which is what we want to visualise.
          if (!name.endsWith('.monitor')) continue
          monitors.push(name)
        }
        if (monitors.length === 0) {
          console.warn('[audio] pactl probe returned no monitor sources — using static targets')
          return resolve()
        }
        console.log('[audio] detected monitor sources:', monitors.join(', '))
        // Preferred order: @DEFAULT_MONITOR@ first (tracks whatever the
        // user picks), then any detected monitor whose name matches our
        // known-good list, then any other detected monitor, then the
        // static defaults as a final fallback.
        const preferred = DEFAULT_TARGETS.filter(t => t.startsWith('@') || monitors.includes(t))
        const extras    = monitors.filter(m => !DEFAULT_TARGETS.includes(m))
        this.detectedTargets = [...preferred, ...extras, ...DEFAULT_TARGETS.filter(t => !preferred.includes(t))]
        // Dedupe while preserving order.
        const seen = new Set<string>()
        this.detectedTargets = this.detectedTargets.filter(t => (seen.has(t) ? false : (seen.add(t), true)))
        console.log('[audio] target order:', this.detectedTargets.join(' → '))
        resolve()
      })
    })
  }

  private spawnParec() {
    const list = this.detectedTargets ?? this.targets
    const target = list[this.currentTargetIdx % list.length]
    console.log('[audio] spawning parec on target:', target)
    const spawnedAt = Date.now()

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
      const ranMs = Date.now() - spawnedAt
      console.log('[audio] parec exited code=', code, 'target=', target, 'ran=', ranMs, 'ms')
      this.proc = null
      // Fast-fail (< 500 ms) usually means the target doesn't exist — jump
      // to the next candidate immediately.  A long run followed by an exit
      // means the sink went away (device unplugged, user switched output);
      // re-probe from scratch so we pick up whatever's now available.
      if (ranMs < 500) {
        this.currentTargetIdx++
        this.retryTimer = setTimeout(() => this.spawnParec(), 400)
      } else {
        this.currentTargetIdx = 0
        this.detectedTargets = null
        this.retryTimer = setTimeout(() => this.detectMonitors().then(() => this.spawnParec()), 800)
      }
    })

    proc.on('error', (err) => {
      console.warn('[audio] parec child error', err)
    })
  }
}
