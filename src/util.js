// Small helpers shared across the client. Kept dependency-free.

export function genId() {
  // Random-ish, time-suffixed id. Good enough for note/tab keys on a LAN board.
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36)
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

export function relTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ago'
  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h ago'
  const d = Math.floor(h / 24)
  if (d < 7) return d + 'd ago'
  return new Date(ts).toLocaleDateString()
}

export function initials(name) {
  return (name || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

// Trailing throttle that coalesces calls into one animation frame.
export function rafThrottle(fn) {
  let scheduled = false
  let lastArgs = null
  return (...args) => {
    lastArgs = args
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      fn(...lastArgs)
    })
  }
}

// ---- colour ---------------------------------------------------------------

// Parse #rgb / #rrggbb into [r,g,b] (0..255). Returns null on anything else.
export function parseHex(hex) {
  if (typeof hex !== 'string') return null
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return null
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

// Relative luminance (WCAG) of a colour, 0 (black) .. 1 (white).
export function relLuminance(hex) {
  const rgb = parseHex(hex)
  if (!rgb) return 0.7
  const lin = rgb.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

// Pick readable ink for a given paper colour. Dark ink on light paper, light on dark.
export function inkFor(bg) {
  return relLuminance(bg) > 0.179 ? '#000000' : '#ffffff'
}
export function inkDimFor(bg) {
  // Start with subdued ink, increase opacity until normal text reaches AA.
  const rgb = parseHex(bg) || [255, 255, 255]
  const dark = relLuminance(bg) > 0.179
  for (const alpha of [.65, .75, .85, 1]) {
    const hex = '#' + rgb.map(c => Math.round(c * (1 - alpha) + (dark ? 0 : 255) * alpha).toString(16).padStart(2, '0')).join('')
    const a = relLuminance(bg), b = relLuminance(hex)
    if ((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5) return hex
  }
  return inkFor(bg)
}
// A faint hairline that reads on either paper.
export function hairlineFor(bg) {
  return relLuminance(bg) > 0.48 ? 'rgba(0,0,0,0.14)' : 'rgba(255,255,255,0.18)'
}

// Quick paper swatches (the original palette) plus a couple extra.
export const PAPER = [
  '#fff7a8',
  '#ffd6a5',
  '#ffadad',
  '#a0e7e5',
  '#caffbf',
  '#d8c4ff',
  '#bde0fe',
  '#ffffff',
]

// Render only: never persist adapted colours into the shared document.
export const DARK_PAPER = Object.fromEntries(PAPER.map((hex, i) => [hex,
  ['#39351f', '#3d3022', '#40282b', '#203737', '#293724', '#332b42', '#253443', '#1c1c1e'][i]]))
export function renderedPaper(hex, theme = document.documentElement.dataset.theme) {
  return theme === 'dark' ? DARK_PAPER[normalizeHex(hex)] || hex : hex
}

// Fixed inks for drawings and exported documents; intentionally theme independent.
export const SYSTEM_COLORS = ['#ff3b30', '#ff9500', '#34c759', '#007aff', '#5856d6', '#af52de', '#ff2d55', '#30b0c7']
export const DOCUMENT_INK = '#1c1c1e'
export const DOCUMENT_PAPER = '#ffffff'

export const PRESENCE = [
  ...SYSTEM_COLORS,
]

// Quick pen colours for the sketch toolbar — a few inks that read on the light
// canvas, the brand yellow, and a couple of brights.
export const PEN_COLORS = [
  DOCUMENT_INK, '#ff3b30', '#ff9500', '#ffcc00', '#248a3d', '#007aff', '#af52de', DOCUMENT_PAPER,
]

// ---- per-user favourites (local only) -------------------------------------
const FAV_KEY = 'notesFavColors'

export function getFavorites() {
  try {
    const v = JSON.parse(localStorage.getItem(FAV_KEY) || '[]')
    return Array.isArray(v) ? v.filter((c) => parseHex(c)) : []
  } catch {
    return []
  }
}

export function addFavorite(color) {
  if (!parseHex(color)) return getFavorites()
  const norm = normalizeHex(color)
  const list = getFavorites().filter((c) => normalizeHex(c) !== norm)
  list.unshift(norm)
  const trimmed = list.slice(0, 12)
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(trimmed))
  } catch {
    /* storage full / disabled */
  }
  return trimmed
}

export function removeFavorite(color) {
  const norm = normalizeHex(color)
  const list = getFavorites().filter((c) => normalizeHex(c) !== norm)
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(list))
  } catch {
    /* ignore */
  }
  return list
}

export function normalizeHex(hex) {
  const rgb = parseHex(hex)
  if (!rgb) return hex
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('')
}
