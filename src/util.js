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
  return relLuminance(bg) > 0.48 ? '#1f2228' : '#f3f5f8'
}
export function inkDimFor(bg) {
  return relLuminance(bg) > 0.48 ? 'rgba(20,24,30,0.5)' : 'rgba(243,245,248,0.55)'
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

export const PRESENCE = [
  '#ef4444',
  '#f59e0b',
  '#10b981',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
]

// Quick pen colours for the sketch toolbar — a few inks that read on the light
// canvas, the brand yellow, and a couple of brights.
export const PEN_COLORS = [
  '#1f2228',
  '#e23b3b',
  '#f5a623',
  '#ffd23f',
  '#2ca24c',
  '#2d7ff9',
  '#8b5cf6',
  '#ffffff',
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
