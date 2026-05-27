// =============================================================================
//  HEAD UNIT — USER-EDITABLE SETTINGS
// =============================================================================
//  All the knobs you'll typically want to tweak live in this single file so
//  you can edit it locally on the Pi without colliding with future `git pull`
//  on other files.  Save and Vite HMR will hot-update the head unit.
// =============================================================================

// ─── Audio visualiser ──────────────────────────────────────────────────────
// Drives the bars + peak indicators on the music screen.  Pipeline:
//   PCM → Hann window → 4096-pt FFT → log-spaced bands → RMS energy → dBFS
//      → bass/high shaping → noise gate → gamma → attack/release smoothing
//      → adaptive gain → peak hold + gravity.
export const VIZ_CONFIG = {
  /** Number of bars across the spectrum. */
  bars: 32,

  /** Frequency range covered, log-spaced. */
  minHz: 20,
  maxHz: 20000,

  /** Per-band temporal smoothing.  Bigger attack = faster rise.
   *  Smaller release = slower, smoother fall. */
  attackSpeed: 0.75,
  releaseSpeed: 0.06,

  /** Peak-hold marker physics.  Marker holds for peakHoldTime ms after a
   *  new peak, then starts falling under "gravity" (peakFallSpeed adds to
   *  its velocity each frame). */
  peakHoldTime: 120,
  peakFallSpeed: 0.04,

  /** Visual contrast.  >1 emphasises peaks; <1 boosts the middle. */
  gamma: 1.35,

  /** Bars below this fraction (after smoothing) clamp to zero so quiet
   *  noise floor doesn't show. */
  noiseGate: 0.015,

  /** Static gain multiplier on every bar value before clamping to 1.0.
   *  Replaces the old adaptive-leveling (which felt visibly slow).  Crank
   *  if bars feel small, drop if they slam the ceiling on every transient. */
  gain: 1.5,

  /** Frequency-band shaping.  Bass bars (<250 Hz) get this multiplier so
   *  the kick still feels punchy.  High bars (>4 kHz) get damped so the
   *  visualizer doesn't go wild on cymbals. */
  bassBoost: 1.15,
  highFrequencyDamping: 0.9,

  /** Web-Audio-style temporal smoothing on the raw FFT magnitudes
   *  (0 = instant updates, ~1 = heavy averaging).  Different from attack/
   *  release which act on the per-band normalized value. */
  smoothing: 0.18,

  /** Color curve exponent for the bar palette.  >1 spreads the colour
   *  toward the upper end (more visible mid shades, peaks pop bright);
   *  <1 spreads toward the lower end (everything looks active). */
  colorCurve: 1.6,

  /** Glow intensity multiplier for the bars (uses CSS box-shadow). */
  glowStrength: 0.7,

  /** Show the "60 / 1k / 10k" frequency labels under the bars. */
  showFrequencyLabels: false,
}

// ─── Music view layout ──────────────────────────────────────────────────────
/** Album-art square size in px (height & width). */
export const ALBUM_ART_SIZE = 180

/** Scroll speed for long track titles, px / second. */
export const TITLE_SCROLL_SPEED = 60

// ─── Quick-access buttons (top-left of music view) ─────────────────────────
/** Pixel size of each quick-button's icon. */
export const QUICK_BTN_ICON_SIZE = 110
/** Cell size of each quick button (the touch target). */
export const QUICK_BTN_CELL_SIZE = 150

// ─── CarPlay overlay ────────────────────────────────────────────────────────
/** Multiplier for the ← EXIT button.  1.0 = original, 1.8 = much chunkier. */
export const CARPLAY_EXIT_BTN_SCALE = 1.8

// ─── Vite HMR hook ──────────────────────────────────────────────────────────
// Tell Vite this module accepts its own hot updates so saves trigger an
// in-place update of the importing component instead of a full page reload.
if (import.meta.hot) {
  import.meta.hot.accept()
}
