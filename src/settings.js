// Per-device settings (localStorage). Nothing here is shared with other people;
// these are "how this browser behaves" switches.

const KEY = 'notesSettings'

const DEFAULTS = {
  theme: 'system', // resolved at paint time; never shared in the document
  ribbon: 'always', // the toolbar under the tabs: 'always' shown, or only while 'editing'
  spellcheck: false, // red squiggles in note bodies
  arrows: true, // auto-replace -> => <- -- with real glyphs while typing
  offline: true, // keep a copy of the board in this browser (IndexedDB)
  launch: 'last', // 'last' tab or 'home' page on open
  backupExclude: [], // tab ids this device leaves out of its own backups
  snap: true, // snap notes to their neighbours' edges while dragging
  grid: false, // also snap to a grid
  gridSize: 20,
  phoneCols: 2, // phone grid: 1 or 2 columns
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

const systemTheme = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null
export function applyTheme() {
  if (!systemTheme) return
  const choice = getSettings().theme
  const theme = choice === 'light' || choice === 'dark' ? choice : systemTheme.matches ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  document.querySelectorAll('meta[name="theme-color"]').forEach(meta => {
    meta.content = choice === 'light' || choice === 'dark'
      ? theme === 'dark' ? '#000000' : '#f2f2f7'
      : meta.media.includes('dark') ? '#000000' : '#f2f2f7'
  })
  window.dispatchEvent(new CustomEvent('notes-theme-change', { detail: theme }))
}
systemTheme?.addEventListener('change', () => { if (getSettings().theme === 'system') applyTheme() })
onSettingChange(key => { if (key === 'theme') applyTheme() })
if (systemTheme) applyTheme()
