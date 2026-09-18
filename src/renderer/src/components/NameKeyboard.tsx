// Shared on-screen QWERTY keyboard.  Used to name equalizer presets and
// theme presets so users don't need to reach for a physical keyboard on
// the Pi's 5.5" touchscreen.
//
// Buttons are sized generously (see .hu-eq-kb-key in HeadUnit.css) and a
// dedicated "CLR" key wipes the current input.

import { useState } from 'react'

const KB_ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM']

export interface NameKeyboardProps {
  /** Text shown above the input (e.g. "PRESET NAME"). */
  prompt?: string
  /** Initial text in the input field. */
  initial: string
  /** Called when the user dismisses without saving. */
  onCancel: () => void
  /** Called with the trimmed value when the user hits SAVE. */
  onAccept: (name: string) => void
  /** Max characters — defaults to 24 (fits a settings row cleanly). */
  maxLength?: number
}

export default function NameKeyboard({
  prompt = 'PRESET NAME',
  initial,
  onCancel,
  onAccept,
  maxLength = 24
}: NameKeyboardProps) {
  const [value, setValue] = useState(initial)
  const append = (ch: string) => setValue(v => (v + ch).slice(0, maxLength))
  const back = () => setValue(v => v.slice(0, -1))
  const clear = () => setValue('')

  return (
    <div className="hu-eq-kb-overlay" onPointerDown={onCancel}>
      <div className="hu-eq-kb-panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="hu-eq-kb-prompt">{prompt}</div>
        <div className="hu-eq-kb-display-row">
          <div className="hu-eq-kb-display">
            {value || <span className="hu-eq-kb-placeholder">—</span>}
          </div>
          <button
            className="hu-eq-kb-key hu-eq-kb-key-clear"
            onClick={clear}
            disabled={!value}
            aria-label="Clear input"
          >
            CLR
          </button>
        </div>

        {KB_ROWS.map((row, ri) => (
          <div key={ri} className="hu-eq-kb-row" style={{ paddingLeft: ri * 44 }}>
            {row.split('').map(k => (
              <button key={k} className="hu-eq-kb-key" onClick={() => append(k)}>{k}</button>
            ))}
          </div>
        ))}
        <div className="hu-eq-kb-row">
          <button className="hu-eq-kb-key hu-eq-kb-key-wide" onClick={() => append(' ')}>SPACE</button>
          <button className="hu-eq-kb-key" onClick={back}>⌫</button>
          <button className="hu-eq-kb-key hu-eq-kb-key-wide" onClick={onCancel}>CANCEL</button>
          <button
            className="hu-eq-kb-key hu-eq-kb-key-wide hu-eq-kb-key-accept"
            onClick={() => value.trim() && onAccept(value.trim())}
            disabled={!value.trim()}
          >
            SAVE
          </button>
        </div>
      </div>
    </div>
  )
}
