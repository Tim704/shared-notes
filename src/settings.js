// Per-device settings (localStorage). Nothing here is shared with other people;
// these are "how this browser behaves" switches.

const KEY = 'notesSettings'

const DEFAULTS = {
  spellcheck: false, // red squiggles in note bodies
  arrows: true, // auto-replace -> => <- -- with real glyphs while typing
  offline: true, // keep a copy of the board in this browser (IndexedDB)
  launch: 'last', // 'last' tab or 'home' page on open
}

let cache = null
const listeners = []

export function getSettings() {
  if (cache) return cache
  let saved = {}
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}
  } catch {
    saved = {}
  }
  cache = { ...DEFAULTS, ...saved }
  return cache
}

export function setSetting(key, value) {
  const s = getSettings()
  if (s[key] === value) return
  s[key] = value
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* storage disabled; keep it in memory for this session */
  }
  listeners.forEach((fn) => fn(key, value, s))
}

export function onSettingChange(fn) {
  listeners.push(fn)
  return () => {
    const i = listeners.indexOf(fn)
    if (i >= 0) listeners.splice(i, 1)
  }
}
