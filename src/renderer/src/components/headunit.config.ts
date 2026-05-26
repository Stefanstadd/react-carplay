// =============================================================================
//  HEAD UNIT — USER-EDITABLE SETTINGS
// =============================================================================
//  All the knobs you'll typically want to tweak live in this single file so
//  you can edit it locally on the Pi without colliding with future `git pull`
//  on other files.  Everything else stays out of your way.
//
//  After editing, save — Vite HMR will live-reload the head unit.  No
//  restart needed.
// =============================================================================

// ─── EQ visualiser ──────────────────────────────────────────────────────────

/** How many bars to draw across the spectrum.  More = thinner / finer. */
export const NUM_BARS = 32

/** Frequency range covered by the bars (log-spaced).  50 Hz – 18 kHz is a
 *  good musical default; widen to 30–20000 for the "full audible" sweep. */
export const F_MIN_HZ = 50
export const F_MAX_HZ = 18000

/** Peak-hold decay each frame.  Lower = snappier fall.
 *    0   → bars snap to value every frame (jittery)
 *    0.5 → drop to half each frame (~120 ms to ~10 %)
 *    0.8 → smooth, slower drop
 *    1   → bars never fall */
export const EQ_FALL_FACTOR = 0.5

/** Gamma curve on each bar.  >1 emphasises peaks vs depths.
 *    0.5 → boost everything (always-active look)
 *    1   → linear
 *    1.3 → mild contrast (default)
 *    2   → strong contrast */
export const EQ_GAMMA = 1.3

/** Noise gate: bars below this fraction are clamped to 0 so quiet sections
 *  actually drop to nothing instead of hovering at the floor. */
export const EQ_NOISE_GATE = 0.04

/** Color blend points for each bar (dim → bright).  Bars below LO are
 *  full-dim, above HI are full-bright, in between are mixed. */
export const BAR_MIX_LO = 0.6
export const BAR_MIX_HI = 0.9

/** Show the "60 / 1k / 10k" frequency labels under the bars.  Set to
 *  false for a cleaner, minimal look. */
export const SHOW_FREQ_LABELS = true

// ─── Music view layout ──────────────────────────────────────────────────────

/** Album-art square size in px (height & width). */
export const ALBUM_ART_SIZE = 180

/** Scroll speed for long track titles, px / second.  Higher = faster slide.
 *  Only used when the title is too long to fit in one go. */
export const TITLE_SCROLL_SPEED = 60

// ─── Quick-access buttons (top-left of music view) ─────────────────────────

/** Pixel size of each quick-button's icon. */
export const QUICK_BTN_ICON_SIZE = 110

/** Cell size of each quick button (the touch target). */
export const QUICK_BTN_CELL_SIZE = 150

// ─── CarPlay overlay ────────────────────────────────────────────────────────

/** Multiplier for the ← EXIT button in the top-left of CarPlay.
 *  1.0 = original size, 1.8 = much chunkier (easier to hit while driving). */
export const CARPLAY_EXIT_BTN_SCALE = 1.8
