import { icon as makeIcon, iconHTML, iconLabel, mountIcons, iconNames } from './icons.js'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

import { IndexeddbPersistence } from 'y-indexeddb'
import { bindRichText } from './richbody.js'
import { createDrawSurface } from './draw.js'
import { getSettings, setSetting, onSettingChange } from './settings.js'
import * as ui from './ui.js'
import { snippetOf } from '../shared/serialise.js'
import { markdownToLines, linesOf, embedOf, genLineId, HIGHLIGHTS } from '../shared/lines.js'
import { replaceAllLines, ensureTerminator, insertLinesAt, appendLines } from '../shared/lineops.js'
import { normTitle, namesOf, aliasesOf, parseTarget, followRename, rewriteLinks, nameTaken, backlinks, unlinkedMentions, linkMention, tagCounts, renameTag } from '../shared/links.js'
import { parseQuery, noteFacts, matchFacts } from '../shared/search.js'
import { openSwitcher, rank as rankItems } from './switcher.js'
import { initHoverPreview } from './preview.js'
import { importFiles } from './importer.js'
import { uploadImages, openLightbox, pickImages } from './media.js'
import { createFoldStore } from './folds.js'
import * as backup from './backup.js'
import { createMindMap } from './mindmap.js'
import { createTasksView } from './tasks.js'
import { dueCount, ymd } from '../shared/tasks.js'
import { createViewport } from './viewport.js'
import { createInk } from './ink.js'
import { initTooltips } from './tooltip.js'
import { createRibbon, setPressed } from './ribbon.js'
import { createGuides, snapMove, snapResize, alignRects, distributeRects, matchSize, tidyRects } from './snap.js'
import {
  genId,
  clamp,
  rafThrottle,
  debounce,
  relTime,
  initials,
  PAPER,
  PRESENCE,
  PEN_COLORS,
  getFavorites,
  addFavorite,
  removeFavorite,
  normalizeHex,
  inkFor,
  inkDimFor,
  hairlineFor,
  renderedPaper,
  DOCUMENT_INK,
} from './util.js'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

// ---------------------------------------------------------------------------
// Reconnecting WebSocket provider (y-protocols sync + awareness). Kept tiny.
// ---------------------------------------------------------------------------
class WSProvider {
  constructor(url, doc, awareness) {
    this.url = url
    this.doc = doc
    this.awareness = awareness
    this.ws = null
    this.shouldConnect = true
    this.delay = 800
    this.statusCbs = []
    this.syncCbs = []
    this.synced = false

    doc.on('update', (update, origin) => {
      if (origin === this) return
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MESSAGE_SYNC)
      syncProtocol.writeUpdate(enc, update)
      this.#send(encoding.toUint8Array(enc))
    })

    awareness.on('update', ({ added, updated, removed }, origin) => {
      if (origin === 'remote') return
      const changed = added.concat(updated, removed)
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(
        enc,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changed)
      )
      this.#send(encoding.toUint8Array(enc))
    })

    window.addEventListener('beforeunload', () => {
      awarenessProtocol.removeAwarenessStates(awareness, [doc.clientID], 'unload')
    })

    this.#connect()
  }

  onStatus(cb) {
    this.statusCbs.push(cb)
  }

  // Fires once, after the server's initial state (SyncStep2) has been applied.
  onSync(cb) {
    if (this.synced) cb()
    else this.syncCbs.push(cb)
  }

  #emit(connected) {
    this.statusCbs.forEach((cb) => cb(connected))
  }

  #connect() {
    if (this.ws || !this.shouldConnect) return
    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      this.delay = 800
      this.#emit(true)
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MESSAGE_SYNC)
      syncProtocol.writeSyncStep1(enc, this.doc)
      ws.send(encoding.toUint8Array(enc))
      if (this.awareness.getLocalState() !== null) {
        const enc2 = encoding.createEncoder()
        encoding.writeVarUint(enc2, MESSAGE_AWARENESS)
        encoding.writeVarUint8Array(
          enc2,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID])
        )
        ws.send(encoding.toUint8Array(enc2))
      }
    }

    ws.onmessage = (ev) => this.#receive(new Uint8Array(ev.data))

    ws.onclose = () => {
      this.ws = null
      this.#emit(false)
      if (this.shouldConnect) {
        setTimeout(() => this.#connect(), this.delay)
        this.delay = Math.min(this.delay * 1.5, 10000)
      }
    }

    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }

  #receive(bytes) {
    const decoder = decoding.createDecoder(bytes)
    const type = decoding.readVarUint(decoder)
    if (type === MESSAGE_SYNC) {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MESSAGE_SYNC)
      const syncType = syncProtocol.readSyncMessage(decoder, enc, this.doc, this)
      if (encoding.length(enc) > 1) this.#send(encoding.toUint8Array(enc))
      if (!this.synced && syncType === syncProtocol.messageYjsSyncStep2) {
        this.synced = true
        this.syncCbs.forEach((cb) => cb())
        this.syncCbs = []
      }
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        'remote'
      )
    }
  }

  #send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(message)
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Bind a Y.Text to a plain <input> (used for note titles). Body uses richbody.
// ---------------------------------------------------------------------------
function bindInput(ytext, el, afterRemote) {
  let applyingRemote = false
  const origin = { binding: 'input' } // per binding: a second input on the same text sees our edits
  el.value = ytext.toString()

  const observer = (event) => {
    if (event.transaction.origin === origin) return
    applyingRemote = true
    let start = el.selectionStart
    let end = el.selectionEnd
    let index = 0
    for (const op of event.delta) {
      if (op.retain != null) {
        index += op.retain
      } else if (op.insert != null) {
        const len = typeof op.insert === 'string' ? op.insert.length : 1
        if (index < start) start += len
        if (index < end) end += len
        index += len
      } else if (op.delete != null) {
        const len = op.delete
        if (index < start) start -= Math.min(len, start - index)
        if (index < end) end -= Math.min(len, end - index)
      }
    }
    el.value = ytext.toString()
    try {
      el.setSelectionRange(start, end)
    } catch {
      /* not selectable now */
    }
    applyingRemote = false
    if (afterRemote) afterRemote()
  }

  const onInput = () => {
    if (applyingRemote) return
    const next = el.value
    const prev = ytext.toString()
    if (next === prev) return
    let start = 0
    const min = Math.min(next.length, prev.length)
    while (start < min && next[start] === prev[start]) start++
    let pEnd = prev.length
    let nEnd = next.length
    while (pEnd > start && nEnd > start && prev[pEnd - 1] === next[nEnd - 1]) {
      pEnd--
      nEnd--
    }
    ytext.doc.transact(() => {
      if (pEnd > start) ytext.delete(start, pEnd - start)
      if (nEnd > start) ytext.insert(start, next.slice(start, nEnd))
    }, origin)
  }

  ytext.observe(observer)
  el.addEventListener('input', onInput)

  return () => {
    ytext.unobserve(observer)
    el.removeEventListener('input', onInput)
  }
}

// ---------------------------------------------------------------------------
// App / shared state
// ---------------------------------------------------------------------------
const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'
const doc = new Y.Doc()
const awareness = new awarenessProtocol.Awareness(doc)
const provider = new WSProvider(wsUrl, doc, awareness)

const yNotes = doc.getMap('notes') // id -> Y.Map { title:Y.Text, body:Y.Text, color, created, tabId, fontSize, size }
const yOrder = doc.getArray('order') // [id, ...] newest first
const yTabs = doc.getArray('tabs') // Y.Map{ id, name, kind, archived } (legacy entries are plain objects)
const yDrawings = doc.getMap('drawings') // tabId -> Y.Array<stroke> (sketch tabs); 'ink:'+tabId -> ink on a notes tab
const yPages = doc.getMap('pages') // tabId -> Y.Map{ title:Y.Text, body:Y.Text } (document and mind map tabs)

// Keep a copy of the whole board in this browser (IndexedDB) so it opens
// instantly and still works when the Pi is off. Per-device switch in settings.
let localStore = null
function applyOfflineSetting() {
  const want = getSettings().offline
  if (want && !localStore) {
    try {
      localStore = new IndexeddbPersistence('shared-notes', doc)
    } catch {
      localStore = null
    }
  } else if (!want && localStore) {
    const ls = localStore
    localStore = null
    ls.clearData().catch(() => {})
  }
}
applyOfflineSetting()

const SIZES = { s: 'size-s', m: 'size-m', l: 'size-l' }
const SIZE_W = { s: 190, m: 250, l: 366 } // preset → pixel width (free layout)
const W_MIN = 150
const H_MIN = 90
const W_DEFAULT = 250
const H_DEFAULT = 200
const FS_MIN = 11
const FS_MAX = 26
const FS_DEFAULT = 14

// ---- identity / presence ----
let me = null
try {
  me = JSON.parse(localStorage.getItem('notesUser') || 'null')
} catch {
  me = null
}
if (!me || !me.name) {
  me = { name: 'Anon', color: PRESENCE[Math.floor(Math.random() * PRESENCE.length)], fresh: true }
}
if (!me.id) me.id = genId() // stable per-browser id, used for "edited by"
function saveMe() {
  const { fresh, ...rest } = me
  localStorage.setItem('notesUser', JSON.stringify(rest))
}
saveMe()
if (me.fresh) {
  // first run: ask in-app (the old window.prompt blocked the whole page)
  ui.prompt('Pick a name so friends know who is typing:', '', { title: 'Welcome', maxLength: 24 }).then((name) => {
    const n = (name || '').trim().slice(0, 24)
    if (n) {
      me = { ...me, name: n }
      delete me.fresh
      saveMe()
      awareness.setLocalStateField('user', me)
      youName.textContent = me.name
    }
  })
  delete me.fresh
}
awareness.setLocalStateField('user', me)
awareness.setLocalStateField('focus', null)

// ---- elements ----
const board = document.getElementById('board')
const empty = document.getElementById('empty')
const peopleEl = document.getElementById('people')
const dot = document.getElementById('conn-dot')
const search = document.getElementById('search')
const searchWrap = document.getElementById('search-wrap')
const youName = document.getElementById('you-name')
const tabsEl = document.getElementById('tabs')
const addBtn = document.getElementById('add')
const drawView = document.getElementById('draw-view')
const canvasHost = document.getElementById('canvas-host')
const drawBar = document.getElementById('draw-bar')
const pageView = document.getElementById('page-view')
youName.textContent = me.name
youName.style.setProperty('--me', me.color)

// A deploy restarts the Pi: when we reconnect to a server with a newer app, offer
// to reload (or just do it while the page is in the background), so old code
// never keeps editing a board whose format moved on.
const myVersion = (/[?&]v=([\w-]+)/.exec(document.querySelector('script[src*="bundle.js"]')?.getAttribute('src') || '') || [])[1] || null
let updateOffered = false
function checkForUpdate() {
  if (!myVersion || updateOffered) return
  fetch('/health', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((h) => {
      if (!h || !h.version || h.version === myVersion || updateOffered) return
      updateOffered = true
      if (document.hidden) return location.reload()
      ui.toast('A new version of Notes is ready.', { action: 'Reload', ms: 600000, onAction: () => location.reload() })
      document.addEventListener('visibilitychange', () => document.hidden && location.reload())
    })
    .catch(() => {})
}
let everConnected = false
provider.onStatus((connected) => {
  if (connected && everConnected) checkForUpdate()
  if (connected) everConnected = true
  dot.classList.toggle('on', connected)
  dot.title = connected ? 'Connected' : 'Reconnecting...'

  dot.setAttribute('aria-label', dot.title)
})

// ---- active tab (per-user) ----
let activeTabId = null
let navQuiet = 0 // > 0 while a popped history entry is being applied: push nothing (see navPush)
let poppedAt = 0
try {
  activeTabId = localStorage.getItem('notesActiveTab') || null
} catch {
  activeTabId = null
}

// Tab entries: new ones are Y.Maps (so a rename is one field write and merges
// cleanly); old boards still hold plain objects. Everything reads through tabRec.
function tabRec(t) {
  if (!t) return null
  if (typeof t.get === 'function') {
    return {
      id: t.get('id'),
      name: t.get('name') || '',
      kind: t.get('kind') || 'notes',
      archived: !!t.get('archived'),
      view: t.get('view') === 'canvas' ? 'canvas' : 'board',
      icon: t.get('icon') || null,
      color: t.get('color') || null,
    }
  }
  return {
    id: t.id,
    name: t.name || '',
    kind: t.kind || 'notes',
    archived: !!t.archived,
    view: t.view === 'canvas' ? 'canvas' : 'board',
    icon: t.icon || null,
    color: t.color || null,
  }
}
function tabsList() {
  return yTabs.toArray().map(tabRec).filter((t) => t && t.id)
}
function tabIndex(id) {
  return tabsList().findIndex((t) => t.id === id)
}
function activeTab() {
  const list = tabsList()
  if (list.length === 0) return null
  const found = list.find((t) => t.id === activeTabId)
  return found || list.find((t) => !t.archived) || list[0]
}
// opts.push === false: don't add a history entry (internal moves, Back itself)
function setActiveTab(id, opts = {}) {
  const changed = id !== activeTabId
  activeTabId = id
  if (changed && opts.push !== false) navPush({})
  try {
    localStorage.setItem('notesActiveTab', id)
  } catch {
    /* ignore */
  }
  awareness.setLocalStateField('tab', id)
  closeHome()
  scheduleReconcile()
}

function makeTabMap(rec) {
  const m = new Y.Map()
  m.set('id', rec.id)
  m.set('name', rec.name)
  m.set('kind', rec.kind || 'notes')
  if (rec.archived) m.set('archived', true)
  if (rec.view === 'canvas') m.set('view', 'canvas') // reordering a tab keeps its canvas view
  if (rec.icon) m.set('icon', rec.icon)
  if (rec.color) m.set('color', rec.color)
  return m
}

// Change a field on a tab. Y.Map tabs get a plain set; a legacy plain-object
// entry is upgraded to a Y.Map in place (delete + insert, the same as before).
function updateTab(id, patch) {
  const i = tabIndex(id)
  if (i < 0) return
  const raw = yTabs.get(i)
  doc.transact(() => {
    if (typeof raw.get === 'function') {
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === false) raw.delete(k)
        else raw.set(k, v)
      }
    } else {
      yTabs.delete(i, 1)
      yTabs.insert(i, [makeTabMap({ ...tabRec(raw), ...patch })])
    }
  })
}

// ---- tab icon & colour ----
// A tab's `icon` is 'i:<name>' (one of the app's line icons) or an emoji;
// `color` is a key of TAB_COLORS. Both are optional; without them the icon
// comes from the tab's kind.
const TAB_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink']
const TAB_EMOJI = '📝 📚 📖 ✏️ 🧠 💡 🎯 ✅ 📅 ⏰ 🗂️ 📌 🏠 💼 🎓 🧪 🧮 📐 💻 🎨 🎵 🎮 ⚽ 🏃 🍳 🛒 ✈️ 🌍 🌱 💰 ❤️ ⭐ 🔥 🚀 🐶 ☕ 🎉 🔒 🛠️ 📷'.split(' ')
function tabGlyph(t, cls = 'tab-glyph') {
  const v = t.icon || ''
  let el
  if (v && !v.startsWith('i:')) {
    el = document.createElement('span')
    el.className = cls + ' emoji'
    el.textContent = v
  } else {
    const name = v.startsWith('i:') ? v.slice(2) : kindInfo(t.kind).icon
    el = document.createElement('span')
    el.className = cls
    el.appendChild(makeIcon(name))
  }
  if (t.color && TAB_COLORS.includes(t.color)) el.style.color = `var(--${t.color})`
  return el
}
// first grapheme of whatever was typed or pasted (so 👍🏽 or 🇳🇿 stay whole)
function firstGrapheme(str) {
  const v = String(str || '').trim()
  if (!v) return ''
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(v)) return segment
  }
  return Array.from(v)[0]
}

function openTabLook(t, anchor) {
  closeMenus()
  const box = document.createElement('div')
  box.className = 'menu tab-look'
  box.addEventListener('click', (e) => e.stopPropagation())
  const cur = () => tabsList().find((x) => x.id === t.id) || t
  const head = (text) => {
    const h = document.createElement('div')
    h.className = 'tab-look-h'
    h.textContent = text
    box.appendChild(h)
  }
  const grid = (cls) => {
    const g = document.createElement('div')
    g.className = 'tab-look-grid ' + cls
    box.appendChild(g)
    return g
  }
  const refresh = () => {
    const c = cur()
    box.querySelectorAll('[data-icon-v]').forEach((b) => b.setAttribute('aria-pressed', String((c.icon || '') === b.dataset.iconV)))
    box.querySelectorAll('[data-color-v]').forEach((b) => b.setAttribute('aria-pressed', String((c.color || '') === b.dataset.colorV)))
  }
  const setIcon = (v) => {
    updateTab(t.id, { icon: v || null })
    refresh()
  }

  head('Colour')
  const colors = grid('colors')
  for (const c of [''].concat(TAB_COLORS)) {
    const b = document.createElement('button')
    b.className = 'tab-look-swatch' + (c ? '' : ' none')
    b.dataset.colorV = c
    if (c) b.style.background = `var(--${c})`
    b.title = c ? c[0].toUpperCase() + c.slice(1) : 'No colour'
    b.setAttribute('aria-label', b.title)
    b.addEventListener('click', () => {
      updateTab(t.id, { color: c || null })
      refresh()
    })
    colors.appendChild(b)
  }

  head('Emoji')
  const emo = grid('emoji')
  for (const e of TAB_EMOJI) {
    const b = document.createElement('button')
    b.className = 'tab-look-cell emoji'
    b.dataset.iconV = e
    b.textContent = e
    b.setAttribute('aria-label', 'Emoji ' + e)
    b.addEventListener('click', () => setIcon(e))
    emo.appendChild(b)
  }
  const own = document.createElement('input')
  own.className = 'tab-look-input'
  own.placeholder = 'Or type / paste any emoji'
  own.setAttribute('aria-label', 'Any emoji')
  own.addEventListener('input', () => {
    const g = firstGrapheme(own.value)
    if (g && !/^[\p{L}\p{N}\s]$/u.test(g)) setIcon(g)
  })
  box.appendChild(own)

  head('Icon')
  const ico = grid('icons')
  const skip = new Set(['bold', 'italic', 'underline', 'strike', 'left', 'center', 'alignRight', 'close', 'down', 'more', 'numbers', 'square', 'redo', 'undo', 'expand', 'external', 'eraser', 'rows', 'swap'])
  for (const name of iconNames().filter((n) => !skip.has(n))) {
    const b = document.createElement('button')
    b.className = 'tab-look-cell'
    b.dataset.iconV = 'i:' + name
    b.appendChild(makeIcon(name))
    b.setAttribute('aria-label', 'Icon ' + name)
    b.addEventListener('click', () => setIcon('i:' + name))
    ico.appendChild(b)
  }

  const reset = document.createElement('button')
  reset.className = 'menu-item tab-look-reset'
  reset.textContent = 'Reset to default'
  reset.addEventListener('click', () => {
    updateTab(t.id, { icon: null, color: null })
    refresh()
  })
  box.appendChild(reset)

  document.body.appendChild(box)
  const r = anchor.getBoundingClientRect()
  box.style.left = Math.max(6, Math.min(r.left, window.innerWidth - box.offsetWidth - 6)) + 'px'
  box.style.top = r.bottom + 4 + 'px'
  refresh()
  const dismiss = ui.popover(box, anchor, { label: 'Tab icon and colour' })
  openMenus.push({ remove: dismiss })
}

// One-time migration: make sure a tab exists and legacy notes land in it.
function ensureDefaultTab() {
  if (yTabs.length > 0) return
  doc.transact(() => {
    if (yTabs.length > 0) return
    const id = genId()
    yTabs.push([makeTabMap({ id, name: 'Ideas', kind: 'notes' })])
    yNotes.forEach((n) => {
      if (!n.get('tabId')) n.set('tabId', id)
    })
  })
}

// Migration for the corkboard: give any note without x/y a tidy grid slot so
// legacy boards don't stack every note at 0,0. Deterministic (ordered by
// creation, grouped by tab) and idempotent, so it's safe if two clients run it.
function ensureNotePositions() {
  const ordered = yOrder.toArray().slice().reverse() // oldest first → stable grids
  const missing = ordered.some((id) => {
    const n = yNotes.get(id)
    return n && (n.get('x') == null || n.get('y') == null)
  })
  if (!missing) return
  const COLS = 4
  const COL_W = 260
  const ROW_H = 220
  doc.transact(() => {
    const perTab = new Map()
    for (const id of ordered) {
      const n = yNotes.get(id)
      if (!n) continue
      if (n.get('x') != null && n.get('y') != null) continue // already placed; leave it
      const tab = n.get('tabId') || '_'
      const idx = perTab.get(tab) || 0 // only count notes that actually get a slot
      perTab.set(tab, idx + 1)
      n.set('x', 16 + (idx % COLS) * COL_W)
      n.set('y', 16 + Math.floor(idx / COLS) * ROW_H)
      if (n.get('w') == null) n.set('w', SIZE_W[n.get('size')] || W_DEFAULT)
      if (n.get('h') == null) n.set('h', H_DEFAULT)
      if (n.get('z') == null) n.set('z', idx + 1)
    }
  })
}

function migrateBoard() {
  ensureDefaultTab()
  ensureNotePositions()
  if (getSettings().launch === 'home' && !location.hash) openHome()
}

// ---- tab operations ----
// What each kind of tab is called and drawn as. Unknown kinds show as notes.
const TAB_KINDS = {
  notes: { label: 'NotePad', menu: 'NotePad', icon: 'note', sub: null, blurb: 'Sticky notes, drawings and images on a board' },
  draw: { label: 'Sketch Pad', menu: 'Sketch Pad', icon: 'pencil', sub: 'Sketch Pad', blurb: 'Free drawing with images, more freedom' },
  doc: { label: 'Document', menu: 'Document', icon: 'text', sub: 'Document', blurb: 'Full text editor with images' },
  mindmap: { label: 'Mind map', menu: 'Mind map', icon: 'map', sub: 'Mind map', blurb: 'Brainstorm: ideas around a centre, placed freely and linked' },
  tasks: { label: 'To-do', menu: 'To-do', icon: 'todo', sub: 'To-do', blurb: 'Tasks broken into parts, with due dates and a calendar' },
}
const kindInfo = (kind) => TAB_KINDS[kind] || TAB_KINDS.notes
const isNotesTab = (t) => !!t && !TAB_KINDS[t.kind]?.sub

async function addTab(kind, { open = true, name: suggested } = {}) {
  const label = kindInfo(kind).label
  const typed = await ui.prompt(`Name this ${label.toLowerCase()} tab:`, suggested || label, { title: 'New tab', maxLength: 28 })
  if (typed == null) return null
  const name = typed.trim().slice(0, 28) || label
  const id = genId()
  doc.transact(() => {
    yTabs.push([makeTabMap({ id, name, kind })])
    if (kind === 'doc' || kind === 'mindmap' || kind === 'tasks') getPage(id, name)
  })
  if (open) setActiveTab(id)
  return id
}

// "Send to To-do" from a mind map: a branch arrives as a task with nested parts
async function sendToTodo(tabId, tree) {
  const id = tabId || (await addTab('tasks', { open: false, name: tree.text.slice(0, 28) }))
  if (!id) return
  const page = getPage(id, tabsList().find((t) => t.id === id)?.name)
  doc.transact(() => {
    if (!(page.get('items') instanceof Y.Map)) page.set('items', new Y.Map())
    const items = page.get('items')
    let top = 0
    items.forEach((m) => {
      if (!m.get('parent')) top = Math.max(top, Number(m.get('order')) || 0)
    })
    const put = (node, parent, order) => {
      const iid = genId()
      const m = new Y.Map()
      m.set('text', node.text)
      m.set('order', order)
      m.set('created', Date.now())
      if (parent) m.set('parent', parent)
      items.set(iid, m)
      node.children.forEach((c, i) => put(c, iid, i + 1))
    }
    put(tree, null, top + 1)
  })
  const name = tabsList().find((t) => t.id === id)?.name || 'To-do'
  ui.toast(`Sent to ${name}`, { action: 'Open', onAction: () => setActiveTab(id) })
}

// The shared content of a document or mind map tab, created on first use.
// The mind map's centre node is `title` (it starts as the tab's name).
function getPage(tabId, name) {
  let p = yPages.get(tabId)
  if (!(p instanceof Y.Map)) {
    p = new Y.Map()
    const title = new Y.Text()
    if (name) title.insert(0, name)
    p.set('title', title)
    p.set('body', new Y.Text())
    yPages.set(tabId, p)
  }
  return p
}

function renameTab(id, name) {
  const t = tabsList().find((x) => x.id === id)
  if (!t) return
  const next = (name || '').trim().slice(0, 28)
  if (!next || next === t.name) return
  updateTab(id, { name: next })
  // [[Old tab name]] links follow the tab (a note with that name would have won, so leave those)
  if (normTitle(t.name) !== normTitle(next) && !nameTaken(doc, t.name) && !tabsList().some((x) => x.id !== id && normTitle(x.name) === normTitle(t.name))) rewriteLinks(doc, t.name, next)
}

function setTabArchived(id, archived) {
  updateTab(id, { archived: !!archived })
  if (archived && activeTabId === id) {
    const next = tabsList().find((t) => !t.archived && t.id !== id)
    if (next) setActiveTab(next.id, { push: false })
  }
  ui.toast(archived ? 'Tab archived. Find it on the home page.' : 'Tab restored.')
}

async function deleteTab(id) {
  const list = tabsList()
  const t = list.find((x) => x.id === id)
  if (!t) return
  if (list.filter((x) => !x.archived).length <= 1 && !t.archived) {
    ui.toast('Keep at least one tab. Archive it instead if you want it out of the way.')
    return
  }
  const kindWord = { draw: 'sketch and all its strokes', doc: 'document', mindmap: 'mind map' }[t.kind] || 'tab and all its notes'
  const choice = await ui.dialog({
    title: `Delete "${t.name}"?`,
    message: `This removes the ${kindWord} for everyone. Archiving keeps it around but out of the way.`,
    buttons: [
      { label: 'Cancel', value: null },
      { label: t.archived ? 'Unarchive' : 'Archive instead', value: 'archive' },
      { label: 'Delete', value: 'delete', primary: true, danger: true },
    ],
  })
  if (choice === 'archive') {
    setTabArchived(id, !t.archived)
    return
  }
  if (choice !== 'delete') return
  const i = tabIndex(id)
  doc.transact(() => {
    // remove notes that belong to this tab, and the tab's page / ink
    const ids = yOrder.toArray()
    const gone = []
    for (let k = ids.length - 1; k >= 0; k--) {
      const n = yNotes.get(ids[k])
      if (n && n.get('tabId') === id) {
        yOrder.delete(k, 1)
        yNotes.delete(ids[k])
        gone.push(ids[k])
      }
    }
    if (yDrawings.has(id)) yDrawings.delete(id)
    if (yDrawings.has('ink:' + id)) yDrawings.delete('ink:' + id)
    if (yPages.has(id)) yPages.delete(id)
    if (i >= 0) yTabs.delete(i, 1)
  })
  const remaining = tabsList().filter((x) => !x.archived)
  if (remaining.length) setActiveTab(remaining[Math.max(0, Math.min(i, remaining.length - 1))].id, { push: false })
}

function moveTab(fromId, toId) {
  if (fromId === toId) return
  const from = tabIndex(fromId)
  if (from < 0) return
  const raw = yTabs.get(from)
  const rec = tabRec(raw)
  doc.transact(() => {
    yTabs.delete(from, 1)
    let to = tabIndex(toId) // target index after the removal
    if (to < 0) to = yTabs.length
    yTabs.insert(clamp(to, 0, yTabs.length), [makeTabMap(rec)])
  })
}

// ---- tab bar rendering ----
let dragTabId = null
let renamingTabId = null
// a change inside a To-do tab's items can change its badge
const renderTabsSoon = rafThrottle(() => {
  if (!renamingTabId) renderTabs()
})
yPages.observeDeep((events) => {
  if (events.some((e) => e.path[1] === 'items')) renderTabsSoon()
})
setInterval(() => {
  if (tabsList().some((t) => t.kind === 'tasks')) renderTabsSoon() // the badge moves on at midnight
}, 5 * 60000)

function renderTabs() {
  const all = tabsList()
  const active = activeTab()
  const list = all.filter((t) => !t.archived || (active && t.id === active.id))
  tabsEl.innerHTML = ''

  const home = document.createElement('button')
  home.className = 'tab-home'
  home.title = 'All tabs (home)'

  home.setAttribute('aria-label', home.title)
  iconLabel(home, '', 'home')
  home.addEventListener('click', (e) => {
    e.stopPropagation()
    toggleHome()
  })
  tabsEl.appendChild(home)

  for (const t of list) {
    const isActive = active && t.id === active.id
    const tab = document.createElement('div')
    tab.className = 'tab' + (isActive ? ' on' : '') + (t.archived ? ' archived' : '')
    tab.draggable = renamingTabId !== t.id
    tab.dataset.id = t.id
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', String(isActive))
    tab.tabIndex = isActive ? 0 : -1
    tab.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveTab(t.id) }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const i = list.indexOf(t); setActiveTab(list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length].id, { push: false }); tabsEl.querySelector('.tab.on')?.focus() }
      if (e.key === 'F2') { e.preventDefault(); renamingTabId = t.id; renderTabs() }
    })

    const icon = tabGlyph(t, 'tab-icon')
    if (t.color) tab.style.setProperty('--tab-c', `var(--${t.color})`)
    tab.classList.toggle('tinted', !!t.color)
    tab.appendChild(icon)

    if (renamingTabId === t.id) {
      // inline rename: type in place, Enter/blur saves, Escape cancels
      const inp = document.createElement('input')
      inp.className = 'tab-rename'
      inp.value = t.name
      inp.maxLength = 28
      inp.spellcheck = false
      let done = false
      const finish = (save) => {
        if (done) return
        done = true
        renamingTabId = null
        if (save) renameTab(t.id, inp.value)
        renderTabs()
      }
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true)
        else if (e.key === 'Escape') finish(false)
        e.stopPropagation()
      })
      inp.addEventListener('blur', () => finish(true))
      inp.addEventListener('click', (e) => e.stopPropagation())
      tab.appendChild(inp)
      tabsEl.appendChild(tab)
      requestAnimationFrame(() => {
        inp.focus()
        inp.select()
      })
      continue
    }

    const label = document.createElement('span')
    label.className = 'tab-name'
    label.textContent = t.name
    tab.appendChild(label)
    if (t.kind === 'tasks') {
      // a To-do tab shows how many unticked tasks are due today or overdue
      const due = dueCount(yPages.get(t.id)?.get('items'), ymd(new Date()))
      if (due) {
        const badge = document.createElement('span')
        badge.className = 'tab-badge'
        badge.textContent = String(due)
        badge.title = due + (due === 1 ? ' task' : ' tasks') + ' due today or overdue'
        tab.appendChild(badge)
      }
    }

    if (isActive) {
      const more = document.createElement('button')
      more.className = 'tab-x'
      iconLabel(more, '⋯')
      more.title = 'Tab options'

      more.setAttribute('aria-label', more.title)
      more.addEventListener('click', (e) => {
        e.stopPropagation()
        openTabMenu(more, t)
      })
      tab.appendChild(more)
    }

    tab.addEventListener('click', () => setActiveTab(t.id))
    tab.addEventListener('dblclick', (e) => {
      e.preventDefault()
      renamingTabId = t.id
      renderTabs()
    })
    tab.addEventListener('dragstart', (e) => {
      dragTabId = t.id
      e.dataTransfer.effectAllowed = 'move'
    })
    tab.addEventListener('dragover', (e) => {
      e.preventDefault()
      tab.classList.add('drop')
    })
    tab.addEventListener('dragleave', () => tab.classList.remove('drop'))
    tab.addEventListener('drop', (e) => {
      e.preventDefault()
      tab.classList.remove('drop')
      if (dragTabId) moveTab(dragTabId, t.id)
      dragTabId = null
    })
    tabsEl.appendChild(tab)
  }

  const add = document.createElement('button')
  add.className = 'tab-add'
  iconLabel(add, '+')
  add.title = 'Add a tab'

  add.setAttribute('aria-label', add.title)
  add.addEventListener('click', (e) => {
    e.stopPropagation()
    openAddMenu(add)
  })
  tabsEl.appendChild(add)

  // right side: collapse-all + hidden notes (trash / archived) for this tab
  const right = document.createElement('div')
  right.className = 'tab-right'
  if (isNotesTab(active)) {
    const hidden = hiddenCounts(active.id)
    const fold = document.createElement('button')
    fold.className = 'tab-tool'
    const allCollapsed = cards.size > 0 && Array.from(cards.keys()).every((id) => collapsed.has(id))
    iconLabel(fold, allCollapsed ? 'Expand all' : 'Collapse all', allCollapsed ? 'down' : 'up')
    fold.title = 'Collapse or expand every note on this tab (just for you)'

    fold.setAttribute('aria-label', fold.title)
    fold.addEventListener('click', (e) => {
      e.stopPropagation()
      setAllCollapsed(!allCollapsed)
    })
    right.appendChild(fold)
    if (hidden.trash + hidden.archived > 0) {
      const hb = document.createElement('button')
      hb.className = 'tab-tool'
      const parts = []
      if (hidden.archived) parts.push(hidden.archived + ' archived')
      if (hidden.trash) parts.push(hidden.trash + ' in trash')
      hb.textContent = parts.join(' · ')
      hb.title = 'Show archived and deleted notes'

      hb.setAttribute('aria-label', hb.title)
      hb.addEventListener('click', (e) => {
        e.stopPropagation()
        openHiddenPanel(active.id)
      })
      right.appendChild(hb)
    }
  }
  tabsEl.appendChild(right)
}

function openTabMenu(anchor, t) {
  closeMenus()
  const menu = document.createElement('div')
  menu.className = 'menu'
  const r = anchor.getBoundingClientRect()
  menu.style.left = Math.min(r.left, window.innerWidth - 190) + 'px'
  menu.style.top = r.bottom + 4 + 'px'
  const item = (label, fn, cls) => {
    const b = document.createElement('button')
    b.className = 'menu-item' + (cls ? ' ' + cls : '')
    iconLabel(b, label)
    b.addEventListener('click', () => {
      closeMenus()
      fn()
    })
    menu.appendChild(b)
  }
  item('Rename', () => {
    renamingTabId = t.id
    renderTabs()
  })
  item('🎨  Icon & colour…', () => setTimeout(() => openTabLook(t, anchor))) // after this click has bubbled
  if (isNotesTab(t)) {
    if (t.view === 'canvas')
      item('▦  Back to the board view', () => {
        updateTab(t.id, { view: null })
        setTimeout(() => {
          const bw = board.clientWidth
          const off = Array.from(cards.values()).some((c) => {
            const n = c.note
            return (n.get('x') || 0) < 0 || (n.get('y') || 0) < 0 || (n.get('x') || 0) + (n.get('w') || W_DEFAULT) > bw
          })
          if (off)
            ui.toast('Some notes sit outside this view.', { action: 'Bring them in', ms: 9000, onAction: bringAllIntoView })
        }, 60)
      })
    else
      item('∞  Canvas view (pan & zoom)', () => {
        updateTab(t.id, { view: 'canvas' })
        ui.toast('Canvas: drag the background to pan, Ctrl/⌘+wheel or pinch to zoom. Shift+drag selects.', { ms: 7000 })
      })
    if (t.view !== 'canvas') item('⇲  Bring every note into view', () => bringAllIntoView())
    item('+  New note from template…', () => {
      if (activeTabId !== t.id) setActiveTab(t.id)
      chooseTemplate((tpl) => newFromTemplate(tpl, { tabId: t.id }))
    })
  }
  if (t.kind === 'doc') {
    const page = getPage(t.id, t.name)
    item(page.get('share') ? '🔗  Shared link…' : '🔗  Share by link…', () => openShareDialog({ page }))
    item('⎙  Print / save as PDF', () => {
      if (activeTabId !== t.id) setActiveTab(t.id)
      setTimeout(printDoc, 60)
    })
  }
  item(t.archived ? 'Unarchive' : 'Archive', () => setTabArchived(t.id, !t.archived))
  const excluded = backup.isExcluded(t.id)
  item(excluded ? '☐  Back up on this device' : '☑  Backed up on this device', () => {
    backup.setExcluded(t.id, !excluded)
    ui.toast(
      excluded
        ? `"${t.name}" is in this device's backups again.`
        : `"${t.name}" is left out of this device's backups. The Pi still keeps it.`
    )
  })
  item('Delete…', () => deleteTab(t.id), 'danger')
  document.body.appendChild(menu)
  const dismiss = ui.popover(menu, anchor, { menu: !menu.classList.contains('settings-menu'), label: 'Settings' })
  openMenus.push({ remove: dismiss })
}

function openAddMenu(anchor) {
  closeMenus()
  const menu = document.createElement('div')
  menu.className = 'menu'
  const r = anchor.getBoundingClientRect()
  menu.style.left = r.left + 'px'
  menu.style.top = r.bottom + 4 + 'px'
  const mkItem = (kind) => {
    const b = document.createElement('button')
    b.className = 'menu-item menu-item-2line'
    iconLabel(b, '', kindInfo(kind).icon)
    const text = document.createElement('span')
    text.className = 'menu-text'
    const name = document.createElement('span')
    name.className = 'menu-name'
    name.textContent = kindInfo(kind).menu
    const blurb = document.createElement('span')
    blurb.className = 'menu-blurb'
    blurb.textContent = kindInfo(kind).blurb
    text.append(name, blurb)
    b.appendChild(text)
    b.removeAttribute('aria-label')
    b.addEventListener('click', () => {
      closeMenus()
      addTab(kind)
    })
    return b
  }
  menu.append(mkItem('notes'), mkItem('doc'), mkItem('tasks'), mkItem('mindmap'), mkItem('draw'))
  document.body.appendChild(menu)
  const dismiss = ui.popover(menu, anchor, { menu: !menu.classList.contains('settings-menu'), label: 'Settings' })
  openMenus.push({ remove: dismiss })
}

const openMenus = []
function closeMenus() {
  while (openMenus.length) openMenus.pop().remove()
  ui.closeMenus()
}
document.addEventListener('click', () => {
  closeMenus()
  closeAllPopovers() // an outside click dismisses an open options popover
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMenus()
    closeAllPopovers()
  }
})

// ---- note operations ----
function stamp(note) {
  // "edited by" bookkeeping; throttled so typing doesn't spam the doc
  const now = Date.now()
  if (now - (note.get('lastEditedAt') || 0) < 4000 && (note.get('lastEditedBy') || {}).id === me.id) return
  note.doc.transact(() => {
    note.set('lastEditedAt', now)
    note.set('lastEditedBy', { id: me.id, name: me.name })
  })
}

function createNote(color, opts = {}) {
  const id = genId()
  const active = activeTab()
  const pos = opts.at || nextNotePos()
  const z = maxZ() + 1
  doc.transact(() => {
    const n = new Y.Map()
    const title = new Y.Text()
    if (opts.title) title.insert(0, opts.title)
    n.set('title', title)
    const body = new Y.Text()
    if (opts.lines && opts.lines.length) insertLinesAt(body, 0, opts.lines)
    n.set('body', body)
    n.set('color', color || PAPER[0])
    n.set('created', Date.now())
    n.set('tabId', active ? active.id : null)
    n.set('fontSize', FS_DEFAULT)
    n.set('size', 'm')
    n.set('kind', 'note')
    n.set('x', pos.x)
    n.set('y', pos.y)
    n.set('w', SIZE_W.m)
    n.set('h', H_DEFAULT)
    n.set('z', z)
    n.set('lastEditedAt', Date.now())
    n.set('lastEditedBy', { id: me.id, name: me.name })
    yNotes.set(id, n)
    yOrder.unshift([id])
  })
  return id
}

// ---- pictures straight on a NotePad ----
// A picture pasted or dropped onto a NotePad (not into a note) becomes an image
// card: a note with kind 'image' whose body is just the picture's line. It moves,
// selects, syncs and goes to the trash like any note; old clients show it as an
// ordinary note holding the picture.
const IMG_W_MAX = 360
async function imageWidth(file) {
  try {
    const bmp = await createImageBitmap(file)
    const w = bmp.width
    bmp.close && bmp.close()
    return clamp(w, W_MIN, IMG_W_MAX)
  } catch {
    return IMG_W_MAX
  }
}
async function addImageCards(files, at) {
  const t = activeTab()
  if (!files.length || !isNotesTab(t)) return
  const widths = await Promise.all(files.map(imageWidth))
  const urls = await uploadImages(files)
  if (!urls.length) return
  const base = at || nextNotePos()
  let z = maxZ()
  const ids = []
  doc.transact(() => {
    urls.forEach((url, i) => {
      const id = genId()
      const w = widths[i] || IMG_W_MAX
      const n = new Y.Map()
      const body = new Y.Text()
      body.insert(0, url + '\n')
      n.set('title', new Y.Text())
      n.set('body', body)
      n.set('color', '#ffffff')
      n.set('created', Date.now())
      n.set('tabId', t.id)
      n.set('fontSize', FS_DEFAULT)
      n.set('kind', 'image')
      n.set('x', Math.round(base.x - (at ? w / 2 : 0) + i * 24))
      n.set('y', Math.round(base.y - (at ? 40 : 0) + i * 24))
      n.set('w', w)
      n.set('h', H_DEFAULT)
      n.set('z', ++z)
      n.set('lastEditedAt', Date.now())
      n.set('lastEditedBy', { id: me.id, name: me.name })
      yNotes.set(id, n)
      yOrder.unshift([id])
      ids.push(id)
    })
  })
  return ids
}
// where the pointer last was over the board (for pastes in canvas view)
let boardPointer = null
board.addEventListener('pointermove', (e) => {
  boardPointer = { x: e.clientX, y: e.clientY, at: Date.now() }
})
board.addEventListener('pointerleave', () => (boardPointer = null))
const imageFilesOf = (dt) => {
  const out = []
  for (const f of Array.from(dt?.files || [])) if (/^image\//.test(f.type)) out.push(f)
  if (!out.length && dt?.items) {
    for (const it of Array.from(dt.items)) {
      if (it.kind === 'file' && /^image\//.test(it.type)) {
        const f = it.getAsFile()
        if (f) out.push(f)
      }
    }
  }
  return out
}
document.addEventListener('paste', (e) => {
  if (full || overlayKind || isTypingTarget(document.activeElement)) return
  if (!isNotesTab(activeTab())) return
  const files = imageFilesOf(e.clipboardData)
  if (!files.length) return
  e.preventDefault()
  const at = canvasMode && boardPointer ? toPlane(boardPointer.x, boardPointer.y) : null
  addImageCards(files, at)
})
board.addEventListener('dragover', (e) => {
  if (!isNotesTab(activeTab()) || e.target.closest('.card')) return
  if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault()
})
board.addEventListener('drop', (e) => {
  if (!isNotesTab(activeTab()) || e.target.closest('.card')) return
  const files = imageFilesOf(e.dataTransfer)
  if (!files.length) return
  e.preventDefault()
  addImageCards(files, freeLayout ? toPlane(e.clientX, e.clientY) : null)
})

// Delete is soft: the note goes to the tab's trash and a toast offers Undo.
// The server purges trash after 30 days; "Delete forever" is hardDeleteNote.
function deleteNote(id) {
  const n = yNotes.get(id)
  if (!n) return
  const title = n.get('title').toString().trim() || 'Note'
  doc.transact(() => n.set('deleted', Date.now()))
  ui.toast(`"${title.slice(0, 30)}" moved to trash`, {
    action: 'Undo',
    ms: 7000,
    onAction: () => restoreNote(id),
  })
}

function restoreNote(id) {
  const n = yNotes.get(id)
  if (!n) return
  doc.transact(() => {
    n.delete('deleted')
    n.delete('archived')
  })
}

function hardDeleteNote(id) {
  doc.transact(() => {
    const arr = yOrder.toArray()
    const i = arr.indexOf(id)
    if (i >= 0) yOrder.delete(i, 1)
    yNotes.delete(id)
  })
}

function setNoteArchived(id, archived) {
  const n = yNotes.get(id)
  if (!n) return
  doc.transact(() => {
    if (archived) n.set('archived', true)
    else n.delete('archived')
  })
  if (archived) ui.toast('Note archived', { action: 'Undo', onAction: () => setNoteArchived(id, false) })
}

function moveNoteToTab(id, tabId) {
  const n = yNotes.get(id)
  if (!n || n.get('tabId') === tabId) return
  doc.transact(() => n.set('tabId', tabId))
  const t = tabsList().find((x) => x.id === tabId)
  ui.toast('Moved to ' + (t ? t.name : 'tab'), { action: 'Open', onAction: () => goToNote(id) })
}

function isHidden(n) {
  return !!(n.get('deleted') || n.get('archived'))
}

function hiddenCounts(tabId) {
  let trash = 0
  let archived = 0
  yNotes.forEach((n) => {
    if (n.get('tabId') !== tabId) return
    if (n.get('deleted')) trash++
    else if (n.get('archived')) archived++
  })
  return { trash, archived }
}

// Single page or a two-page "book" (body + body2 side by side).
function setNoteLayout(note, layout) {
  const cur = note.get('layout') || 'single'
  if (cur === layout) return
  note.doc.transact(() => {
    if (layout === 'book') {
      if (!note.get('body2')) note.set('body2', new Y.Text())
      note.set('layout', 'book')
      if ((note.get('w') || 0) < 440) note.set('w', 480)
    } else {
      // fold the right page back into the body so nothing is lost
      const b2 = note.get('body2')
      const extra = b2 ? b2.toString() : ''
      if (extra.trim()) {
        const body = note.get('body')
        body.insert(body.length, (body.length ? '\n\n' : '') + extra)
        if (b2.length) b2.delete(0, b2.length)
      }
      note.set('layout', 'single')
    }
  })
}

function belongsToActive(note, active) {
  if (isHidden(note)) return false
  if (!active) return true
  const tid = note.get('tabId')
  if (!tid) return active.id === (tabsList()[0] && tabsList()[0].id)
  return tid === active.id
}

// ---- per-device collapsed notes (title only) ----
const collapsed = new Set()
try {
  JSON.parse(localStorage.getItem('notesCollapsed') || '[]').forEach((id) => collapsed.add(id))
} catch {
  /* ignore */
}
function saveCollapsed() {
  try {
    localStorage.setItem('notesCollapsed', JSON.stringify(Array.from(collapsed)))
  } catch {
    /* ignore */
  }
}
function setCollapsed(id, on) {
  if (on) collapsed.add(id)
  else collapsed.delete(id)
  saveCollapsed()
  const c = cards.get(id)
  if (c) {
    c.el.classList.toggle('collapsed', on)
    applyNoteLayout(c.el, c.note)
    updateBoardExtent()
  }
  renderTabs()
}
function setAllCollapsed(on) {
  for (const id of cards.keys()) {
    if (on) collapsed.add(id)
    else collapsed.delete(id)
  }
  saveCollapsed()
  relayoutAll()
  renderTabs()
}

// ---- browser history ------------------------------------------------------
// Tab switches, link jumps and full screen each push an entry, so browser Back
// (and the phone's back gesture) retraces your steps. Every entry we write is
// { nav: 1, tab, note?, full? }; popstate puts the app back the way it was.
const here = () => location.pathname + location.search
function navState(extra = {}) {
  return { nav: 1, tab: activeTab()?.id || activeTabId || null, ...extra }
}
function navPush(extra, url) {
  if (navQuiet) return false
  try {
    history.pushState(navState(extra), '', url == null ? here() : url)
    return true
  } catch {
    return false
  }
}
function navReplace(extra, url) {
  try {
    history.replaceState(navState(extra), '', url == null ? here() : url)
  } catch {
    /* ignore */
  }
}
window.addEventListener('popstate', () => {
  const st = history.state || {}
  // a typed or clicked #fragment arrives as a popstate without our state: hashchange follows it
  if (!st.nav) return
  poppedAt = Date.now()
  navQuiet++
  try {
    if (st.tab && st.tab !== activeTabId && tabsList().some((t) => t.id === st.tab)) setActiveTab(st.tab)
    if (st.full) {
      if (!full || full.id !== st.full) {
        if (!openFullscreen(st.full, { fromHash: true, focus: false, anyTab: true }) && full) closeFullscreenNow()
      }
    } else if (full) closeFullscreenNow()
    if (st.note && !st.full) goToNote(st.note, { keepHash: true, unarchive: false })
  } finally {
    navQuiet--
  }
})

// ---- navigation to a note (links, home page, toasts) ----
// opts.push: a new history entry (links, search results); otherwise the
// address bar just shows #note=<id>.
function goToNote(id, opts = {}) {
  const n = yNotes.get(id)
  if (!n) return false
  const tid = n.get('tabId')
  if (tid && activeTabId !== tid) setActiveTab(tid, { push: false })
  closeHome()
  if (n.get('deleted')) restoreNote(id)
  if (n.get('archived') && opts.unarchive !== false) setNoteArchived(id, false)
  if (collapsed.has(id)) setCollapsed(id, false)
  if (opts.push) navPush({ note: id }, '#note=' + id)
  else if (!opts.keepHash) navReplace({ note: id }, '#note=' + id)
  // the card may not exist until reconcile has run
  const tryFlash = (left) => {
    const c = cards.get(id)
    if (c) {
      if (canvasMode) viewport.centerOn(c.el.offsetLeft + c.el.offsetWidth / 2, c.el.offsetTop + c.el.offsetHeight / 2)
      else c.el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      c.el.classList.add('flash')
      setTimeout(() => c.el.classList.remove('flash'), 1400)
      if (opts.line) revealInCard(c, opts.line)
      return
    }
    if (left > 0) setTimeout(() => tryFlash(left - 1), 60)
  }
  tryFlash(20)
  return true
}

// The note (or tab) a [[link]] names: by title or alias, any case. Live notes
// first, the current tab's first; then tabs by name.
function findNamed(name, { includeHidden = false } = {}) {
  const want = normTitle(name)
  if (!want) return null
  let best = null
  yNotes.forEach((n, id) => {
    if (n.get('deleted') && !includeHidden) return
    if (!namesOf(n).some((x) => normTitle(x) === want)) return
    const score = (n.get('deleted') ? 0 : 2) + (n.get('archived') ? 0 : 1) + (n.get('tabId') === activeTabId ? 4 : 0) + (normTitle(n.get('title').toString()) === want ? 8 : 0)
    if (!best || score > best.score) best = { noteId: id, tabId: n.get('tabId'), score }
  })
  if (best) return best
  const t = tabsList().find((x) => normTitle(x.name) === want)
  return t ? { tabId: t.id } : null
}

// [[Title]], [[Title#Heading]], [[Title^lineId]] → { noteId?, tabId, line? }
function resolveLink(inner) {
  // a title may itself hold # or ^ ("C# notes"): the whole text wins when a note has it
  const whole = findNamed(inner)
  if (whole) return { ...whole, line: null, title: inner.trim() }
  const tg = parseTarget(inner)
  const target = findNamed(tg.title)
  if (!target) return null
  const line = tg.block ? { bid: tg.block } : tg.heading ? { heading: tg.heading } : null
  return { ...target, line, title: tg.title }
}

function followLink(href) {
  if (!href) return
  if (href[0] === '[') {
    const inner = href.slice(2, -2)
    const target = resolveLink(inner)
    if (!target) {
      const title = parseTarget(inner).title
      ui.toast('No note called “' + title + '” yet', { action: 'Create it', ms: 8000, onAction: () => createNoteNamed(title, { open: true }) })
      return
    }
    if (target.noteId) {
      if (full) {
        goToNote(target.noteId, { keepHash: true })
        openFullscreen(target.noteId, { line: target.line }) // following a link from a full-screen note opens the next one full screen
      } else goToNote(target.noteId, { push: true, line: target.line })
    } else {
      dropFullscreen()
      setActiveTab(target.tabId)
      if (target.line) setTimeout(() => pageState?.rich?.revealAt(target.line), 80)
    }
    return
  }
  // only web and mail addresses open: never javascript: or data: from a shared note
  if (/^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener')
}

// A new note called `title` in the current NotePad tab (or the first one), with
// optional lines; opened full screen when asked.
function createNoteNamed(title, { tabId, lines, open = false, color } = {}) {
  let t = tabId ? tabsList().find((x) => x.id === tabId) : activeTab()
  if (!isNotesTab(t) || t.archived) t = tabsList().find((x) => isNotesTab(x) && !x.archived)
  if (!t) return null
  if (activeTabId !== t.id) setActiveTab(t.id, { push: false })
  const id = createNote(color || PAPER[Math.floor(Math.random() * 4)], { title, lines })
  if (open) setTimeout(() => openFullscreen(id), 30)
  return id
}

// what the [[ picker offers for what has been typed after "[["
function linkCandidates(q = '') {
  const tg = parseTarget(q)
  // "Note#…" / "Note^…" lists that note's headings / lines, once the part before names one
  const target = (q.includes('#') || q.includes('^')) && findNamed(tg.title)
  const hasHead = !!target && q.includes('#')
  const hasBlock = !!target && !hasHead && q.includes('^')
  if (hasHead || hasBlock) {
    const tn = target.noteId ? yNotes.get(target.noteId) : null
    const bodies = tn
      ? [tn.get('body'), tn.get('layout') === 'book' ? tn.get('body2') : null].filter(Boolean)
      : [yPages.get(target.tabId)?.get('body')].filter(Boolean)
    const title = tg.title
    const want = (hasBlock ? q.slice(q.indexOf('^') + 1) : q.slice(q.indexOf('#') + 1)).trim().toLowerCase()
    const out = []
    for (const yt of bodies) {
      linesOf(yt).forEach((L, index) => {
        if (!L.text.trim() || embedOf(L.text)) return
        if (hasHead) {
          if (L.attrs.lt !== 'h' || !L.text.toLowerCase().includes(want)) return
          out.push({ label: title + '#' + L.text.trim(), display: L.text.trim(), hint: 'heading', icon: 'heading' })
        } else {
          if (want && !L.text.toLowerCase().includes(want) && L.attrs.bid !== want) return
          out.push({
            label: title + '^' + (L.attrs.bid || '…'),
            display: L.text.trim().slice(0, 60),
            hint: 'line',
            icon: 'text',
            onPick: () => {
              const bid = ensureBid(yt, index)
              return bid ? title + '^' + bid : null
            },
          })
        }
      })
    }
    return out.slice(0, 12)
  }
  const items = []
  const tabsById = new Map(tabsList().map((t) => [t.id, t]))
  yNotes.forEach((n) => {
    if (isHidden(n)) return
    const t = tabsById.get(n.get('tabId'))
    for (const [i, name] of namesOf(n).entries()) items.push({ label: name, hint: i ? 'alias of ' + n.get('title').toString().trim() : t ? t.name : '', icon: 'note' })
  })
  for (const t of tabsById.values()) if (t.name.trim()) items.push({ label: t.name.trim(), hint: 'tab', icon: kindInfo(t.kind).icon, weight: 1 })
  return rankItems(items, q)
}

// give line `index` of a body an id (for [[Note^id]]) and return it
function ensureBid(ytext, index) {
  const L = linesOf(ytext)[index]
  if (!L) return null
  if (L.attrs.bid) return L.attrs.bid
  const bid = genLineId()
  doc.transact(() => {
    ensureTerminator(ytext)
    const D = linesOf(ytext)[index]
    ytext.format(D.start + D.len, 1, { bid })
  })
  return bid
}

// ---- renames keep links working ---------------------------------------------
// A title edit is committed when the field loses focus: if the note had a name
// before, every [[old name]] on the board (trash and archive too) is rewritten.
function watchTitle(input, getNote, id) {
  let before = null
  let typed = false // only the person who typed the new name rewrites the links
  input.addEventListener('focus', () => {
    before = getNote().get('title').toString()
    typed = false
  })
  input.addEventListener('input', () => (typed = true))
  const commit = () => {
    const note = getNote()
    if (before == null || !note || !typed) return
    typed = false
    const now = note.get('title').toString()
    const was = before
    before = input === document.activeElement ? now : null
    if (normTitle(was) === normTitle(now) || !was.trim() || !now.trim()) return
    const n = followRename(doc, id, was, now)
    if (n) ui.toast(`Updated ${n} link${n === 1 ? '' : 's'} to “${now.trim()}”`)
  }
  input.addEventListener('blur', commit)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit()
  })
}

// ---- "Linked from" and unlinked mentions --------------------------------------
// The links pointing at a note (by title or alias), each with its line, and the
// places that name it in plain text, each with a one-click "Link".
function bodyOf(src) {
  if (src.kind === 'page') return yPages.get(src.id)?.get('body') || null
  return yNotes.get(src.id)?.get(src.field || 'body') || null
}
// show a line in a card's editors: by index on the page it is on (body / body2), else by id or heading
function revealInCard(card, line, o) {
  const eds = card.body?.editors || []
  if (line.index != null) {
    const r = eds[line.field === 'body2' ? 1 : 0]
    return r ? r.revealAt(line, o) : false
  }
  return eds.some((r) => r.revealAt(line, o))
}
function openSource(src) {
  const line = { index: src.index, field: src.field }
  if (src.kind === 'page') {
    dropFullscreen()
    setActiveTab(src.id)
    setTimeout(() => pageState?.rich?.revealAt(line), 80)
    return
  }
  if (full || phoneMode()) {
    goToNote(src.id, { keepHash: true })
    openFullscreen(src.id, { line })
  } else goToNote(src.id, { push: true, line })
}
function linksSection(names, selfId, { compact = false } = {}) {
  const wrap = document.createElement('div')
  wrap.className = 'links-sec' + (compact ? ' compact' : '')
  const back = backlinks(doc, names, { excludeId: selfId })
  const mentions = unlinkedMentions(doc, names, { excludeId: selfId })
  const head = (label, n) => {
    const h = document.createElement('div')
    h.className = 'links-h'
    h.textContent = label + (n ? ' · ' + n : '')
    wrap.appendChild(h)
  }
  const row = (src, text, extra) => {
    const r = document.createElement('div')
    r.className = 'links-row'
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'links-go'
    const t = document.createElement('span')
    t.className = 'links-title'
    t.textContent = src.title || (src.kind === 'page' ? 'Document' : 'Untitled')
    const l = document.createElement('span')
    l.className = 'links-line'
    l.textContent = text.length > 140 ? text.slice(0, 139) + '…' : text
    b.append(t, l)
    b.addEventListener('click', () => {
      closeAllPopovers()
      openSource(src)
    })
    r.appendChild(b)
    if (extra) r.appendChild(extra)
    wrap.appendChild(r)
  }
  head('Linked from', back.length)
  if (!back.length) {
    const e = document.createElement('div')
    e.className = 'links-empty'
    e.textContent = names[0] ? 'No other note links here yet. Type [[' + names[0] + ']] in one.' : 'Give this note a title to link to it.'
    wrap.appendChild(e)
  }
  for (const b of back) row(b, b.line)
  if (mentions.length) {
    head('Unlinked mentions', mentions.length)
    for (const m of mentions.slice(0, 30)) {
      const link = document.createElement('button')
      link.type = 'button'
      link.className = 'pop-btn links-link'
      link.textContent = 'Link'
      link.title = 'Turn “' + m.name + '” into [[' + names[0] + ']]'
      link.addEventListener('click', (e) => {
        e.stopPropagation()
        const yt = bodyOf(m)
        if (!yt || yt.toString().slice(m.start, m.start + m.len) !== m.name) return ui.toast('That text has changed; try again.')
        linkMention(yt, m.start, m.len, names[0])
        wrap.replaceWith(linksSection(names, selfId, { compact }))
      })
      row(m, m.line, link)
    }
  }
  return wrap
}

// ---- aliases: other names a [[link]] can use ----------------------------------
function setAliases(note, str) {
  const seen = new Set([normTitle(note.get('title').toString())])
  const list = []
  for (const raw of String(str || '').split(',')) {
    const a = raw.replace(/[[\]]/g, '').trim().slice(0, 80)
    if (!a || seen.has(normTitle(a))) continue
    seen.add(normTitle(a))
    list.push(a)
  }
  const cur = aliasesOf(note)
  if (cur.join('\n') === list.slice(0, 10).join('\n')) return
  doc.transact(() => {
    if (list.length) note.set('aliases', list.slice(0, 10))
    else note.delete('aliases')
  })
}

// ---- quick switcher (Ctrl/Cmd+K) ------------------------------------------------
function switcherItems() {
  const items = []
  const tabsById = new Map(tabsList().map((t) => [t.id, t]))
  yOrder.toArray().forEach((id) => {
    const n = yNotes.get(id)
    if (!n || n.get('deleted')) return
    const t = tabsById.get(n.get('tabId'))
    const title = n.get('title').toString().trim()
    const names = aliasesOf(n)
    items.push({
      kind: 'note',
      id,
      label: title || snippetOf(n, 50) || 'Untitled',
      names,
      hint: (t ? t.name : '') + (n.get('archived') ? ' · archived' : '') + (names.length ? ' · aka ' + names.join(', ') : ''),
      icon: n.get('kind') === 'image' ? 'image' : 'note',
      weight: (n.get('archived') ? 2 : 0) + (title ? 0 : 1),
    })
  })
  for (const t of tabsById.values()) items.push({ kind: 'tab', id: t.id, label: t.name || 'Untitled tab', hint: kindInfo(t.kind).label + (t.archived ? ' · archived' : ''), icon: t.kind === 'notes' ? 'folder' : kindInfo(t.kind).icon, weight: 1 })
  items.push({ kind: 'today', label: 'Today’s journal', names: ['today', 'daily', 'journal', ymd(new Date())], hint: 'daily note', icon: 'calendar', weight: 3 })
  return items
}
function openQuickSwitcher() {
  closeMenus()
  closeAllPopovers()
  openSwitcher({
    items: switcherItems,
    onPick: (it, ev) => {
      if (it.kind === 'tab') {
        dropFullscreen()
        closeHome()
        setActiveTab(it.id)
      } else if (it.kind === 'today') openToday()
      else if (full || ev.shiftKey || phoneMode()) {
        goToNote(it.id, { keepHash: true })
        openFullscreen(it.id)
      } else goToNote(it.id, { push: true })
    },
    onCreate: (title) => createNoteNamed(title, { open: true }),
  })
}
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k' || e.defaultPrevented) return
  e.preventDefault()
  openQuickSwitcher()
})

// ---- templates -------------------------------------------------------------------
// Every note in a NotePad tab called "Templates" is a template. Using one copies
// its title, colour and text (formatting and all), filling in {{date}},
// {{time}}, {{title}} and {{me}}. No scripting.
const isTemplatesTab = (t) => isNotesTab(t) && normTitle(t.name) === 'templates'
function templateNotes() {
  const tab = tabsList().find(isTemplatesTab)
  if (!tab) return []
  return yOrder
    .toArray()
    .map((id) => ({ id, n: yNotes.get(id) }))
    .filter(({ n }) => n && n.get('tabId') === tab.id && !isHidden(n) && (n.get('kind') || 'note') === 'note')
}
const pad2 = (v) => String(v).padStart(2, '0')
function templateVars(title) {
  const d = new Date()
  return { date: ymd(d), time: pad2(d.getHours()) + ':' + pad2(d.getMinutes()), title: title || '', me: me.name || '' }
}
const fillVars = (str, vars) => String(str || '').replace(/\{\{\s*(date|time|title|me)\s*\}\}/gi, (m, k) => vars[k.toLowerCase()] ?? m)
// a template's body as lines to insert, placeholders filled
function templateLines(n, vars) {
  const v = { ...templateVars(vars.title), ...vars }
  return linesOf(n.get('body')).map((L) => {
    const attrs = { ...L.attrs }
    delete attrs.bid
    return { text: fillVars(L.text, v), attrs, runs: L.runs.map((r) => ({ text: fillVars(r.text, v), marks: r.marks })) }
  })
}
async function chooseTemplate(cb) {
  const list = templateNotes()
  if (!list.length) {
    const ok = await ui.confirm('Notes in a NotePad tab called “Templates” become templates. {{date}}, {{time}}, {{title}} and {{me}} are filled in when one is used.', {
      title: 'No templates yet',
      okLabel: 'Make a Templates tab',
    })
    if (ok) setActiveTab(ensureTemplatesTab())
    return
  }
  openSwitcher({
    placeholder: 'Pick a template…',
    items: () => list.map(({ id, n }) => ({ kind: 'template', id, n, label: n.get('title').toString().trim() || 'Untitled template', hint: snippetOf(n, 40), icon: 'note' })),
    onPick: (it) => cb(it.n),
  })
}
// the Templates tab, made with a sample daily template the first time
function ensureTemplatesTab() {
  const have = tabsList().find(isTemplatesTab)
  if (have) return have.id
  const id = genId()
  doc.transact(() => yTabs.push([makeTabMap({ id, name: 'Templates', kind: 'notes' })]))
  setActiveTab(id, { push: false })
  createNote(PAPER[1], {
    title: 'Daily',
    lines: markdownToLines('# {{date}}\n- [ ] \n\nNotes'),
  })
  return id
}
function newFromTemplate(n, { title, tabId, open = true } = {}) {
  // from the Templates tab itself, the copy goes to the first other NotePad
  if (!tabId && isTemplatesTab(activeTab())) tabId = tabsList().find((t) => isNotesTab(t) && !t.archived && !isTemplatesTab(t))?.id
  const vars = templateVars(title)
  const name = title || fillVars(n.get('title').toString(), vars)
  vars.title = name
  return createNoteNamed(name, { tabId, lines: templateLines(n, vars), color: n.get('color'), open })
}

// ---- daily notes ------------------------------------------------------------------
// "Today" opens the note titled 2026-10-28 in a NotePad tab called "Journal"
// (made when missing), started from the template called "Daily" if there is one.
const isJournalTab = (t) => isNotesTab(t) && normTitle(t.name) === 'journal'
function journalNotes() {
  const tab = tabsList().find(isJournalTab)
  const out = new Map() // day -> id
  if (!tab) return out
  yNotes.forEach((n, id) => {
    if (n.get('tabId') !== tab.id || n.get('deleted')) return
    const t = n.get('title').toString().trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(t) && !out.has(t)) out.set(t, id)
  })
  return out
}
function openDay(day) {
  let tab = tabsList().find(isJournalTab)
  if (!tab) {
    const id = genId()
    doc.transact(() => yTabs.push([makeTabMap({ id, name: 'Journal', kind: 'notes', icon: 'i:calendar' })]))
    tab = tabsList().find((t) => t.id === id)
  }
  if (tab.archived) updateTab(tab.id, { archived: false })
  const have = journalNotes().get(day)
  if (have) {
    const n = yNotes.get(have)
    if (n.get('archived')) setNoteArchived(have, false)
    goToNote(have, { keepHash: true })
    openFullscreen(have)
    return have
  }
  const tpl = templateNotes().find(({ n }) => normTitle(n.get('title').toString()) === 'daily')
  if (tpl) return newFromTemplate(tpl.n, { title: day, tabId: tab.id })
  return createNoteNamed(day, { tabId: tab.id, open: true })
}
const openToday = () => openDay(ymd(new Date()))

// ---- extract a selection / merge notes -----------------------------------------
async function extractSelection(card) {
  const rich = card.activeRich || card.body?.rich
  const sel = rich && rich.selectionLines ? rich.selectionLines() : null
  if (!sel || !sel.lines.some((l) => l.text.trim())) return ui.toast('Select the text to move first.')
  const first = sel.lines.find((l) => l.text.trim())
  const suggested = first.text.trim().replace(/[[\]]/g, '').slice(0, 80)
  const typed = await ui.prompt('Title for the new note:', suggested, { title: 'Move to a new note', okLabel: 'Move', maxLength: 120 })
  if (typed == null) return
  const name = typed.trim().replace(/[[\]]/g, '') || suggested
  let lines = sel.lines
  if (lines.length > 1 && first.text.trim() === name) lines = lines.filter((l) => l !== first)
  const src = card.note
  // the text must still be there (someone may have edited it while the dialog was open)
  if (!rich.replacePinned(sel.pin, '[[' + name + ']]')) return ui.toast('That text changed meanwhile; select it again.')
  const at = { x: Math.round((Number(src.get('x')) || 0) + (Number(src.get('w')) || W_DEFAULT) + 24), y: Math.round(Number(src.get('y')) || 0) }
  const id = createNote(src.get('color') || PAPER[0], { title: name, lines, at })
  ui.toast('Moved to “' + name + '”', { action: 'Open', onAction: () => (full ? openFullscreen(id) : goToNote(id, { push: true })) })
  return id
}

function mergeNoteInto(srcId) {
  const src = yNotes.get(srcId)
  if (!src) return
  const tabsById = new Map(tabsList().map((t) => [t.id, t]))
  openSwitcher({
    placeholder: 'Merge “' + (src.get('title').toString().trim() || 'Untitled') + '” into…',
    items: () =>
      yOrder
        .toArray()
        .filter((id) => id !== srcId && yNotes.get(id) && !isHidden(yNotes.get(id)) && (yNotes.get(id).get('kind') || 'note') !== 'todo')
        .map((id) => ({ id, label: yNotes.get(id).get('title').toString().trim() || snippetOf(yNotes.get(id), 40) || 'Untitled', hint: tabsById.get(yNotes.get(id).get('tabId'))?.name || '', icon: 'note' })),
    onPick: (it) => mergeNotes(srcId, it.id),
  })
}
function mergeNotes(srcId, dstId) {
  const src = yNotes.get(srcId)
  const dst = yNotes.get(dstId)
  if (!src || !dst) return
  const srcTitle = src.get('title').toString().trim()
  const dstTitle = dst.get('title').toString().trim()
  const copy = (yt) => (yt ? linesOf(yt).map((L) => ({ text: L.text, attrs: { ...L.attrs }, runs: L.runs })) : [])
  const add = []
  if (srcTitle) add.push({ text: srcTitle, attrs: { lt: 'h' } })
  add.push(...copy(src.get('body')), ...(src.get('layout') === 'book' ? copy(src.get('body2')) : []))
  const body = dst.get('body')
  doc.transact(() => {
    appendLines(body, add.filter((l, i, a) => l.text || l.attrs.lt || i < a.length - 1))
    src.set('deleted', Date.now())
    dst.set('lastEditedAt', Date.now())
    dst.set('lastEditedBy', { id: me.id, name: me.name })
  })
  // links to the merged note now lead to the note it went into
  if (srcTitle && dstTitle) followRename(doc, srcId, srcTitle, dstTitle)
  if (full && full.id === srcId) closeFullscreenNow()
  ui.toast('Merged into “' + (dstTitle || 'Untitled') + '”', { action: 'Open', onAction: () => goToNote(dstId, { push: true }) })
}

// ---- print / PDF --------------------------------------------------------------------
// Print one note (opened large) or a document tab; the browser can save it as a PDF.
function printWith(cls) {
  document.body.classList.add(cls)
  const done = () => {
    document.body.classList.remove(cls)
    window.removeEventListener('afterprint', done)
  }
  window.addEventListener('afterprint', done)
  setTimeout(() => {
    window.print()
    setTimeout(done, 500) // browsers without afterprint
  }, 120)
}
function printNote(id) {
  if (!full || full.id !== id) {
    goToNote(id, { keepHash: true })
    openFullscreen(id, { focus: false })
  }
  printWith('print-note')
}
const printDoc = () => printWith('print-doc')

// ---- share one note (or document) by link -------------------------------------------
// A random token on the note serves a read-only copy at /s/<token>, past the
// password for that note only. Stop sharing deletes the token: the link dies.
function newShareToken() {
  const b = new Uint8Array(18)
  crypto.getRandomValues(b)
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function openShareDialog({ note, page }) {
  const map = note || page
  if (!map) return
  let token = map.get('share')
  if (!token) {
    const ok = await ui.confirm('Anyone with the link can read this ' + (note ? 'note' : 'document') + ' (but not edit it, or see anything else on the board). You can stop sharing at any time.', {
      title: 'Share by link',
      okLabel: 'Create link',
    })
    if (!ok) return
    token = newShareToken()
    doc.transact(() => map.set('share', token))
  }
  const url = location.origin + '/s/' + token
  const v = await ui.dialog({
    title: 'Shared by link',
    message: 'Read-only, and always shows the latest version.',
    input: { value: url },
    buttons: [
      { label: 'Stop sharing', value: 'stop', danger: true },
      { label: 'Close', value: null },
      { label: 'Copy link', value: true, primary: true },
    ],
  })
  if (v === 'stop') {
    doc.transact(() => map.delete('share'))
    ui.toast('Link turned off')
  } else if (typeof v === 'string') {
    try {
      await navigator.clipboard.writeText(url)
      ui.toast('Link copied')
    } catch {
      ui.toast('Copy the link from the box')
    }
  }
}

// ---- hover preview of a [[link]] (desktop) ---------------------------------------
initHoverPreview({
  describe(href) {
    if (!href || href[0] !== '[') return null
    const target = resolveLink(href.slice(2, -2))
    if (!target) return { title: parseTarget(href.slice(2, -2)).title, hint: 'No such note yet: click to create it', lines: [], empty: ' ' }
    const lineInfo = (L) => ({ text: (L.attrs.lt === 'todo' ? (L.attrs.done ? '☑ ' : '☐ ') : L.attrs.lt === 'li' ? '• ' : '') + (embedOf(L.text) ? (embedOf(L.text).kind === 'image' ? '🖼 picture' : '▶ video') : L.text), cls: L.attrs.lt === 'h' ? 'lp-h' : '' })
    const pick = (yt) => {
      let ls = linesOf(yt).filter((L) => L.text.trim() || L.attrs.lt === 'todo')
      if (target.line) {
        const all = linesOf(yt)
        const i = all.findIndex((L) => (target.line.bid ? L.attrs.bid === target.line.bid : L.attrs.lt === 'h' && normTitle(L.text) === normTitle(target.line.heading)))
        if (i >= 0) ls = all.slice(i).filter((L) => L.text.trim())
      }
      return ls.slice(0, 12).map(lineInfo)
    }
    if (target.noteId) {
      const n = yNotes.get(target.noteId)
      const t = tabsList().find((x) => x.id === n.get('tabId'))
      return { title: n.get('title').toString().trim() || 'Untitled', hint: (t ? t.name : '') + (target.line ? ' · ' + (target.line.heading || 'a line') : ''), lines: pick(n.get('body')), color: renderedPaper(n.get('color') || PAPER[0]), ink: inkFor(renderedPaper(n.get('color') || PAPER[0])) }
    }
    const t = tabsList().find((x) => x.id === target.tabId)
    const page = yPages.get(target.tabId)
    return { title: t ? t.name : 'Tab', hint: kindInfo(t?.kind).label + ' tab', lines: page && page.get('body') && t?.kind === 'doc' ? pick(page.get('body')) : [], empty: 'Opens the tab.' }
  },
})

// ---- card construction ----
const cards = new Map() // id -> { ... }

// folded bullet points, per device (shared by every editor of a note)
const folds = createFoldStore()

// The options every body editor gets (cards and the full-screen view).
function editorOpts(note, extra) {
  return {
    onLocal: () => stamp(note),
    onLink: followLink,
    linkCandidates,
    arrows: () => getSettings().arrows,
    dates: () => getSettings().dates !== false,
    spellcheck: () => getSettings().spellcheck,
    folds,
    reveal: () => !!search.value.trim(), // searching shows what is folded
    onEmbedClick: (emb) => openLightbox(emb),
    onFiles: async (files) => {
      const urls = await uploadImages(files)
      const rich = extra.getRich && extra.getRich()
      if (urls.length && rich) rich.insertMedia(urls)
    },
    onTag: (tag) => openHome('tag:' + tag),
    askLink: async (current) => {
      const v = await ui.dialog({
        title: current ? 'Edit link' : 'Add a link',
        input: { value: current || '', placeholder: 'https://…' },
        buttons: [{ label: 'Cancel', value: null }, ...(current ? [{ label: 'Remove link', value: '' }] : []), { label: current ? 'Save' : 'Link', value: true, primary: true }],
      })
      return typeof v === 'string' ? v : null
    },
    unfurl: (url) =>
      fetch('/api/unfurl?url=' + encodeURIComponent(url))
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => (d && d.title) || null)
        .catch(() => null),
    slashExtras: () => [
      {
        id: 'picture',
        label: 'Picture',
        icon: 'image',
        keys: 'image photo upload',
        run: async (rich) => {
          const files = await pickImages()
          const urls = files.length ? await uploadImages(files) : []
          if (urls.length) rich.insertMedia(urls)
        },
      },
      { id: 'template', label: 'Template…', icon: 'note', keys: 'snippet insert', run: (rich) => chooseTemplate((tpl) => rich.insertLines(templateLines(tpl, {}))) },
    ],
    ...extra,
  }
}

// Phones get their own Keep-style layout (see the phone section below).
function phoneMode() {
  return mqStack.matches
}

function applyNoteStyle(el, note) {
  const color = renderedPaper(note.get('color') || PAPER[0])
  el.style.background = color
  el.style.setProperty('--note-ink', inkFor(color))
  el.style.setProperty('--note-ink-dim', inkDimFor(color))
  el.style.setProperty('--note-line', hairlineFor(color))
  el.style.setProperty('--note-link', inkFor(color) === '#ffffff' ? '#ffd60a' : '#694b00')
  el.style.setProperty('--note-fs', (note.get('fontSize') || FS_DEFAULT) + 'px')
  // title follows the body (+1px) unless the note opted into its own size
  const ts = note.get('titleSize')
  if (ts) el.style.setProperty('--title-fs', ts + 'px')
  else el.style.removeProperty('--title-fs')
  el.classList.toggle('autogrow', growsWithContent(note))
  el.classList.toggle('book', note.get('layout') === 'book')
  el.classList.toggle('pinned', !!note.get('pinned'))
  const tEl = el.querySelector(':scope > .card-title')
  if (tEl) tEl.style.textAlign = note.get('titleAlign') || ''
  for (const cls of Object.values(SIZES)) el.classList.remove(cls)
  el.classList.add(SIZES[note.get('size')] || SIZES.m)
}

// Notes grow with their content unless someone gave them a fixed height
// (an unset `autoGrow` means on; switching it off stores false).
function growsWithContent(note) {
  return note.get('autoGrow') !== false
}
function setAutoGrow(note, on) {
  if (on) note.delete('autoGrow')
  else note.set('autoGrow', false)
}

// ---- free-floating "corkboard" layout -------------------------------------
// Desktop: notes are absolutely positioned — drag the header to move, drag the
// corner grip to resize. Narrow screens fall back to the stacked flow layout
// (x/y/w/h are ignored there so a phone stays usable).
const mqStack = window.matchMedia('(max-width: 600px)')
let freeLayout = !mqStack.matches

// Two desktop views of a tab, chosen per tab (shared): the "board" grows
// downwards inside the window width; the "canvas" is an endless plane you pan
// and zoom (src/viewport.js). Cards live in `board` for the board and in
// `plane` (the transformed layer) for the canvas.
const plane = document.createElement('div')
plane.className = 'plane'
let canvasMode = false
const LAYOUT = 'layout' // origin of position/size writes, so they can be undone as layout steps

function container() {
  return canvasMode ? plane : board
}

function noteRect(c) {
  const n = c.note
  return {
    id: c.id,
    x: canvasMode ? n.get('x') || 0 : c.el.offsetLeft,
    y: canvasMode ? n.get('y') || 0 : c.el.offsetTop,
    w: c.el.offsetWidth || n.get('w') || W_DEFAULT,
    h: c.el.offsetHeight || n.get('h') || H_DEFAULT,
  }
}

// free-hand ink between the notes (see src/ink.js); bound to the active tab in reconcile()
const ink = createInk({ Y, toPlane, zoom: () => zoom(), onChange: () => { if (!canvasMode) updateBoardExtent() } })
board.appendChild(ink.capture)

const viewport = createViewport({
  board,
  plane,
  getRects: () => {
    const rects = Array.from(cards.values())
      .filter((c) => !c.el.classList.contains('hidden'))
      .map((c) => ({ ...noteRect(c), color: c.note.get('color') }))
    const b = ink.bounds() // fit and the minimap take the ink into account too
    if (b) rects.push({ ...b, color: 'transparent' })
    return rects
  },
  onChange: () => {
    if (marquee) marquee.refresh()
  },
  // Shift+drag on the canvas draws a selection box; in ink mode a drag draws
  shouldPan: (e) => !e.shiftKey && !ink.isActive(),
})

function toPlane(cx, cy) {
  if (canvasMode) return viewport.toPlane(cx, cy)
  const r = board.getBoundingClientRect()
  return { x: cx - r.left - board.clientLeft, y: cy - r.top - board.clientTop }
}
const zoom = () => (canvasMode ? viewport.view().k : 1)

const guides = createGuides()

function setCanvasMode(on, tabId) {
  const want = !!on && freeLayout
  // nothing to move (moving a card would blur an editor and reload any video in it)
  if (want === canvasMode) {
    if (want && viewport.tab() !== tabId) viewport.enable(tabId) // another canvas tab: its own view
    return
  }
  canvasMode = want
  board.classList.toggle('canvas', canvasMode)
  if (canvasMode) {
    board.appendChild(plane)
    for (const [, c] of cards) plane.appendChild(c.el)
    viewport.enable(tabId)
  } else {
    viewport.disable()
    for (const [, c] of cards) board.appendChild(c.el)
    plane.remove()
  }
  const box = container()
  box.appendChild(ink.el) // z-index 0: under the notes
  box.appendChild(guides.el)
  board.appendChild(ink.capture)
  relayoutAll()
}

function applyNoteLayout(el, note) {
  el.classList.toggle('free', freeLayout)
  if (!freeLayout) {
    el.style.left = ''
    el.style.top = ''
    el.style.width = ''
    el.style.height = ''
    el.style.zIndex = ''
    return
  }
  const w = clamp(note.get('w') || SIZE_W[note.get('size')] || W_DEFAULT, W_MIN, 4000)
  const h = Math.max(H_MIN, note.get('h') || H_DEFAULT)
  let x = note.get('x') || 0
  let y = note.get('y') || 0
  if (!canvasMode) {
    // the board only grows downwards: keep everything inside the window width
    const bw = board.clientWidth || window.innerWidth
    x = clamp(x, 0, Math.max(0, bw - w))
    y = Math.max(0, y)
  }
  el.style.left = x + 'px'
  el.style.top = y + 'px'
  el.style.width = w + 'px'
  // collapsed (title only) and auto-growing notes size themselves to content
  const fluid = collapsed.has(el.dataset.id) || growsWithContent(note)
  el.style.height = fluid ? '' : h + 'px'
  el.style.zIndex = String(note.get('z') || 1)
}

function maxZ() {
  let m = 0
  yNotes.forEach((n) => {
    const z = n.get('z')
    if (typeof z === 'number' && z > m) m = z
  })
  return m
}

function bringToFront(note) {
  if (!freeLayout) return
  const topZ = maxZ()
  if ((note.get('z') || 0) >= topZ) return
  // z only ever grew before; renumber everyone by rank when it drifts far above
  // the note count so the values stay small (the board is also its own stacking
  // context now, so the chrome is safe whatever these are).
  if (topZ > yNotes.size + 200) {
    const all = []
    yNotes.forEach((n, id) => all.push({ id, n, z: n.get('z') || 0 }))
    all.sort((a, b) => a.z - b.z)
    note.doc.transact(() => {
      all.forEach((e, i) => e.n.set('z', i + 1))
      note.set('z', all.length + 1)
    })
    return
  }
  note.doc.transact(() => note.set('z', topZ + 1))
}

function updateBoardExtent() {
  if (!freeLayout || canvasMode) {
    board.style.minHeight = ''
    if (canvasMode) viewport.refreshMap()
    return
  }
  let maxB = 0
  for (const [id, c] of cards) {
    const n = c.note
    const y = Math.max(0, n.get('y') || 0)
    const fluid = collapsed.has(id) || growsWithContent(n)
    const h = fluid ? c.el.offsetHeight || H_MIN : Math.max(H_MIN, n.get('h') || H_DEFAULT)
    if (y + h > maxB) maxB = y + h
  }
  const b = ink.bounds()
  if (b && b.y + b.h > maxB) maxB = b.y + b.h
  board.style.minHeight = maxB + 60 + 'px'
}

function relayoutAll() {
  board.classList.toggle('free', freeLayout)
  for (const [, c] of cards) applyNoteLayout(c.el, c.note)
  updateBoardExtent()
}

function nextNotePos() {
  const n = cards.size
  const step = 28
  if (canvasMode) {
    // in the middle of what is on screen
    const c = viewport.center()
    return { x: Math.round(c.x - SIZE_W.m / 2 + (n % 5) * 18), y: Math.round(c.y - H_DEFAULT / 2 + (n % 5) * 18) }
  }
  return { x: 24 + (n % 7) * step, y: 24 + (n % 7) * step }
}

// ---- layout undo: moves, resizes and alignments are one undo step each -------
const layoutUndo = new Y.UndoManager(yNotes, { trackedOrigins: new Set([LAYOUT]), captureTimeout: 1e9 })
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return
  const k = e.key.toLowerCase()
  if (k !== 'z' && k !== 'y') return
  const a = document.activeElement
  if (a && (a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')) return
  const t = activeTab()
  if (!freeLayout || full || !isNotesTab(t)) return
  const redo = k === 'y' || e.shiftKey
  if (redo ? !layoutUndo.redoStack.length : !layoutUndo.undoStack.length) return
  e.preventDefault()
  if (redo) layoutUndo.redo()
  else layoutUndo.undo()
})

// write several notes' positions/sizes as one shared change and one undo step
function applyLayout(changes) {
  if (!changes.length) return
  layoutUndo.stopCapturing()
  doc.transact(() => {
    for (const ch of changes) {
      const n = yNotes.get(ch.id)
      if (!n) continue
      if (ch.x != null) n.set('x', Math.round(ch.x))
      if (ch.y != null) n.set('y', Math.round(ch.y))
      if (ch.w != null) n.set('w', Math.round(ch.w))
      if (ch.h != null) {
        n.set('h', Math.round(ch.h))
        if (n.get('autoGrow') !== false) n.set('autoGrow', false) // a set height pins the note
      }
    }
  }, LAYOUT)
  layoutUndo.stopCapturing()
}

// ---- selecting several notes (desktop) ---------------------------------------
const boardSel = new Set()
function setSelected(ids) {
  boardSel.clear()
  for (const id of ids) if (cards.has(id)) boardSel.add(id)
  for (const [id, c] of cards) c.el.classList.toggle('sel', boardSel.has(id))
  renderAlignBar()
}
function toggleSelected(id) {
  const next = new Set(boardSel)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  setSelected(next)
}

const alignBar = document.createElement('div')
alignBar.className = 'align-bar'
alignBar.hidden = true
document.body.appendChild(alignBar)
alignBar.addEventListener('pointerdown', (e) => e.stopPropagation())

function selRects() {
  return Array.from(boardSel)
    .map((id) => cards.get(id))
    .filter(Boolean)
    .map((c) => {
      const r = noteRect(c)
      // in board view work from the stored values (the drawn ones may be clamped)
      if (!canvasMode) return { ...r, x: c.note.get('x') || 0, y: c.note.get('y') || 0 }
      return r
    })
}

function renderAlignBar() {
  const n = boardSel.size
  alignBar.hidden = n < 2 || !freeLayout
  if (alignBar.hidden) return
  alignBar.replaceChildren()
  const b = (html, title, fn) => {
    const x = document.createElement('button')
    x.className = 'align-btn'
    if (html.startsWith('<svg')) x.innerHTML = html
    else iconLabel(x, html)
    x.title = title

    x.setAttribute('aria-label', x.title)
    x.addEventListener('click', (e) => {
      e.stopPropagation()
      fn()
    })
    alignBar.appendChild(x)
  }
  const label = document.createElement('span')
  label.className = 'align-count'
  label.textContent = n + ' notes'
  alignBar.appendChild(label)
  const I = (d) => svg(d)
  b(I('M2.5 2v12M5 5h8M5 10h5'), 'Align left edges', () => applyLayout(alignRects(selRects(), 'left')))
  b(I('M8 2v12M3 5h10M5 10h6'), 'Align centres (vertical line)', () => applyLayout(alignRects(selRects(), 'center')))
  b(I('M13.5 2v12M3 5h8M6 10h5'), 'Align right edges', () => applyLayout(alignRects(selRects(), 'right')))
  b(I('M2 2.5h12M5 5v8M10 5v5'), 'Align top edges', () => applyLayout(alignRects(selRects(), 'top')))
  b(I('M2 8h12M5 3v10M10 5v6'), 'Align middles (horizontal line)', () => applyLayout(alignRects(selRects(), 'middle')))
  b(I('M2 13.5h12M5 3v8M10 6v5'), 'Align bottom edges', () => applyLayout(alignRects(selRects(), 'bottom')))
  const sep = document.createElement('span')
  sep.className = 'align-sep'
  alignBar.appendChild(sep)
  b(I('M2 3v10M14 3v10M6 5h4v6H6z'), 'Space evenly, left to right', () => applyLayout(distributeRects(selRects(), 'h')))
  b(I('M3 2h10M3 14h10M5 6h6v4H5z'), 'Space evenly, top to bottom', () => applyLayout(distributeRects(selRects(), 'v')))
  b(I('M2 5h12M2 11h12M4 3l-2 2 2 2M12 9l2 2-2 2'), 'Same width', () => applyLayout(matchSize(selRects(), 'w')))
  b(I('M5 2v12M11 2v12M3 4l2-2 2 2M9 12l2 2 2-2'), 'Same height', () => applyLayout(matchSize(selRects(), 'h')))
  b(I('M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z'), 'Tidy up into a grid', () => applyLayout(tidyRects(selRects())))
  const sep2 = document.createElement('span')
  sep2.className = 'align-sep'
  alignBar.appendChild(sep2)
  b('🎨', 'Colour the selected notes', () => {
    const x = alignBar.querySelector('[data-act="color"]')
    swatchSheet(x, PAPER.concat(getFavorites()), (c) =>
      doc.transact(() => boardSel.forEach((nid) => yNotes.get(nid)?.set('color', c)))
    )
  })
  alignBar.lastChild.dataset.act = 'color'
  b('🗑', 'Delete the selected notes (Delete)', () => deleteSelected())
  b('✕', 'Clear selection (Esc)', () => setSelected([]))
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && boardSel.size) setSelected([])
  if ((e.key === 'Delete' || e.key === 'Backspace') && boardSel.size > 1 && !isTypingTarget(e.target)) {
    e.preventDefault()
    deleteSelected()
  }
})
function isTypingTarget(t) {
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
}
// Move every selected note to the trash in one step, with Undo.
function deleteSelected() {
  const ids = Array.from(boardSel).filter((nid) => yNotes.get(nid))
  if (!ids.length) return
  const now = Date.now()
  doc.transact(() => ids.forEach((nid) => yNotes.get(nid).set('deleted', now)))
  setSelected([])
  ui.toast(ids.length + (ids.length === 1 ? ' note' : ' notes') + ' moved to trash', {
    action: 'Undo',
    ms: 7000,
    onAction: () => ids.forEach((nid) => restoreNote(nid)),
  })
}

// drag a box on empty board (or Shift+drag on the canvas) to select notes
let marquee = null
board.addEventListener('pointerdown', (e) => {
  if (!freeLayout || e.button !== 0) return
  const bg = e.target === board || e.target === plane
  if (!bg) return
  if (canvasMode && !e.shiftKey) return // plain drag pans the canvas
  e.preventDefault()
  const start = toPlane(e.clientX, e.clientY)
  const box = document.createElement('div')
  box.className = 'marquee'
  container().appendChild(box)
  const base = e.shiftKey || e.ctrlKey || e.metaKey ? new Set(boardSel) : new Set()
  let moved = false
  let last = e
  const update = () => {
    const p = toPlane(last.clientX, last.clientY)
    const x = Math.min(start.x, p.x)
    const y = Math.min(start.y, p.y)
    const w = Math.abs(p.x - start.x)
    const h = Math.abs(p.y - start.y)
    box.style.left = x + 'px'
    box.style.top = y + 'px'
    box.style.width = w + 'px'
    box.style.height = h + 'px'
    const hit = new Set(base)
    for (const [id, c] of cards) {
      if (c.el.classList.contains('hidden')) continue
      const r = { x: c.el.offsetLeft, y: c.el.offsetTop, w: c.el.offsetWidth, h: c.el.offsetHeight }
      if (r.x < x + w && r.x + r.w > x && r.y < y + h && r.y + r.h > y) hit.add(id)
    }
    setSelected(hit)
  }
  marquee = { refresh: update }
  const move = (ev) => {
    last = ev
    if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return
    moved = true
    update()
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    box.remove()
    marquee = null
    if (!moved && !base.size) setSelected([])
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
})

// notes this drag should snap against: the visible ones that aren't moving
function snapTargets(moving) {
  const out = []
  for (const [id, c] of cards) {
    if (moving.has(id) || c.el.classList.contains('hidden')) continue
    out.push({ x: c.el.offsetLeft, y: c.el.offsetTop, w: c.el.offsetWidth, h: c.el.offsetHeight })
  }
  return out
}
function snapOpts(ev) {
  const st = getSettings()
  if (ev && ev.altKey) return null
  if (!st.snap && !st.grid) return null
  return { threshold: 7 / zoom(), grid: st.grid ? Math.max(4, Number(st.gridSize) || 20) : 0, edges: st.snap }
}

// Board view → bring notes that sit outside the window width (e.g. placed on
// the canvas) back into view, below the others. One undo step.
function bringAllIntoView() {
  const bw = board.clientWidth || window.innerWidth
  const inside = []
  const outside = []
  for (const [id, c] of cards) {
    const n = c.note
    const x = n.get('x') || 0
    const y = n.get('y') || 0
    const w = n.get('w') || W_DEFAULT
    if (x < 0 || y < 0 || x + w > bw) outside.push({ id, w, h: c.el.offsetHeight || n.get('h') || H_DEFAULT })
    else inside.push({ y, h: c.el.offsetHeight || n.get('h') || H_DEFAULT })
  }
  if (!outside.length) {
    ui.toast('Every note is already in view.')
    return
  }
  let y = inside.reduce((m, r) => Math.max(m, r.y + r.h), 0) + 24
  let x = 16
  let rowH = 0
  const changes = []
  for (const o of outside) {
    if (x + o.w > bw - 8 && x > 16) {
      x = 16
      y += rowH + 16
      rowH = 0
    }
    changes.push({ id: o.id, x, y })
    x += o.w + 16
    rowH = Math.max(rowH, o.h)
  }
  applyLayout(changes)
  ui.toast(`Moved ${outside.length} note${outside.length === 1 ? '' : 's'} into view.`, { action: 'Undo', onAction: () => layoutUndo.undo() })
}

mqStack.addEventListener('change', () => {
  freeLayout = !mqStack.matches
  // phone and desktop cards behave differently (read-only previews vs editors): rebuild them
  for (const [cid, c] of cards) {
    destroyCard(c)
    cards.delete(cid)
  }
  phoneRefresh()
  relayoutAll()
  scheduleReconcile()
})
window.addEventListener(
  'resize',
  rafThrottle(() => {
    if (freeLayout) relayoutAll()
  })
)

// ---- formatting toolbar (cards and the full-screen editor) ----------------
const LIST_STYLES = [
  ['disc', '•', 'Bullets', 'Ctrl+Shift+8'],
  ['square', '▪', 'Squares'],
  ['arrow', '→', 'Arrows'],
  ['dash', '–', 'Dashes'],
  ['decimal', '1.', 'Numbers', 'Ctrl+Shift+7'],
  ['alpha', 'a.', 'Letters'],
  ['roman', 'i.', 'Roman numerals'],
]
const svg = (d, extra = '') =>
  `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${extra}<path d="${d}"/></svg>`
const ICONS = Object.fromEntries(['list', 'todo', 'left', 'center', 'right', 'image', 'fold'].map(name => [name, iconHTML(name === 'right' ? 'alignRight' : name === 'fold' ? 'down' : name)]))

function buildFmtBar(getRich) {
  const el = document.createElement('div')
  el.className = 'card-fmt'
  const btns = {}
  const mkBtn = (cls, html, tip, onPress) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'fmt-btn ' + cls
    b.innerHTML = html
    b.title = tip

    b.setAttribute('aria-label', b.title)
    b.addEventListener('mousedown', (e) => e.preventDefault()) // keep the body's selection
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      const rich = getRich()
      if (rich) onPress(rich, b)
    })
    el.appendChild(b)
    return b
  }
  ;[
    ['b', 'B', 'Bold  (Ctrl/Cmd+B)'],
    ['i', 'I', 'Italic  (Ctrl/Cmd+I)'],
    ['u', 'U', 'Underline  (Ctrl/Cmd+U)'],
    ['s', 'S', 'Strikethrough  (Ctrl/Cmd+Shift+S)'],
  ].forEach(([mark, label, tip]) => {
    btns[mark] = mkBtn('fmt-' + mark, iconHTML({b:'bold',i:'italic',u:'underline',s:'strike'}[mark]), tip, (rich) => rich.toggleMark(mark))
  })
  const sep = document.createElement('span')
  sep.className = 'fmt-sep'
  el.appendChild(sep)
  let state = {}
  btns.list = mkBtn('fmt-list', ICONS.list, 'Bullets, numbers and headings', (rich, b) => {
    const cur = state.lt === 'li' ? state.mk || 'disc' : null
    ui.menu(
      b,
      [
        ...LIST_STYLES.map(([mk, glyph, label, hint]) => ({
          icon: glyph,
          label,
          hint,
          on: cur === mk,
          onClick: () => rich.toggleList(mk),
        })),
        'sep',
        { icon: 'H', label: 'Heading', hint: '# then space', on: state.lt === 'h', onClick: () => rich.toggleHeading() },
        { icon: '”', label: 'Quote', hint: '> then space', on: state.lt === 'callout' && state.co === 'quote', onClick: () => rich.setCallout('quote') },
        ...['note', 'tip', 'warning', 'danger'].map((k) => ({ icon: '!', label: 'Callout: ' + k, on: state.lt === 'callout' && state.co === k, onClick: () => rich.setCallout(k) })),
        { icon: '—', label: 'Divider', hint: 'type /divider', onClick: () => rich.insertDivider() },
        { icon: '¶', label: 'Plain text', onClick: () => (state.lt === 'h' ? rich.toggleHeading() : state.lt === 'todo' ? rich.toggleTodo() : state.lt === 'li' ? rich.toggleList(cur) : state.lt === 'callout' && rich.setCallout(state.co)) },
      ],
      { keepFocus: true, cls: 'fmt-menu' }
    )
  })
  btns.todo = mkBtn('fmt-todo', ICONS.todo, 'Checkbox  (Ctrl/Cmd+Shift+9, or type [] and a space)', (rich) => rich.toggleTodo())
  let marksNow = {}
  btns.hl = mkBtn('fmt-hl', iconHTML('palette'), 'Highlight  (Ctrl/Cmd+Shift+H)', (rich, b) => {
    ui.menu(
      b,
      [
        ...HIGHLIGHTS.map((c) => ({ icon: '●', label: c[0].toUpperCase() + c.slice(1), cls: 'hl-pick hl-' + c, on: marksNow.hl === c, onClick: () => rich.toggleMark('hl', c) })),
        ...(marksNow.hl ? ['sep', { label: 'No highlight', onClick: () => rich.toggleMark('hl', marksNow.hl) }] : []),
      ],
      { keepFocus: true, cls: 'fmt-menu' }
    )
  })
  btns.link = mkBtn('fmt-link', iconHTML('external'), 'Link the selected text  (Ctrl/Cmd+K)', (rich) => {
    rich.editLink().then((did) => {
      if (!did) ui.toast('Select some text to link first (or type [[ to link a note).')
    })
  })
  btns.align = mkBtn('fmt-align', ICONS.left, 'Align: left → centre → right  (Ctrl/Cmd+Shift+L / E / R)', (rich) => {
    const cur = state.al || 'left'
    rich.setAlign(cur === 'left' ? 'center' : cur === 'center' ? 'right' : 'left')
  })
  btns.image = mkBtn('fmt-image', ICONS.image, 'Add a picture (or paste / drop one in)', async (rich) => {
    const files = await pickImages()
    if (!files.length) return
    const urls = await uploadImages(files)
    if (urls.length) rich.insertMedia(urls)
  })
  function update(marks, line) {
    marksNow = marks || {}
    for (const m of ['b', 'i', 'u', 's']) btns[m].classList.toggle('on', !!(marks && marks[m]))
    btns.hl.classList.toggle('on', !!marksNow.hl)
    btns.link.classList.toggle('on', !!marksNow.href)
    state = line || {}
    btns.list.classList.toggle('on', state.lt === 'li' || state.lt === 'h' || state.lt === 'callout')
    btns.todo.classList.toggle('on', state.lt === 'todo')
    const al = state.al || 'left'
    btns.align.innerHTML = ICONS[al] || ICONS.left
    btns.align.classList.toggle('on', al !== 'left')
  }
  return { el, btns, update }
}

function createCard(id) {
  const note = yNotes.get(id)
  const el = document.createElement('article')
  el.className = 'card'
  el.dataset.id = id

  const top = document.createElement('div')
  top.className = 'card-top'
  const presenceEl = document.createElement('div')
  presenceEl.className = 'card-presence'
  const tools = document.createElement('div')
  tools.className = 'card-tools'

  const del = document.createElement('button')
  del.className = 'icon-btn del'
  del.title = 'Delete note'

  del.setAttribute('aria-label', del.title)
  iconLabel(del, '×')
  del.addEventListener('click', () => deleteNote(id)) // soft delete + Undo toast

  const fold = document.createElement('button')
  fold.className = 'icon-btn fold'
  fold.title = 'Collapse / expand (just for you)'

  fold.setAttribute('aria-label', fold.title)
  iconLabel(fold, '⌄')
  fold.addEventListener('click', (e) => {
    e.stopPropagation()
    setCollapsed(id, !collapsed.has(id))
  })

  const expand = document.createElement('button')
  expand.className = 'icon-btn expand'
  expand.title = 'Open full screen (or double-click the header)'

  expand.setAttribute('aria-label', expand.title)
  iconLabel(expand, '⤢')
  expand.addEventListener('click', (e) => {
    e.stopPropagation()
    openFullscreen(id)
  })

  tools.append(fold, expand, del) // the note's settings live in the ribbon
  top.append(presenceEl, tools)
  if (collapsed.has(id)) el.classList.add('collapsed')

  const titleEl = document.createElement('input')
  titleEl.className = 'card-title'
  titleEl.placeholder = 'Title'
  titleEl.maxLength = 120
  titleEl.spellcheck = getSettings().spellcheck
  titleEl.readOnly = phoneMode() // phone cards are previews; editing happens full screen
  titleEl.addEventListener('keydown', (e) => {
    // Tab from the title goes into the body, never out of the note
    if (e.key === 'Tab' && !e.shiftKey) {
      const body = card.bodyHost.querySelector('.card-body, .todo-text')
      if (body) {
        e.preventDefault()
        body.focus()
      }
    }
  })

  // formatting lives in the ribbon: the editors report their state there
  // while this note is the one being edited
  const fmtBar = { update: (marks, line) => ribbonState(card, marks, line) }

  // body region: either the rich-text editor or a checklist (depends on kind)
  const bodyHost = document.createElement('div')
  bodyHost.className = 'card-bodyhost'

  const meta = document.createElement('div')
  meta.className = 'card-meta'
  const timeEl = document.createElement('span')
  meta.appendChild(timeEl)
  const setMeta = () => {
    const at = note.get('lastEditedAt')
    const by = note.get('lastEditedBy')
    if (at && by && by.name && by.id !== me.id) timeEl.textContent = 'edited ' + relTime(at) + ' by ' + by.name
    else if (at) timeEl.textContent = 'edited ' + relTime(at)
    else timeEl.textContent = relTime(note.get('created') || Date.now())
  }
  setMeta()

  // corner grip for resizing (free layout only — hidden via CSS otherwise)
  const grip = document.createElement('div')
  grip.className = 'resize-grip'
  grip.title = 'Drag to resize'

  grip.setAttribute('aria-label', grip.title)
  el.append(top, titleEl, bodyHost, meta, grip)

  // Shift/Ctrl/Cmd-click anywhere on a note adds it to / removes it from the
  // selection. In the note you are typing in, Shift-click keeps its usual job of
  // extending the text selection.
  el.addEventListener(
    'pointerdown',
    (e) => {
      if (!freeLayout || phoneMode() || !(e.shiftKey || e.ctrlKey || e.metaKey)) return
      if (e.button != null && e.button !== 0 && e.pointerType === 'mouse') return
      if (e.target.closest('.card-tools, .card-pop, .resize-grip')) return
      const typing = el.contains(document.activeElement) && document.activeElement.isContentEditable
      if (typing && e.shiftKey && !e.target.closest('.card-top')) return
      e.preventDefault()
      e.stopPropagation()
      toggleSelected(id)
    },
    true
  )

  applyNoteStyle(el, note)
  applyNoteLayout(el, note)

  // ---- drag to move (header) + drag to resize (grip), free layout only ----
  // While dragging we drive the moving cards' inline styles and write their
  // positions at most once per frame (origin LAYOUT: one undo step per drag),
  // so friends see the motion live. Selected notes move together; edges and
  // centres snap to the neighbours (hold Alt to place freely).
  // `card.interacting` lets noteObs skip re-laying-out while WE drive the style;
  // `card.abortInteraction` lets destroyCard tear down an in-flight drag.
  let pendingPos = null // Map id -> { x, y }
  let pendingSize = null
  const commitPos = () => {
    if (!pendingPos) return
    const p = pendingPos
    pendingPos = null
    doc.transact(() => {
      for (const [nid, v] of p) {
        const n = yNotes.get(nid)
        if (!n) continue // deleted mid-drag; don't resurrect keys
        n.set('x', Math.round(v.x))
        n.set('y', Math.round(v.y))
      }
    }, LAYOUT)
  }
  const commitSize = () => {
    if (!pendingSize) return
    const sz = pendingSize
    pendingSize = null
    if (!yNotes.has(id)) return
    doc.transact(() => {
      note.set('w', Math.round(sz.w))
      if (note.get('kind') === 'image') return // a picture's height follows its width
      note.set('h', Math.round(sz.h))
      if (note.get('autoGrow') !== false) note.set('autoGrow', false) // resizing pins the height
    }, LAYOUT)
  }
  const schedulePos = rafThrottle(commitPos)
  const scheduleSize = rafThrottle(commitSize)

  top.addEventListener('pointerdown', (e) => {
    if (!freeLayout) return
    if (e.button != null && e.button !== 0 && e.pointerType === 'mouse') return
    if (e.target.closest('.card-tools')) return // let the gear / delete buttons work
    e.preventDefault()
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      toggleSelected(id) // Shift/Ctrl/Cmd-click: add to / remove from the selection
      return
    }
    if (!boardSel.has(id) && boardSel.size) setSelected([])
    bringToFront(note)
    const k = zoom()
    const sx = e.clientX
    const sy = e.clientY
    const group =
      boardSel.has(id) && boardSel.size > 1 ? Array.from(boardSel).map((x) => cards.get(x)).filter(Boolean) : [card]
    const starts = group.map((c) => ({
      c,
      x: canvasMode ? c.note.get('x') || 0 : c.el.offsetLeft,
      y: canvasMode ? c.note.get('y') || 0 : c.el.offsetTop,
      w: c.el.offsetWidth,
      h: c.el.offsetHeight,
    }))
    const mine = starts.find((st) => st.c === card)
    const others = snapTargets(new Set(group.map((c) => c.id)))
    const bw = board.clientWidth
    try {
      top.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    for (const c of group) {
      c.interacting = true
      c.el.classList.add('dragging')
    }
    layoutUndo.stopCapturing()
    let moved = false
    const move = (ev) => {
      let dx = (ev.clientX - sx) / k
      let dy = (ev.clientY - sy) / k
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return
      moved = true
      const so = snapOpts(ev)
      if (so) {
        const res = snapMove({ x: mine.x + dx, y: mine.y + dy, w: mine.w, h: mine.h }, so.edges ? others : [], so)
        dx += res.dx
        dy += res.dy
        guides.show(res.guides, k)
      } else guides.clear()
      pendingPos = new Map()
      for (const st of starts) {
        let nx = st.x + dx
        let ny = st.y + dy
        if (!canvasMode) {
          nx = clamp(nx, 0, Math.max(0, bw - st.w))
          ny = Math.max(0, ny)
        }
        nx = Math.round(nx)
        ny = Math.round(ny)
        st.c.el.style.left = nx + 'px'
        st.c.el.style.top = ny + 'px'
        pendingPos.set(st.c.id, { x: nx, y: ny })
      }
      schedulePos()
    }
    const end = (ev) => {
      top.removeEventListener('pointermove', move)
      top.removeEventListener('pointerup', end)
      top.removeEventListener('pointercancel', end)
      if (ev) {
        try {
          top.releasePointerCapture(ev.pointerId)
        } catch {
          /* ignore */
        }
      }
      for (const c of group) {
        c.interacting = false
        c.el.classList.remove('dragging')
      }
      card.abortInteraction = null
      guides.clear()
      commitPos()
      layoutUndo.stopCapturing()
      updateBoardExtent()
    }
    card.abortInteraction = end
    top.addEventListener('pointermove', move)
    top.addEventListener('pointerup', end)
    top.addEventListener('pointercancel', end)
  })

  grip.addEventListener('pointerdown', (e) => {
    if (!freeLayout) return
    if (e.button != null && e.button !== 0 && e.pointerType === 'mouse') return
    e.preventDefault()
    e.stopPropagation()
    bringToFront(note)
    const k = zoom()
    const sx = e.clientX
    const sy = e.clientY
    const ow = el.offsetWidth
    const oh = el.offsetHeight
    const x = canvasMode ? note.get('x') || 0 : el.offsetLeft
    const y = canvasMode ? note.get('y') || 0 : el.offsetTop
    const bw = board.clientWidth
    const others = snapTargets(new Set([id]))
    try {
      grip.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    card.interacting = true
    el.classList.add('resizing')
    layoutUndo.stopCapturing()
    const move = (ev) => {
      let nw = ow + (ev.clientX - sx) / k
      let nh = oh + (ev.clientY - sy) / k
      const so = snapOpts(ev)
      if (so) {
        const res = snapResize({ x, y, w: nw, h: nh }, so.edges ? others : [], so)
        nw = res.w
        nh = res.h
        guides.show(res.guides, k)
      } else guides.clear()
      nw = Math.max(W_MIN, nw)
      if (!canvasMode) nw = Math.min(nw, Math.max(W_MIN, bw - x))
      nh = Math.round(Math.max(H_MIN, nh))
      nw = Math.round(nw)
      el.style.width = nw + 'px'
      el.style.height = nh + 'px'
      pendingSize = { w: nw, h: nh }
      scheduleSize()
    }
    const end = (ev) => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', end)
      grip.removeEventListener('pointercancel', end)
      if (ev) {
        try {
          grip.releasePointerCapture(ev.pointerId)
        } catch {
          /* ignore */
        }
      }
      card.interacting = false
      card.abortInteraction = null
      el.classList.remove('resizing')
      guides.clear()
      commitSize()
      layoutUndo.stopCapturing()
      updateBoardExtent()
    }
    card.abortInteraction = end
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', end)
    grip.addEventListener('pointercancel', end)
  })

  const unbinds = []
  unbinds.push(bindInput(note.get('title'), titleEl, () => applyFilter()))
  watchTitle(titleEl, () => yNotes.get(id), id)
  el.addEventListener('input', () => stamp(note))
  el.addEventListener('change', () => stamp(note))

  const card = {
    el,
    unbinds,
    body: null,
    fmtBar,
    titleEl,
    bodyHost,
    presenceEl,
    timeEl,
    setMeta,
    note,
    noteObs: null,
    id,
    pop: null,
    activeRich: null,
    interacting: false, // a drag/resize is in progress (suppresses observer relayout)
    abortInteraction: null, // teardown for an in-flight drag/resize (called on destroy)
  }

  mountBody(card)
  attachPhoneGestures(card)

  // presence focus follows any field inside the card (title, body, list items);
  // the ribbon follows the note last clicked or typed in
  el.addEventListener('focusin', () => {
    awareness.setLocalStateField('focus', id)
    bringToFront(note)
    setRibbonTarget(card)
  })
  el.addEventListener('pointerdown', () => { if (!phoneMode()) setRibbonTarget(card) })
  el.addEventListener('focusout', (e) => {
    if (el.contains(e.relatedTarget)) return
    if (awareness.getLocalState()?.focus === id) awareness.setLocalStateField('focus', null)
  })

  top.addEventListener('dblclick', (e) => {
    if (e.target.closest('.card-tools')) return
    openFullscreen(id)
  })

  const noteObs = (e, transaction) => {
    if (!e.keysChanged) return
    if (e.keysChanged.has('kind') || e.keysChanged.has('layout')) {
      rebuildCard(id)
      return
    }
    if (e.keysChanged.has('deleted') || e.keysChanged.has('archived')) {
      scheduleReconcile()
      return
    }
    if (e.keysChanged.has('lastEditedAt')) setMeta()
    if (
      e.keysChanged.has('color') ||
      e.keysChanged.has('fontSize') ||
      e.keysChanged.has('size') ||
      e.keysChanged.has('titleSize') ||
      e.keysChanged.has('titleAlign') ||
      e.keysChanged.has('pinned') ||
      e.keysChanged.has('autoGrow')
    ) {
      if (e.keysChanged.has('pinned') && phoneMode()) scheduleReconcile()
      applyNoteStyle(el, note)
      if (card.pop) refreshPopover(card)
      if (ribbonTarget?.card === card) refreshRibbon()
      if (e.keysChanged.has('autoGrow') && !card.interacting) {
        applyNoteLayout(el, note)
        updateBoardExtent()
      }
    }
    if (
      !card.interacting && // while WE drag/resize, the pointer handler owns the inline style
      (e.keysChanged.has('x') ||
        e.keysChanged.has('y') ||
        e.keysChanged.has('w') ||
        e.keysChanged.has('h') ||
        e.keysChanged.has('z') ||
        e.keysChanged.has('size'))
    ) {
      const before = transaction?.local === false && !phoneMode() ? el.getBoundingClientRect() : null
      applyNoteLayout(el, note)
      if (before) {
        el.style.transformOrigin = '0 0'
        ui.zoomFrom(el, before)?.finished.then(() => el.getAnimations().forEach(a => a.cancel())).catch(() => {})
      }
      updateBoardExtent()
    }
    if (e.keysChanged.has('tabId')) scheduleReconcile()
  }
  note.observe(noteObs)
  card.noteObs = noteObs

  if (typeof ResizeObserver !== 'undefined') {
    card.ro = new ResizeObserver(
      rafThrottle(() => {
        if (freeLayout && (collapsed.has(id) || growsWithContent(note))) updateBoardExtent()
      })
    )
    card.ro.observe(el)
  }

  return card
}

// Switching a note between prose and checklist swaps its whole body, so the
// simplest correct thing is to tear the card down and let reconcile rebuild it.
function rebuildCard(id) {
  queueMicrotask(() => {
    const c = cards.get(id)
    if (!c) return
    destroyCard(c)
    cards.delete(id)
    scheduleReconcile()
  })
}

function ensureItems(note) {
  if (note.get('items')) return
  note.doc.transact(() => {
    if (!note.get('items')) note.set('items', new Y.Array())
  })
}

function mountBody(card) {
  if (card.body) {
    card.body.destroy()
    card.body = null
  }
  card.activeRich = null
  card.bodyHost.replaceChildren()
  const note = card.note
  const kind = note.get('kind') || 'note'
  card.el.classList.toggle('is-todo', kind === 'todo')
  card.el.classList.toggle('is-image', kind === 'image')
  if (kind === 'todo') {
    // a checklist from before todo lines existed; the Pi converts it moments after it syncs
    ensureItems(note)
    card.body = bindTodo(card, note.get('items'))
    return
  }

  const book = note.get('layout') === 'book'
  const pages = book ? [note.get('body'), note.get('body2') || ensureBody2(note)] : [note.get('body')]
  const editors = pages.map((ytext, i) => {
    const bodyEl = document.createElement('div')
    bodyEl.className = 'card-body' + (book ? ' page page-' + (i ? 'r' : 'l') : '')
    bodyEl.setAttribute('data-ph', book ? (i ? 'Right page…' : 'Left page…') : 'Take a note…')
    card.bodyHost.appendChild(bodyEl)
    const rich = bindRichText(ytext, bodyEl, editorOpts(note, {
      onChange: () => applyFilter(),
      onState: (marks, line) => card.fmtBar.update(marks, line),
      editable: card.isFull || !phoneMode(),
      getRich: () => rich,
    }))
    bodyEl.addEventListener('focus', () => {
      card.activeRich = rich
    })
    return rich
  })
  card.body = {
    kind: 'note',
    rich: editors[0],
    editors,
    destroy: () => editors.forEach((r) => r.destroy()),
  }
}

function ensureBody2(note) {
  note.doc.transact(() => {
    if (!note.get('body2')) note.set('body2', new Y.Text())
  })
  return note.get('body2')
}

// Checklist body: items live in a Y.Array<Y.Map{ id, text:Y.Text, done }>.
// Text edits flow through bindInput per item; structural (add/remove) changes
// re-render the rows; `done` changes update a single checkbox in place.
function bindTodo(card, items) {
  const host = document.createElement('div')
  host.className = 'card-todo'
  card.bodyHost.appendChild(host)
  const list = document.createElement('div')
  list.className = 'todo-list'
  const addBtn = document.createElement('button')
  addBtn.className = 'todo-add'
  iconLabel(addBtn, '+ Add item')
  addBtn.addEventListener('click', () => addItem(items.length, '', true))
  host.append(list, addBtn)

  const rowCleanups = []
  let focusAfter = null // item id to focus once the next render lands

  function indexOfItem(item) {
    for (let i = 0; i < items.length; i++) if (items.get(i) === item) return i
    return -1
  }

  function addItem(at, text, focus) {
    const iid = genId()
    if (focus) focusAfter = iid
    const it = new Y.Map()
    items.doc.transact(() => {
      const t = new Y.Text()
      it.set('id', iid)
      it.set('text', t)
      it.set('done', false)
      items.insert(at, [it])
      if (text) t.insert(0, text)
    })
  }

  function removeItem(item) {
    const idx = indexOfItem(item)
    if (idx >= 0) items.doc.transact(() => items.delete(idx, 1))
  }

  function onItemKey(e, item, txt) {
    if (e.key === 'Tab') {
      // Tab / Shift+Tab walk the list instead of leaving the note
      e.preventDefault()
      const idx = indexOfItem(item)
      const next = e.shiftKey ? idx - 1 : idx + 1
      if (next >= 0 && next < items.length) {
        const elx = list.querySelector('[data-iid="' + items.get(next).get('id') + '"] .todo-text')
        if (elx) elx.focus()
      } else if (!e.shiftKey) addItem(items.length, '', true)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      addItem(indexOfItem(item) + 1, '', true)
    } else if (e.key === 'Backspace' && txt.value === '' && txt.selectionStart === 0) {
      e.preventDefault()
      if (items.length <= 1) return // never delete the last row — keep an editable item
      const idx = indexOfItem(item)
      focusAfter = (idx > 0 ? items.get(idx - 1) : items.get(idx + 1)).get('id')
      removeItem(item)
    }
  }

  function buildRow(item) {
    const row = document.createElement('div')
    row.className = 'todo-item'
    row.dataset.iid = item.get('id')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.className = 'todo-check'
    cb.checked = !!item.get('done')
    cb.addEventListener('change', () => item.doc.transact(() => item.set('done', cb.checked)))
    const txt = document.createElement('input')
    txt.className = 'todo-text'
    txt.maxLength = 280
    txt.spellcheck = getSettings().spellcheck
    const unbindText = bindInput(item.get('text'), txt, () => applyFilter())
    txt.addEventListener('keydown', (e) => onItemKey(e, item, txt))
    const delB = document.createElement('button')
    delB.className = 'todo-del'
    iconLabel(delB, '×')
    delB.title = 'Remove item'

    delB.setAttribute('aria-label', delB.title)
    delB.addEventListener('click', () => removeItem(item))
    const obs = (e) => {
      if (e.keysChanged && e.keysChanged.has('done')) {
        cb.checked = !!item.get('done')
        row.classList.toggle('done', cb.checked)
      }
    }
    item.observe(obs)
    rowCleanups.push(() => {
      unbindText()
      item.unobserve(obs)
    })
    row.classList.toggle('done', !!item.get('done'))
    row.append(cb, txt, delB)
    return row
  }

  function render() {
    // A structural change (often a remote peer adding/removing an item) rebuilds
    // every row. Capture the caret of whatever item is being typed in so a peer's
    // edit can't eject the local user from the field they're in.
    let keep = null
    const active = document.activeElement
    if (active && active.classList && active.classList.contains('todo-text') && list.contains(active)) {
      const row = active.closest('.todo-item')
      keep = { iid: row && row.dataset.iid, start: active.selectionStart, end: active.selectionEnd }
    }
    rowCleanups.forEach((f) => f())
    rowCleanups.length = 0
    list.replaceChildren()
    items.forEach((item) => list.appendChild(buildRow(item)))
    const want = focusAfter || (keep && keep.iid)
    focusAfter = null
    if (want) {
      const elx = list.querySelector('[data-iid="' + want + '"] .todo-text')
      if (elx) {
        elx.focus()
        const caret = keep && keep.iid === want ? keep : null
        const s = caret ? caret.start : elx.value.length
        const en = caret ? caret.end : elx.value.length
        try {
          elx.setSelectionRange(s, en)
        } catch {
          /* ignore */
        }
      }
    }
  }

  const itemsObs = () => render()
  items.observe(itemsObs)
  render()

  return {
    kind: 'todo',
    destroy() {
      items.unobserve(itemsObs)
      rowCleanups.forEach((f) => f())
      host.remove()
    },
  }
}

function destroyCard(card) {
  if (card.abortInteraction) card.abortInteraction() // tear down an in-flight drag/resize
  if (card.ro) card.ro.disconnect()
  card.unbinds.forEach((fn) => fn())
  if (card.body) card.body.destroy()
  card.note.unobserve(card.noteObs)
  if (card.pop) {
    card.closePop?.()
    card.pop.remove()
    card.pop = null
  }
  card.el.remove()
  if (boardSel.delete(card.id)) renderAlignBar()
  if (ribbonTarget?.card === card) setRibbonTarget(null)
}

// ---- options popover (colour / size / text) ----
function closeAllPopovers() {
  for (const [, c] of cards) {
    if (c.pop) {
      c.closePop?.()
      c.pop.classList.remove('open')
    }
  }
  if (full && full.card.pop) { full.card.closePop?.(); full.card.pop.classList.remove('open') }
}

function togglePopover(card, anchor = card.el.querySelector('.opt')) {
  const wasOpen = card.pop && card.pop.classList.contains('open')
  closeAllPopovers()
  if (wasOpen) return
  if (!card.pop) buildPopover(card)
  refreshPopover(card)
  const pop = card.pop
  document.body.appendChild(pop)
  card.closePop = ui.popover(pop, anchor, { retain: true, label: 'Note options' })
}

function buildPopover(card) {
  const pop = document.createElement('div')
  pop.className = 'card-pop'
  pop.addEventListener('click', (e) => e.stopPropagation())

  // Colour
  const cSec = section('Colour')
  const presets = document.createElement('div')
  presets.className = 'pop-swatches'
  PAPER.forEach((c) => presets.appendChild(swatch(card, c)))
  const favWrap = document.createElement('div')
  favWrap.className = 'pop-swatches pop-favs'
  const customRow = document.createElement('div')
  customRow.className = 'pop-row'
  const colorInput = document.createElement('input')
  colorInput.type = 'color'
  colorInput.className = 'pop-color'
  colorInput.addEventListener('input', () => card.note.set('color', colorInput.value))
  const saveFav = document.createElement('button')
  saveFav.className = 'pop-btn'
  iconLabel(saveFav, '★ Save')
  saveFav.title = 'Save this colour to favourites'

  saveFav.setAttribute('aria-label', saveFav.title)
  saveFav.addEventListener('click', () => {
    addFavorite(card.note.get('color') || PAPER[0])
    renderFavs(card)
  })
  const customLabel = document.createElement('span')
  customLabel.className = 'pop-label'
  customLabel.textContent = 'Custom'
  customRow.append(customLabel, colorInput, saveFav)
  cSec.append(presets, favWrap, customRow)

  // Text size
  const tSec = section('Text size')
  const tRow = document.createElement('div')
  tRow.className = 'pop-row pop-stepper'
  const minus = stepBtn('A', 'smaller', () => bumpFont(card, -1))
  minus.classList.add('a-small')
  const fsVal = document.createElement('span')
  fsVal.className = 'pop-val'
  const plus = stepBtn('A', 'larger', () => bumpFont(card, 1))
  plus.classList.add('a-big')
  tRow.append(minus, fsVal, plus)
  tSec.append(tRow)

  // Width
  const wSec = section('Note width')
  const wRow = document.createElement('div')
  wRow.className = 'pop-row pop-sizes'
  const sizeBtns = {}
  ;[
    ['s', 'S'],
    ['m', 'M'],
    ['l', 'L'],
  ].forEach(([k, label]) => {
    const b = document.createElement('button')
    b.className = 'pop-btn size-btn'
    iconLabel(b, label)
    b.addEventListener('click', () =>
      card.note.doc.transact(() => {
        card.note.set('size', k)
        card.note.set('w', SIZE_W[k]) // quick-resize width in the corkboard layout
      })
    )
    wRow.appendChild(b)
    sizeBtns[k] = b
  })
  wSec.append(wRow)

  // Layout: one page or a two-page book (prose notes only)
  const lSec = section('Layout')
  const lRow = document.createElement('div')
  lRow.className = 'pop-row pop-sizes'
  const layoutBtns = {}
  ;[
    ['single', 'Single'],
    ['book', 'Book'],
  ].forEach(([k, label]) => {
    const b = document.createElement('button')
    b.className = 'pop-btn size-btn'
    iconLabel(b, label)
    b.title = k === 'book' ? 'Two pages side by side' : 'One page'

    b.setAttribute('aria-label', b.title)
    b.addEventListener('click', () => setNoteLayout(card.note, k))
    lRow.appendChild(b)
    layoutBtns[k] = b
  })
  lSec.append(lRow)

  // Title size (opt in) + auto-grow
  const oSec = section('Options')
  const tsRow = document.createElement('label')
  tsRow.className = 'pop-row pop-check'
  const tsChk = document.createElement('input')
  tsChk.type = 'checkbox'
  tsChk.addEventListener('change', () => {
    if (tsChk.checked) card.note.set('titleSize', (card.note.get('fontSize') || FS_DEFAULT) + 3)
    else card.note.delete('titleSize')
  })
  tsRow.append(tsChk, document.createTextNode(' Size title separately'))
  const tsStep = document.createElement('div')
  tsStep.className = 'pop-row pop-stepper'
  const tMinus = stepBtn('A', 'smaller title', () => bumpTitle(card, -1))
  tMinus.classList.add('a-small')
  const tsVal = document.createElement('span')
  tsVal.className = 'pop-val'
  const tPlus = stepBtn('A', 'larger title', () => bumpTitle(card, 1))
  tPlus.classList.add('a-big')
  tsStep.append(tMinus, tsVal, tPlus)
  const agRow = document.createElement('label')
  agRow.className = 'pop-row pop-check'
  const agChk = document.createElement('input')
  agChk.type = 'checkbox'
  agChk.addEventListener('change', () => {
    setAutoGrow(card.note, agChk.checked)
  })
  agRow.append(agChk, document.createTextNode(' Grow with content (no inner scroll)'))
  // title alignment (line alignment lives on the formatting toolbar)
  const taRow = document.createElement('div')
  taRow.className = 'pop-row pop-sizes pop-align'
  const taLabel = document.createElement('span')
  taLabel.className = 'pop-label'
  taLabel.textContent = 'Title'
  taRow.appendChild(taLabel)
  const taBtns = {}
  for (const al of ['left', 'center', 'right']) {
    const b = document.createElement('button')
    b.className = 'pop-btn size-btn'
    b.innerHTML = ICONS[al]
    b.title = 'Title: ' + (al === 'center' ? 'centre' : al)

    b.setAttribute('aria-label', b.title)
    b.addEventListener('click', () => {
      if (al === 'left') card.note.delete('titleAlign')
      else card.note.set('titleAlign', al)
    })
    taRow.appendChild(b)
    taBtns[al] = b
  }
  oSec.append(tsRow, tsStep, agRow, taRow)

  // Move to another tab
  const mSec = section('Move to tab')
  const mSel = document.createElement('select')
  mSel.className = 'pop-select'
  mSel.addEventListener('change', () => {
    if (mSel.value && mSel.value !== card.note.get('tabId')) moveNoteToTab(card.id, mSel.value)
  })
  mSec.append(mSel)

  // Actions
  const aSec = section('More')
  const aRow = document.createElement('div')
  aRow.className = 'pop-row pop-actions'
  const archiveBtn = document.createElement('button')
  archiveBtn.className = 'pop-btn'
  archiveBtn.textContent = 'Archive'
  archiveBtn.title = 'Hide this note without deleting it'

  archiveBtn.setAttribute('aria-label', archiveBtn.title)
  archiveBtn.addEventListener('click', () => {
    closeAllPopovers()
    setNoteArchived(card.id, true)
  })
  const histBtn = document.createElement('button')
  histBtn.className = 'pop-btn'
  histBtn.textContent = 'History'
  histBtn.title = 'Earlier versions of this note'

  histBtn.setAttribute('aria-label', histBtn.title)
  histBtn.addEventListener('click', () => {
    closeAllPopovers()
    openHistoryPanel(card.id)
  })
  const pinBtn = document.createElement('button')
  pinBtn.className = 'pop-btn'
  pinBtn.title = 'Pinned notes come first on phones and in the widget'

  pinBtn.setAttribute('aria-label', pinBtn.title)
  pinBtn.addEventListener('click', () => {
    if (card.note.get('pinned')) card.note.delete('pinned')
    else card.note.set('pinned', true)
  })
  const deleteBtn = document.createElement('button')
  deleteBtn.className = 'pop-btn danger'
  iconLabel(deleteBtn, 'Delete', 'trash')
  deleteBtn.addEventListener('click', () => { closeAllPopovers(); deleteNote(card.id) })
  iconLabel(archiveBtn, 'Archive', 'archive')
  iconLabel(histBtn, 'History', 'history')
  const actBtn = (label, ico, title, fn) => {
    const b = document.createElement('button')
    b.className = 'pop-btn'
    iconLabel(b, label, ico)
    b.title = title
    b.setAttribute('aria-label', title)
    b.addEventListener('click', () => {
      closeAllPopovers()
      fn()
    })
    return b
  }
  const shareBtn = actBtn('Share link', 'external', 'A read-only link to this note for someone not on the board', () => openShareDialog({ note: card.note }))
  const extractBtn = actBtn('Selection → new note', 'compose', 'Move the selected text to a new note and leave a [[link]] in its place', () => extractSelection(card))
  const mergeBtn = actBtn('Merge into…', 'arrow', 'Append this note to another one and move this one to the trash', () => mergeNoteInto(card.id))
  const printBtn = actBtn('Print / PDF', 'download', 'Print this note or save it as a PDF', () => printNote(card.id))
  aRow.append(pinBtn, archiveBtn, histBtn, deleteBtn, shareBtn, extractBtn, mergeBtn, printBtn)
  aSec.append(aRow)

  // Other names a [[link]] can use for this note
  const akaSec = section('Also known as')
  const akaInput = document.createElement('input')
  akaInput.className = 'pop-input pop-aka'
  akaInput.placeholder = 'Other names, separated by commas'
  akaInput.setAttribute('aria-label', 'Aliases: other names for links to this note')
  akaInput.addEventListener('change', () => setAliases(card.note, akaInput.value))
  akaInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') akaInput.blur()
  })
  akaSec.append(akaInput)

  // What links here (the section brings its own headings)
  const linkSec = document.createElement('div')
  linkSec.className = 'pop-sec'
  const linkHost = document.createElement('div')
  linkSec.append(linkHost)

  pop.append(cSec, tSec, wSec, lSec, oSec, mSec, akaSec, aSec, linkSec)
  card.el.appendChild(pop)
  card.pop = pop
  card.popRefs = { colorInput, favWrap, fsVal, sizeBtns, layoutBtns, tsChk, tsStep, tsVal, agChk, mSel, lSec, taBtns, pinBtn, akaInput, linkHost, shareBtn }
  colorInput.setAttribute('aria-label', 'Custom paper colour')
  mSel.setAttribute('aria-label', 'Move to tab')
  renderFavs(card)

  function section(name) {
    const s = document.createElement('div')
    s.className = 'pop-sec'
    const h = document.createElement('div')
    h.className = 'pop-h'
    h.textContent = name
    s.appendChild(h)
    return s
  }
}

function swatch(card, color) {
  const b = document.createElement('button')
  b.className = 'pop-swatch'
  b.style.background = renderedPaper(color)
  b.dataset.color = color
  b.style.color = inkFor(renderedPaper(color))
  b.appendChild(makeIcon('check'))
  b.title = color

  b.setAttribute('aria-label', b.title)
  b.addEventListener('click', () => card.note.set('color', color))
  return b
}

function renderFavs(card) {
  if (!card.popRefs) return
  const wrap = card.popRefs.favWrap
  wrap.innerHTML = ''
  const favs = getFavorites()
  if (favs.length === 0) {
    const hint = document.createElement('span')
    hint.className = 'pop-hint'
    hint.textContent = 'No favourites yet — pick a colour and Save.'
    wrap.appendChild(hint)
    return
  }
  favs.forEach((c) => {
    const b = swatch(card, c)
    b.classList.add('fav')
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      removeFavorite(c)
      renderFavs(card)
    })
    wrap.appendChild(b)
  })
}

function refreshPopover(card) {
  card.pop.querySelectorAll('.pop-swatch').forEach(b => {
    const on = normalizeHex(b.dataset.color) === normalizeHex(card.note.get('color') || PAPER[0])
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on))
  })
  if (!card.popRefs) return
  const { colorInput, fsVal, sizeBtns } = card.popRefs
  colorInput.value = normalizeHex(card.note.get('color') || PAPER[0])
  fsVal.textContent = (card.note.get('fontSize') || FS_DEFAULT) + 'px'
  const sz = card.note.get('size') || 'm'
  for (const k of Object.keys(sizeBtns)) sizeBtns[k].classList.toggle('on', k === sz)
  const kind = card.note.get('kind') || 'note'
  const { layoutBtns, tsChk, tsStep, tsVal, agChk, mSel, lSec } = card.popRefs
  const layout = card.note.get('layout') || 'single'
  for (const k of Object.keys(layoutBtns)) layoutBtns[k].classList.toggle('on', k === layout)
  lSec.style.display = kind === 'todo' ? 'none' : ''
  const ts = card.note.get('titleSize')
  tsChk.checked = !!ts
  tsStep.style.display = ts ? '' : 'none'
  tsVal.textContent = (ts || (card.note.get('fontSize') || FS_DEFAULT) + 1) + 'px'
  agChk.checked = growsWithContent(card.note)
  const ta = card.note.get('titleAlign') || 'left'
  for (const k of Object.keys(card.popRefs.taBtns)) card.popRefs.taBtns[k].classList.toggle('on', k === ta)
  iconLabel(card.popRefs.pinBtn, card.note.get('pinned') ? 'Unpin' : 'Pin', 'pin')
  iconLabel(card.popRefs.shareBtn, card.note.get('share') ? 'Shared link' : 'Share link', 'external')
  if (document.activeElement !== card.popRefs.akaInput) card.popRefs.akaInput.value = aliasesOf(card.note).join(', ')
  card.popRefs.linkHost.replaceChildren(linksSection(namesOf(card.note), card.id, { compact: true }))
  mSel.replaceChildren()
  for (const t of tabsList()) {
    if (!isNotesTab(t)) continue
    const o = document.createElement('option')
    o.value = t.id
    o.textContent = (t.archived ? '(archived) ' : '') + t.name
    o.selected = t.id === card.note.get('tabId')
    mSel.appendChild(o)
  }
  renderFavs(card)
}

function bumpTitle(card, dir) {
  const cur = card.note.get('titleSize') || (card.note.get('fontSize') || FS_DEFAULT) + 1
  const next = clamp(cur + dir, FS_MIN, FS_MAX + 10)
  if (next !== cur) card.note.set('titleSize', next)
}

function bumpFont(card, dir) {
  const cur = card.note.get('fontSize') || FS_DEFAULT
  const next = clamp(cur + dir, FS_MIN, FS_MAX)
  if (next !== cur) card.note.set('fontSize', next)
}

function stepBtn(text, title, fn) {
  const b = document.createElement('button')
  b.className = 'pop-btn'
  iconLabel(b, text)
  b.title = title

  b.setAttribute('aria-label', b.title)
  b.addEventListener('click', fn)
  return b
}

// ---- drawing surface lifecycle ----
let drawState = null // { tabId, surface }
const drawTool = loadDrawTool()

function loadDrawTool() {
  try {
    const v = JSON.parse(localStorage.getItem('notesDrawTool') || 'null')
    if (v && v.color) return { color: v.color, width: v.width || 4, mode: 'pen' }
  } catch {
    /* ignore */
  }
  return { color: DOCUMENT_INK, width: 4, mode: 'pen' }
}
function saveDrawTool() {
  try {
    localStorage.setItem('notesDrawTool', JSON.stringify({ color: drawTool.color, width: drawTool.width }))
  } catch {
    /* ignore */
  }
}

function getStrokeArray(tabId) {
  let a = yDrawings.get(tabId)
  if (!a) {
    doc.transact(() => {
      if (!yDrawings.get(tabId)) yDrawings.set(tabId, new Y.Array())
    })
    a = yDrawings.get(tabId)
  }
  return a
}

function mountDraw(tabId) {
  if (drawState && drawState.tabId === tabId) return
  unmountDraw()
  const strokes = getStrokeArray(tabId)
  const surface = createDrawSurface(canvasHost, strokes, { color: drawTool.color, width: drawTool.width })
  surface.setMode(drawTool.mode)
  drawState = { tabId, surface }
  buildDrawBar(surface)
}

function unmountDraw() {
  if (!drawState) return
  drawState.surface.destroy()
  drawState = null
  drawBar.innerHTML = ''
}

// ---- document and mind map tabs --------------------------------------------
// One shared page per tab (yPages): a document is a full-width rich-text editor
// on a sheet of paper; a mind map draws the same kind of outline as a map.
let pageState = null // { tabId, kind, rich?, map?, destroy }

function mountPage(tabId, kind) {
  if (pageState && pageState.tabId === tabId && pageState.kind === kind) return
  unmountPage()
  const page = getPage(tabId, activeTab()?.name)
  pageView.replaceChildren()
  pageView.dataset.kind = kind
  if (kind === 'tasks') {
    const list = createTasksView(pageView, page, {
      tabId,
      openSource,
      journal: { days: journalNotes, open: openDay },
      touch: (src) => {
        const n = src.kind === 'note' ? yNotes.get(src.id) : null
        if (n) stamp(n)
      },
    })
    pageState = { tabId, kind, list, destroy: () => list.destroy() }
    return
  }
  if (kind === 'mindmap') {
    // createMindMap reads note.get('title' | 'body') and note.doc: a page has both
    const map = createMindMap(pageView, page, {
      todoTabs: () => tabsList().filter((t) => t.kind === 'tasks' && !t.archived),
      sendToTodo,
    })
    pageState = { tabId, kind, map, destroy: () => map.destroy() }
    return
  }
  const sheet = document.createElement('div')
  sheet.className = 'page-sheet'
  const body = document.createElement('div')
  body.className = 'page-body card-body'
  body.setAttribute('data-ph', 'Start writing…')
  sheet.appendChild(body)
  // what links to this document, under the page
  const links = document.createElement('div')
  links.className = 'page-links'
  // the outline: headings to jump to, with the word count and reading time
  const outline = document.createElement('aside')
  outline.className = 'page-outline'
  outline.setAttribute('aria-label', 'Outline')
  const outlineBtn = document.createElement('button')
  outlineBtn.type = 'button'
  outlineBtn.className = 'icon-btn page-outline-btn'
  outlineBtn.title = 'Outline and word count'
  outlineBtn.setAttribute('aria-label', outlineBtn.title)
  outlineBtn.appendChild(makeIcon('list'))
  const showOutline = (on) => {
    pageView.classList.toggle('outline-open', on)
    outlineBtn.setAttribute('aria-pressed', String(on))
  }
  outlineBtn.addEventListener('click', () => {
    const on = !pageView.classList.contains('outline-open')
    setSetting('outline', on)
    showOutline(on)
  })
  showOutline(getSettings().outline !== false && !phoneMode())
  // phones have no ribbon: the document brings its own toolbar, docked at the bottom
  const fmt = buildFmtBar(() => pageState?.rich)
  fmt.el.classList.add('page-fmt')
  sheet.appendChild(links)
  pageView.append(outlineBtn, outline, sheet, fmt.el)
  const rich = bindRichText(page.get('body'), body, editorOpts(page, {
    onState: (marks, line) => {
      fmt.update(marks, line)
      if (ribbonTarget?.page) ribbonFmt.update(marks, line)
    },
    getRich: () => rich,
  }))
  const drawOutline = () => {
    const ls = linesOf(page.get('body'))
    let words = 0
    for (const L of ls) if (!embedOf(L.text)) words += (L.text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length
    outline.replaceChildren()
    const h = document.createElement('div')
    h.className = 'outline-h'
    h.textContent = 'Outline'
    outline.appendChild(h)
    const heads = ls.map((L, index) => ({ L, index })).filter(({ L }) => L.attrs.lt === 'h' && L.text.trim())
    if (!heads.length) {
      const e = document.createElement('div')
      e.className = 'outline-empty'
      e.textContent = 'Headings you add (# and a space) show up here.'
      outline.appendChild(e)
    }
    for (const { L, index } of heads) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'outline-item'
      b.textContent = L.text.trim()
      b.addEventListener('click', () => rich.revealAt({ index }, { caret: true }))
      outline.appendChild(b)
    }
    const stats = document.createElement('div')
    stats.className = 'outline-stats'
    const mins = Math.max(1, Math.round(words / 230))
    stats.textContent = words.toLocaleString() + (words === 1 ? ' word' : ' words') + ' · ' + (words ? mins + ' min read' : 'nothing to read yet')
    outline.appendChild(stats)
  }
  const drawLinks = () => links.replaceChildren(linksSection([activeTab()?.name || ''], tabId))
  const outlineSoon = debounce(drawOutline, 250)
  const linksSoon = debounce(drawLinks, 700)
  const onBody = () => outlineSoon()
  const onBoard = () => linksSoon()
  page.get('body').observeDeep(onBody)
  yNotes.observeDeep(onBoard)
  drawOutline()
  drawLinks()
  body.addEventListener('focus', () => setRibbonTarget({ page: true }))
  pageState = {
    tabId,
    kind,
    rich,
    destroy: () => {
      outlineSoon.cancel()
      linksSoon.cancel()
      page.get('body').unobserveDeep(onBody)
      yNotes.unobserveDeep(onBoard)
      rich.destroy()
    },
  }
  setRibbonTarget({ page: true })
}

function unmountPage() {
  if (!pageState) return
  pageState.destroy()
  pageState = null
  pageView.replaceChildren()
  if (ribbonTarget?.page) setRibbonTarget(null)
}

// ---- ink between the notes -------------------------------------------------
const inkKey = (tabId) => 'ink:' + tabId
// the tab's ink, or null; created the first time someone draws on the tab
function inkArray(tabId, create) {
  let a = yDrawings.get(inkKey(tabId))
  if (!a && create) {
    doc.transact(() => {
      if (!yDrawings.get(inkKey(tabId))) yDrawings.set(inkKey(tabId), new Y.Array())
    })
    a = yDrawings.get(inkKey(tabId))
  }
  return a || null
}
yDrawings.observe((e) => {
  if (activeTabId && e.keysChanged.has(inkKey(activeTabId))) scheduleReconcile() // ink appeared or went
})

const inkTool = { color: drawTool.color, width: Math.min(drawTool.width, 6), mode: 'pen' }
ink.setTool(inkTool)

function setInking(on) {
  const t = activeTab()
  const want = !!on && freeLayout && isNotesTab(t)
  if (want) {
    ink.bind(inkArray(t.id, true))
    if (boardSel.size) setSelected([])
    document.activeElement?.blur?.()
  }
  ink.setActive(want)
  board.classList.toggle('inking', want)
  refreshRibbon()
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ink.isActive()) setInking(false)
  const typing = e.target.closest?.('input, textarea, select, [contenteditable="true"]')
  if (typing || e.ctrlKey || e.metaKey || e.altKey) {
    // Ctrl/Cmd+Z in ink mode undoes your own last stroke
    if (ink.isActive() && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.shiftKey) ink.redo()
      else ink.undo()
    }
    return
  }
  if ((e.key === 'd' || e.key === 'D') && isNotesTab(activeTab()) && freeLayout && !full) setInking(!ink.isActive())
}, true)

// ---- the ribbon (Word-style toolbar under the tabs, desktop) ------------------
// Acts on the note last clicked or typed in (or the document tab). Its Text and
// Note groups are greyed out until there is one, like Word with no document.
let ribbonTarget = null // { card } | { page: true } | null
const ribbon = createRibbon(document.getElementById('ribbon'))

const textGroup = ribbon.group('Text', 'rib-text')
const ribbonFmt = buildFmtBar(() => {
  if (ribbonTarget?.page) return pageState?.rich || null
  const c = ribbonTarget?.card
  return c ? c.activeRich || (c.body && c.body.rich) || null : null
})
ribbonFmt.el.className = 'rib-fmt'
textGroup.appendChild(ribbonFmt.el)

const noteGroup = ribbon.group('Note', 'rib-note')
const targetNote = () => ribbonTarget?.card?.note || null
const onNote = (fn) => () => {
  const n = targetNote()
  if (n) fn(n, ribbonTarget.card)
}
const ribColor = ribbon.button(noteGroup, {
  cls: 'rib-color',
  title: 'Paper colour',
  onPress: (b) => {
    const n = targetNote()
    if (n) swatchSheet(b, PAPER.concat(getFavorites()), (c) => n.set('color', c))
  },
})
const ribColorDot = document.createElement('span')
ribColorDot.className = 'rib-color-dot'
ribColor.prepend(ribColorDot)
ribbon.sep(noteGroup)
ribbon.button(noteGroup, { icon: 'minus', title: 'Smaller text', onPress: onNote((n, c) => bumpFont(c, -1)) })
const ribFs = document.createElement('span')
ribFs.className = 'rib-value'
noteGroup.appendChild(ribFs)
ribbon.button(noteGroup, { icon: 'plus', title: 'Larger text', onPress: onNote((n, c) => bumpFont(c, 1)) })
ribbon.sep(noteGroup)
const ribSizes = {}
for (const [k, label] of [['s', 'S'], ['m', 'M'], ['l', 'L']]) {
  ribSizes[k] = ribbon.button(noteGroup, {
    text: label,
    title: 'Note width ' + label,
    toggle: true,
    cls: 'rib-size',
    onPress: onNote((n) => n.doc.transact(() => { n.set('size', k); n.set('w', SIZE_W[k]) })),
  })
}
ribbon.sep(noteGroup)
const ribGrow = ribbon.button(noteGroup, {
  icon: 'rows',
  text: 'Grow',
  title: 'Grow with content (no inner scroll)',
  toggle: true,
  onPress: onNote((n) => setAutoGrow(n, !growsWithContent(n))),
})
const ribPin = ribbon.button(noteGroup, {
  icon: 'pin',
  title: 'Pin to the top',
  toggle: true,
  onPress: onNote((n) => (n.get('pinned') ? n.delete('pinned') : n.set('pinned', true))),
})
ribbon.button(noteGroup, { icon: 'compose', title: 'Move the selected text to a new note (leaves a [[link]])', cls: 'rib-extract', onPress: onNote((n, c) => extractSelection(c)) })
ribbon.button(noteGroup, { icon: 'archive', title: 'Archive', onPress: onNote((n, c) => { setRibbonTarget(null); setNoteArchived(c.id, true) }) })
ribbon.button(noteGroup, { icon: 'trash', title: 'Delete note', cls: 'danger', onPress: onNote((n, c) => { setRibbonTarget(null); deleteNote(c.id) }) })
ribbon.button(noteGroup, {
  icon: 'more',
  text: 'More',
  title: 'More note settings: layout, title, move to tab, history',
  cls: 'rib-more',
  onPress: (b) => {
    const c = ribbonTarget?.card
    if (c) togglePopover(c, b)
  },
})

const drawGroup = ribbon.group('Draw', 'rib-draw')
const ribInk = ribbon.button(drawGroup, {
  icon: 'pencil',
  text: 'Draw',
  title: 'Draw between the notes (D)',
  toggle: true,
  onPress: () => setInking(!ink.isActive()),
})
const inkTools = document.createElement('div')
inkTools.className = 'rib-ink-tools'
drawGroup.appendChild(inkTools)
const ribPens = []
for (const c of PEN_COLORS.slice(0, 7)) {
  const b = ribbon.button(inkTools, {
    cls: 'rib-pen',
    title: 'Pen colour ' + c,
    toggle: true,
    onPress: () => {
      inkTool.color = c
      inkTool.mode = 'pen'
      ink.setTool(inkTool)
      refreshRibbon()
    },
  })
  b.style.setProperty('--pen', c)
  b.dataset.color = c
  ribPens.push(b)
}
const ribWidth = document.createElement('input')
ribWidth.type = 'range'
ribWidth.min = '1'
ribWidth.max = '16'
ribWidth.value = String(inkTool.width)
ribWidth.className = 'rib-width'
ribWidth.title = 'Pen size'
ribWidth.setAttribute('aria-label', 'Pen size')
ribWidth.addEventListener('input', () => {
  inkTool.width = Number(ribWidth.value)
  ink.setTool(inkTool)
})
inkTools.appendChild(ribWidth)
const ribErase = ribbon.button(inkTools, {
  icon: 'eraser',
  title: 'Eraser: removes whole strokes',
  toggle: true,
  onPress: () => {
    inkTool.mode = inkTool.mode === 'erase' ? 'pen' : 'erase'
    ink.setTool(inkTool)
    refreshRibbon()
  },
})
ribbon.button(inkTools, { icon: 'undo', title: 'Undo your last stroke (Ctrl/Cmd+Z)', onPress: () => ink.undo() })
ribbon.button(inkTools, { icon: 'redo', title: 'Redo (Ctrl/Cmd+Shift+Z)', onPress: () => ink.redo() })

function setRibbonTarget(next) {
  if (next && next.el) next = { card: next } // a card
  const same = next?.card ? ribbonTarget?.card === next.card : !!next?.page === !!ribbonTarget?.page && !next === !ribbonTarget
  if (same) return
  ribbonTarget = next
  ribbonFmt.update({}, {})
  refreshRibbon()
}

// an editor reports its marks / line style; mirror them while it is the target
function ribbonState(card, marks, line) {
  if (ribbonTarget?.card === card) ribbonFmt.update(marks, line)
}

function refreshRibbon() {
  const t = activeTab()
  const kind = !t || isNotesTab(t) ? 'notes' : t.kind
  const show = !phoneMode() && (kind === 'notes' || kind === 'doc')
  const c = ribbonTarget?.card
  const n = c?.note
  const prose = !!n && (n.get('kind') || 'note') !== 'todo'
  ribbon.el.hidden = !show
  ribbon.el.dataset.kind = kind
  textGroup.classList.toggle('disabled', !(prose || ribbonTarget?.page))
  noteGroup.hidden = kind !== 'notes'
  noteGroup.classList.toggle('disabled', !n)
  drawGroup.hidden = kind !== 'notes' || !freeLayout
  for (const b of ribbon.el.querySelectorAll('.rib-text button, .rib-note button')) b.disabled = !!b.closest('.disabled')
  const inking = ink.isActive()
  setPressed(ribInk, inking)
  inkTools.hidden = !inking
  for (const b of ribPens) setPressed(b, inkTool.mode === 'pen' && b.dataset.color === inkTool.color)
  setPressed(ribErase, inkTool.mode === 'erase')
  if (n) {
    ribColorDot.style.background = renderedPaper(n.get('color') || PAPER[0])
    ribFs.textContent = (n.get('fontSize') || FS_DEFAULT) + 'px'
    const sz = n.get('size') || 'm'
    for (const k in ribSizes) setPressed(ribSizes[k], k === sz)
    setPressed(ribGrow, growsWithContent(n))
    setPressed(ribPin, !!n.get('pinned'))
  } else {
    ribColorDot.style.background = ''
    ribFs.textContent = '–'
    for (const k in ribSizes) setPressed(ribSizes[k], false)
    setPressed(ribGrow, false)
    setPressed(ribPin, false)
  }
  // "while editing" shows it only when there is something to act on
  const mode = getSettings().ribbon
  document.body.classList.toggle('ribbon-auto', mode === 'editing')
  ribbon.setVisible(show && (mode !== 'editing' || !!ribbonTarget || inking))
  syncChromeHeight()
}
onSettingChange((key) => { if (key === 'ribbon') refreshRibbon() })

// a click on empty board (not a note, the ribbon or one of its menus) ends editing
document.addEventListener('pointerdown', (e) => {
  if (!ribbonTarget?.card) return
  if (e.target.closest('.card, #ribbon, .menu, .card-pop, .dlg-back, .toasts, .full-back')) return
  setRibbonTarget(null)
}, true)

// The chrome above the board (top bar + tabs + ribbon) varies in height; the
// board, canvas, sketch and page views size themselves with --chrome-h.
const chromeEls = [document.querySelector('.topbar'), tabsEl, ribbon.el]
function syncChromeHeight() {
  const [top, tabs, rib] = chromeEls
  const visible = (el) => el && !el.hidden && getComputedStyle(el).display !== 'none'
  const above = (visible(top) ? top.offsetHeight : 0) + (visible(tabs) ? tabs.offsetHeight : 0)
  // "while editing" floats the ribbon over the board, so it never pushes it down
  const ribH = visible(rib) && !document.body.classList.contains('ribbon-auto') ? rib.offsetHeight : 0
  const root = document.documentElement.style
  root.setProperty('--ribbon-top', above + 'px')
  root.setProperty('--chrome-h', above + ribH + 'px')
}
if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(rafThrottle(syncChromeHeight))
  for (const el of chromeEls) if (el) ro.observe(el)
}

function setPenColor(surface, value) {
  drawTool.color = value
  drawTool.mode = 'pen'
  surface.setColor(value)
  surface.setMode('pen')
  saveDrawTool()
  syncDrawBar()
}

function buildDrawBar(surface) {
  drawBar.innerHTML = ''

  const color = document.createElement('input')
  color.type = 'color'
  color.className = 'draw-color'
  color.value = normalizeHex(drawTool.color)
  color.title = 'Pen colour'

  color.setAttribute('aria-label', color.title)
  color.addEventListener('input', () => setPenColor(surface, color.value))

  // quick preset pen colours
  const swatches = document.createElement('div')
  swatches.className = 'draw-swatches'
  const swatchRefs = []
  for (const c of PEN_COLORS) {
    const b = document.createElement('button')
    b.className = 'draw-swatch'
    b.style.background = c
    b.title = c

    b.setAttribute('aria-label', b.title)
    b.addEventListener('click', () => setPenColor(surface, c))
    swatches.appendChild(b)
    swatchRefs.push({ el: b, color: c })
  }

  const width = document.createElement('input')
  width.type = 'range'
  width.min = '1'
  width.max = '40'
  width.value = String(drawTool.width)
  width.className = 'draw-width'
  width.title = 'Pen / text size'

  width.setAttribute('aria-label', width.title)
  width.addEventListener('input', () => {
    drawTool.width = Number(width.value)
    surface.setWidth(drawTool.width)
    saveDrawTool()
  })

  const penBtn = drawBtn('✎ Pen', () => {
    drawTool.mode = 'pen'
    surface.setMode('pen')
    syncDrawBar()
  })
  penBtn.dataset.mode = 'pen'

  const textBtn = drawBtn('T Text', () => {
    drawTool.mode = 'text'
    surface.setMode('text')
    syncDrawBar()
  })
  textBtn.dataset.mode = 'text'

  const eraseBtn = drawBtn('⌫ Eraser', () => {
    drawTool.mode = 'erase'
    surface.setMode('erase')
    syncDrawBar()
  })
  eraseBtn.dataset.mode = 'erase'

  const undoBtn = drawBtn('↶ Undo', () => surface.undoLast())
  const clearBtn = drawBtn('Clear', () => {
    // no confirm: clear now, offer Undo (rebuilds the strokes from a snapshot)
    const strokes = drawState && getStrokeArray(drawState.tabId)
    if (!strokes || !strokes.length) return
    const snap = strokes.toArray().map((m) => m.toJSON())
    surface.clear()
    ui.toast('Sketch cleared', {
      action: 'Undo',
      ms: 8000,
      onAction: () => {
        doc.transact(() => {
          for (const o of snap) {
            const m = new Y.Map()
            for (const [k, v] of Object.entries(o)) {
              if (k === 'points') {
                const pts = new Y.Array()
                pts.push(v)
                m.set('points', pts)
              } else m.set(k, v)
            }
            strokes.push([m])
          }
        })
      },
    })
  })
  clearBtn.classList.add('danger')

  drawBar.append(color, swatches, width, penBtn, textBtn, eraseBtn, undoBtn, clearBtn)
  drawBar._modeBtns = [penBtn, textBtn, eraseBtn]
  drawBar._swatches = swatchRefs
  drawBar._colorInput = color
  syncDrawBar()
}

function syncDrawBar() {
  if (!drawBar._modeBtns) return
  for (const b of drawBar._modeBtns) b.classList.toggle('on', b.dataset.mode === drawTool.mode)
  if (drawBar._colorInput) drawBar._colorInput.value = normalizeHex(drawTool.color)
  if (drawBar._swatches) {
    const cur = normalizeHex(drawTool.color)
    for (const s of drawBar._swatches) s.el.classList.toggle('on', normalizeHex(s.color) === cur)
  }
}

function drawBtn(label, fn) {
  const b = document.createElement('button')
  b.className = 'draw-btn'
  iconLabel(b, label)
  b.addEventListener('click', fn)
  return b
}

// ---- reconcile board with shared state ----
let recPending = false
function scheduleReconcile() {
  if (recPending) return
  recPending = true
  queueMicrotask(() => {
    recPending = false
    reconcile()
  })
}

function reconcile() {
  const active = activeTab()
  const kind = !active || isNotesTab(active) ? 'notes' : active.kind // 'notes' | 'draw' | 'doc' | 'mindmap'
  const notesTab = kind === 'notes'

  board.style.display = notesTab ? '' : 'none'
  drawView.style.display = kind === 'draw' ? 'flex' : 'none'
  pageView.hidden = kind !== 'doc' && kind !== 'mindmap' && kind !== 'tasks'
  addBtn.style.display = notesTab ? '' : 'none'
  searchWrap.style.visibility = notesTab ? '' : 'hidden'
  document.body.dataset.tabKind = kind

  if (!notesTab) {
    for (const [id, card] of cards) {
      destroyCard(card)
      cards.delete(id)
    }
    setCanvasMode(false)
    if (boardSel.size) setSelected([])
    setInking(false)
    ink.bind(null)
    empty.style.display = 'none'
    if (kind === 'draw') {
      unmountPage()
      mountDraw(active.id)
    } else {
      unmountDraw()
      mountPage(active.id, kind)
    }
    renderTabs()
    renderPresence()
    phoneRefresh() // phone title, + button
    refreshRibbon()
    return
  }

  unmountDraw()
  unmountPage()
  board.classList.toggle('free', freeLayout)
  setCanvasMode(active && active.view === 'canvas', active && active.id)
  ink.setEnabled(freeLayout)
  ink.bind(active && freeLayout ? inkArray(active.id) : null)
  if (!freeLayout) setInking(false)
  const box = container()

  let order = yOrder
    .toArray()
    .filter((id) => yNotes.has(id) && belongsToActive(yNotes.get(id), active))
  // the phone grid shows pinned notes first (the desktop board has no order)
  if (phoneMode()) order = order.filter((id) => yNotes.get(id).get('pinned')).concat(order.filter((id) => !yNotes.get(id).get('pinned')))
  const wanted = new Set(order)

  for (const [id, card] of cards) {
    if (!wanted.has(id)) {
      destroyCard(card)
      cards.delete(id)
    }
  }

  let prev = null
  for (const id of order) {
    let card = cards.get(id)
    if (!card) {
      card = createCard(id)
      cards.set(id, card)
    }
    const ref = prev ? prev.nextSibling : box.firstChild
    if (ref !== card.el) box.insertBefore(card.el, ref)
    prev = card.el
  }
  // the ink layer and snap guides live with the cards
  if (ink.el.parentNode !== box) box.appendChild(ink.el)
  if (guides.el.parentNode !== box) box.appendChild(guides.el)
  if (ribbonTarget?.card && !cards.has(ribbonTarget.card.id)) setRibbonTarget(null)
  if (boardSel.size) setSelected(Array.from(boardSel).filter((sid) => cards.has(sid)))

  empty.style.display = order.length ? 'none' : 'flex'
  updateBoardExtent()
  renderTabs()
  renderPresence()
  applyFilter()
  phoneRefresh()
  refreshRibbon()
}

yOrder.observe(scheduleReconcile)
yNotes.observe(scheduleReconcile)
yTabs.observeDeep(scheduleReconcile)
// note field changes that affect what is visible (deleted / archived / tab)
// are handled by each card's observer; hidden notes have no card, so watch
// the map deeply for restores too.
yNotes.observeDeep((events) => {
  for (const e of events) {
    if (e.target !== yNotes && e.keysChanged && (e.keysChanged.has('deleted') || e.keysChanged.has('archived') || e.keysChanged.has('tabId'))) {
      scheduleReconcile()
      return
    }
  }
})

// ---- full-screen editor -------------------------------------------------------
// The note opened large (on a phone: the whole screen). It binds its own
// editors to the same Y types as the card, so both stay live; each editor
// undoes only its own typing. Opening pushes a history entry, so the browser /
// Android back gesture closes it, and #note=<id>&full deep-links straight in.
let full = null

// While typing in a scrolling editor, keep the caret line plus one more line
// in view, so the text never runs under the bottom edge (or the keyboard).
function keepCaretInView(host) {
  const caretRect = () => {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount || !host.contains(sel.focusNode)) return null
    const range = sel.getRangeAt(0).cloneRange()
    range.collapse(false)
    const r = range.getClientRects()[0]
    if (r && r.height) return r
    // an empty line has no caret box: use the line element itself
    const node = sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement
    return node ? node.getBoundingClientRect() : null
  }
  let raf = 0
  const check = () => {
    raf = 0
    const r = caretRect()
    if (!r) return
    const box = host.getBoundingClientRect()
    const line = Math.max(18, r.height)
    const below = r.bottom + line * 1.5 - box.bottom // room for the next line
    if (below > 0) host.scrollBy({ top: below, behavior: 'smooth' })
    else if (r.top < box.top) host.scrollBy({ top: r.top - box.top - line / 2, behavior: 'smooth' })
  }
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(check)
  }
  host.addEventListener('input', schedule)
  host.addEventListener('keyup', schedule)
  document.addEventListener('selectionchange', schedule)
  return () => {
    cancelAnimationFrame(raf)
    host.removeEventListener('input', schedule)
    host.removeEventListener('keyup', schedule)
    document.removeEventListener('selectionchange', schedule)
  }
}

function openFullscreen(id, opts = {}) {
  const note = yNotes.get(id)
  if (!note || note.get('deleted')) return false
  if (full && full.id === id) return true
  const sourceRect = cards.get(id)?.el.getBoundingClientRect()
  const prev = full
  if (full) closeFullscreenNow()
  closeMenus()
  closeAllPopovers()
  if (overlayKind === 'home') closeOverlay()

  const back = document.createElement('div')
  back.className = 'full-back'
  const el = document.createElement('article')
  el.className = 'full card'
  el.dataset.id = id

  const top = document.createElement('div')
  top.className = 'full-top'
  const closeBtn = document.createElement('button')
  closeBtn.className = 'icon-btn full-x'
  closeBtn.title = 'Close (Esc)'

  closeBtn.setAttribute('aria-label', closeBtn.title)
  closeBtn.innerHTML = '<span class="full-x-back">' + iconHTML('back') + '</span><span class="full-x-close">' + iconHTML('close') + '</span>'
  const backLabel = document.createElement('span')
  backLabel.className = 'full-back-label'
  backLabel.textContent = activeTab()?.name || 'Notes'
  closeBtn.appendChild(backLabel)
  closeBtn.addEventListener('click', () => closeFullscreen())
  const presenceEl = document.createElement('div')
  presenceEl.className = 'card-presence'
  const tools = document.createElement('div')
  tools.className = 'card-tools full-tools'
  const optBtn = document.createElement('button')
  optBtn.className = 'icon-btn opt'
  optBtn.title = 'Colour, size, layout & more'

  optBtn.setAttribute('aria-label', optBtn.title)
  iconLabel(optBtn, '', 'more')
  const del = document.createElement('button')
  del.className = 'icon-btn del'
  del.title = 'Delete note'

  del.setAttribute('aria-label', del.title)
  del.replaceChildren(makeIcon('trash'))
  del.addEventListener('click', () => {
    closeFullscreen()
    deleteNote(id)
  })
  tools.append(optBtn, del)
  top.append(closeBtn, presenceEl, tools)

  const titleEl = document.createElement('input')
  titleEl.className = 'card-title full-title'
  titleEl.placeholder = 'Title'
  titleEl.maxLength = 120
  titleEl.spellcheck = getSettings().spellcheck
  const bodyHost = document.createElement('div')
  bodyHost.className = 'card-bodyhost full-bodyhost'
  const card = {
    el,
    id,
    note,
    isFull: true,
    body: null,
    titleEl,
    bodyHost,
    presenceEl,
    pop: null,
    activeRich: null,
    interacting: false,
    unbinds: [],
  }
  const fmtBar = buildFmtBar(() => card.activeRich || (card.body && card.body.rich))
  card.fmtBar = fmtBar
  card.fmtBtns = fmtBar.btns
  fmtBar.el.classList.add('full-fmt')
  const meta = document.createElement('div')
  meta.className = 'card-meta'
  const timeEl = document.createElement('span')
  meta.appendChild(timeEl)
  card.timeEl = timeEl
  card.setMeta = () => {
    const at = note.get('lastEditedAt')
    const by = note.get('lastEditedBy')
    timeEl.textContent =
      at && by && by.name && by.id !== me.id ? 'edited ' + relTime(at) + ' by ' + by.name : 'edited ' + relTime(at || note.get('created') || Date.now())
  }
  card.setMeta()
  titleEl.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) && card.body && card.body.rich) {
      e.preventDefault()
      card.body.rich.focusEnd()
    }
  })
  // what links here, at the foot of the note (kept fresh while it is open)
  const linksHost = document.createElement('div')
  linksHost.className = 'full-links'
  const drawLinks = () => {
    const n = yNotes.get(id)
    if (n) linksHost.replaceChildren(linksSection(namesOf(n), id))
  }
  const linksSoon = debounce(drawLinks, 700)
  // desktop: the toolbar sits under the title like a document's; phone: above the keyboard
  if (phoneMode()) el.append(top, titleEl, bodyHost, fmtBar.el, meta)
  else el.append(top, titleEl, fmtBar.el, bodyHost, meta)
  back.appendChild(el)
  document.body.appendChild(back)
  document.body.classList.add('has-full')

  applyFullStyle(card)
  card.unbinds.push(bindInput(note.get('title'), titleEl, () => applyFilter()))
  watchTitle(titleEl, () => yNotes.get(id), id)
  el.addEventListener('input', () => stamp(note))
  mountBody(card)
  bodyHost.appendChild(linksHost) // scrolls with the text, under it
  drawLinks()
  const onBoard = () => linksSoon()
  yNotes.observeDeep(onBoard)
  yPages.observeDeep(onBoard)
  card.unbinds.push(() => {
    linksSoon.cancel()
    yNotes.unobserveDeep(onBoard)
    yPages.unobserveDeep(onBoard)
  })
  card.unbinds.push(keepCaretInView(bodyHost))
  optBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    togglePopover(card)
  })
  el.addEventListener('focusin', () => awareness.setLocalStateField('focus', id))
  el.addEventListener('focusout', (e) => {
    if (el.contains(e.relatedTarget)) return
    if (awareness.getLocalState()?.focus === id) awareness.setLocalStateField('focus', null)
  })
  back.addEventListener('pointerdown', (e) => {
    if (e.target === back) closeFullscreen()
  })

  const obs = (e) => {
    if (!e.keysChanged) return
    if (e.keysChanged.has('deleted') && note.get('deleted')) {
      closeFullscreen()
      ui.toast('That note was deleted.')
      return
    }
    if (e.keysChanged.has('archived') && note.get('archived')) {
      closeFullscreen()
      return
    }
    if (e.keysChanged.has('tabId') && note.get('tabId') !== activeTabId && !opts.anyTab) {
      closeFullscreen()
      const t = tabsList().find((x) => x.id === note.get('tabId'))
      ui.toast('Moved to ' + (t ? t.name : 'another tab'), { action: 'Open', onAction: () => goToNote(id) })
      return
    }
    if (e.keysChanged.has('kind') || e.keysChanged.has('layout')) {
      mountBody(card)
      bodyHost.appendChild(linksHost)
    }
    if (e.keysChanged.has('lastEditedAt')) card.setMeta()
    applyFullStyle(card)
    if (card.pop) refreshPopover(card)
  }
  note.observe(obs)
  const gone = (e) => {
    if (e.keysChanged.has(id) && !yNotes.has(id)) closeFullscreen()
  }
  yNotes.observe(gone)
  card.unbinds.push(() => note.unobserve(obs), () => yNotes.unobserve(gone))

  full = { id, back, card, pushed: false }
  if (!opts.fromHash) {
    // one note large after another (a link, a search hit) takes over its Back step,
    // so closing it returns to the board instead of to the note before
    if (prev && prev.pushed && history.state && history.state.full === prev.id) {
      navReplace({ full: id }, '#note=' + id + '&full')
      full.pushed = true
    } else full.pushed = navPush({ full: id }, '#note=' + id + '&full')
  }
  else if (!navQuiet) navReplace({ full: id }, '#note=' + id + '&full')
  renderPresence()
  requestAnimationFrame(() => {
    el.style.transformOrigin = '0 0'
    ui.zoomFrom(el, sourceRect)?.finished.then(() => el.getAnimations().forEach(a => a.cancel())).catch(() => {})
    if (opts.focus === false) return
    if (!note.get('title').toString().trim()) titleEl.focus()
    else if (card.body && card.body.rich && !phoneMode() && !opts.line) card.body.rich.focusEnd()
    if (opts.line) setTimeout(() => revealInCard(card, opts.line, { caret: !phoneMode() }), 60)
  })
  return true
}

function applyFullStyle(card) {
  const note = card.note
  const el = card.el
  const color = renderedPaper(note.get('color') || PAPER[0])
  el.style.background = color
  el.style.setProperty('--note-ink', inkFor(color))
  el.style.setProperty('--note-ink-dim', inkDimFor(color))
  el.style.setProperty('--note-line', hairlineFor(color))
  el.style.setProperty('--note-link', inkFor(color) === '#ffffff' ? '#ffd60a' : '#694b00')
  el.style.setProperty('--note-fs', Math.max(15, (note.get('fontSize') || FS_DEFAULT) + 3) + 'px')
  const ts = note.get('titleSize')
  if (ts) el.style.setProperty('--title-fs', ts + 6 + 'px')
  else el.style.removeProperty('--title-fs')
  el.classList.toggle('book', note.get('layout') === 'book')
  card.titleEl.style.textAlign = note.get('titleAlign') || ''
}

function closeFullscreenNow() {
  if (!full) return
  const f = full
  full = null
  const card = f.card
  if (card.pop) { card.closePop?.(); card.pop.remove() }
  if (card.body) card.body.destroy()
  card.unbinds.forEach((fn) => fn())
  const target = cards.get(f.id)?.el
  const anim = target?.isConnected ? ui.zoomFrom(card.el, target.getBoundingClientRect(), { reverse:true }) : null
  if (anim) {
    f.back.style.pointerEvents = 'none'
    const done = () => f.back.remove()
    anim.finished.then(done, done)
  } else f.back.remove()
  document.body.classList.remove('has-full')
  if (awareness.getLocalState()?.focus === f.id) awareness.setLocalStateField('focus', null)
  if (phoneMode()) phoneRefresh()
}

// Leave full screen without a Back step, just before going somewhere else
// (history.back() now would be cancelled by the next pushState).
function dropFullscreen() {
  if (!full) return
  closeFullscreenNow()
  navReplace({})
}

function closeFullscreen() {
  if (!full) return
  const f = full
  if (f.pushed && history.state && history.state.full === f.id) {
    ignoreHash = true
    history.back() // popstate closes it
    setTimeout(() => {
      ignoreHash = false
      if (full !== f) return
      // Back went nowhere (a browser may skip entries made without a click): close anyway
      closeFullscreenNow()
      if (history.state && history.state.full === f.id) navReplace({})
    }, 400)
    return
  }
  closeFullscreenNow()
  navReplace({})
}

let ignoreHash = false
// capture on window: runs before the handlers that close menus/popovers, so one
// Escape closes the innermost thing only
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' || !full) return
    if (document.querySelector('.card-pop.open, .menu, .rb-picker, .lightbox, .dlg-back, .mm-input, .edge-pop, .qs-back') || !overlay.hidden) return
    e.preventDefault()
    closeFullscreen()
  },
  true
)

// ---- phone: Google Keep style -----------------------------------------------
// Below 560px the board is a grid of read-only previews, pinned notes first.
// Tap a note to edit it full screen; long-press to select (colour, pin,
// archive, delete, move); swipe one sideways to archive it. Tabs live in a
// drawer and new notes come from the round + button. The phone never moves or
// resizes notes, so a phone session leaves the desktop corkboard as it was.
const phoneBar = document.getElementById('phone-bar')
const drawer = document.getElementById('drawer')
const fab = document.getElementById('fab')
const phoneTitle = document.getElementById('phone-title')
const selBar = document.getElementById('sel-bar')
const picked = new Set()

function phoneRefresh() {
  const on = phoneMode()
  document.body.classList.toggle('phone', on)
  board.classList.toggle('phone-grid', on)
  board.classList.toggle('one-col', on && Number(getSettings().phoneCols) === 1)
  const t = activeTab()
  phoneTitle.textContent = t ? t.name : 'notes'
  fab.hidden = !on || (!!t && !isNotesTab(t) && t.kind !== 'tasks' && t.kind !== 'mindmap')
  phoneBar.hidden = !on
  if (!on && picked.size) picked.clear()
  for (const id of Array.from(picked)) if (!cards.has(id)) picked.delete(id)
  for (const [id, c] of cards) c.el.classList.toggle('picked', picked.has(id))
  renderSelBar()
  if (!drawer.hidden) renderDrawer()
}

function attachPhoneGestures(card) {
  const el = card.el
  let start = null
  let timer = null
  let longFired = false
  let swiping = false
  const SKIP = '.rb-check, .rb-fold, .rb-more, .rb-play, .rb-insta, .rb-frame, a.rb-link, .rb-embed img, .card-pop'
  el.addEventListener('pointerdown', (e) => {
    if (!phoneMode() || (e.button != null && e.button > 0)) return
    if (e.target.closest(SKIP)) return
    start = { x: e.clientX, y: e.clientY, id: e.pointerId }
    longFired = false
    swiping = false
    timer = setTimeout(() => {
      longFired = true
      if (navigator.vibrate) navigator.vibrate(12)
      togglePicked(card.id, true)
    }, 480)
  })
  el.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(timer)
    if (!swiping && !picked.size && !longFired && Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiping = true
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      el.classList.add('swiping')
    }
    if (swiping) {
      el.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`
      el.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / (el.offsetWidth * 1.2)))
    }
  })
  const end = (e) => {
    if (!start || (e && e.pointerId !== start.id)) return
    clearTimeout(timer)
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    const wasSwipe = swiping
    start = null
    swiping = false
    el.classList.remove('swiping')
    if (wasSwipe) {
      if (e.type === 'pointerup' && Math.abs(dx) > el.offsetWidth * 0.33) {
        el.style.transition = 'transform .16s ease-out, opacity .16s'
        el.style.transform = `translateX(${dx > 0 ? 120 : -120}%)`
        el.style.opacity = '0'
        setTimeout(() => setNoteArchived(card.id, true), 160)
      } else {
        el.style.transform = ''
        el.style.opacity = ''
      }
      return
    }
    if (longFired || e.type !== 'pointerup') return
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) return
    if (picked.size) togglePicked(card.id)
    else openFullscreen(card.id)
  }
  el.addEventListener('pointerup', end)
  el.addEventListener('pointercancel', end)
  el.addEventListener('contextmenu', (e) => {
    if (phoneMode()) e.preventDefault()
  })
}

function togglePicked(id, on) {
  const v = on != null ? on : !picked.has(id)
  if (v) picked.add(id)
  else picked.delete(id)
  phoneRefresh()
}
function clearPicked() {
  picked.clear()
  phoneRefresh()
}

function swatchSheet(anchor, colors, onPick) {
  closeMenus()
  const m = document.createElement('div')
  m.className = 'menu swatch-menu'
  m.addEventListener('click', (e) => e.stopPropagation())
  for (const c of colors) {
    const b = document.createElement('button')
    b.className = 'pop-swatch'
    b.style.background = c
    b.title = c

    b.setAttribute('aria-label', b.title)
    b.addEventListener('click', () => {
      closeMenus()
      onPick(c)
    })
    m.appendChild(b)
  }
  document.body.appendChild(m)
  const r = anchor.getBoundingClientRect()
  m.style.left = Math.max(6, Math.min(r.left, window.innerWidth - m.offsetWidth - 6)) + 'px'
  m.style.top = r.bottom + 6 + 'px'
  const dismiss = ui.popover(m, anchor, { label: 'Note colour' })
  openMenus.push({ remove: dismiss })
}

function renderSelBar() {
  const n = picked.size
  document.body.classList.toggle('selecting', n > 0)
  selBar.hidden = n === 0
  if (!n) return
  selBar.replaceChildren()
  const ids = Array.from(picked)
  const notes = ids.map((id) => yNotes.get(id)).filter(Boolean)
  const b = (html, title, fn, cls) => {
    const x = document.createElement('button')
    x.className = 'sel-btn' + (cls ? ' ' + cls : '')
    if (html.startsWith('<svg')) x.innerHTML = html
    else iconLabel(x, html)
    x.title = title

    x.setAttribute('aria-label', x.title)
    x.setAttribute('aria-label', title)
    x.addEventListener('click', (e) => {
      e.stopPropagation()
      fn(x)
    })
    selBar.appendChild(x)
    return x
  }
  b('✕', 'Done', clearPicked, 'sel-x')
  const count = document.createElement('span')
  count.className = 'sel-count'
  count.textContent = n + ' selected'
  selBar.appendChild(count)
  const allPinned = notes.every((nn) => nn.get('pinned'))
  b('🎨', 'Colour', (x) =>
    swatchSheet(x, PAPER.concat(getFavorites()), (c) => doc.transact(() => notes.forEach((nn) => nn.set('color', c))))
  )
  b(allPinned ? '📍' : '📌', allPinned ? 'Unpin' : 'Pin to the top', () => {
    doc.transact(() => notes.forEach((nn) => (allPinned ? nn.delete('pinned') : nn.set('pinned', true))))
    clearPicked()
  })
  b('🗄', 'Archive', () => {
    doc.transact(() => notes.forEach((nn) => nn.set('archived', true)))
    clearPicked()
    ui.toast(ids.length + ' archived', {
      action: 'Undo',
      onAction: () => doc.transact(() => ids.forEach((id) => yNotes.get(id) && yNotes.get(id).delete('archived'))),
    })
  })
  b('🗑', 'Delete', () => {
    const now = Date.now()
    doc.transact(() => notes.forEach((nn) => nn.set('deleted', now)))
    clearPicked()
    ui.toast(ids.length + ' moved to trash', {
      action: 'Undo',
      ms: 7000,
      onAction: () => ids.forEach((id) => restoreNote(id)),
    })
  })
  b('⇄', 'Move to tab', (x) =>
    ui.menu(
      x,
      tabsList()
        .filter((t) => isNotesTab(t) && !t.archived && t.id !== activeTabId)
        .map((t) => ({
          label: t.name,
          onClick: () => {
            doc.transact(() => notes.forEach((nn) => nn.set('tabId', t.id)))
            clearPicked()
            ui.toast('Moved to ' + t.name, { action: 'Open', onAction: () => setActiveTab(t.id) })
          },
        })),
      { align: 'right' }
    )
  )
}

function renderDrawer() {
  const panel = drawer.querySelector('.drawer-panel')
  panel.replaceChildren()
  const head = document.createElement('div')
  head.className = 'drawer-head'
  head.innerHTML = '<span class="brand-dot"></span><span class="brand-name">Notes</span>'
  panel.appendChild(head)
  const counts = new Map()
  yNotes.forEach((n) => {
    if (isHidden(n)) return
    const t = n.get('tabId')
    counts.set(t, (counts.get(t) || 0) + 1)
  })
  const row = (icon, label, sub, fn, cls) => {
    const b = document.createElement('button')
    b.className = 'drawer-item' + (cls ? ' ' + cls : '')
    let i = document.createElement('span')
    i.className = 'drawer-icon'
    if (typeof icon === 'object') i = tabGlyph(icon, 'drawer-icon')
    else i.appendChild(makeIcon(icon))
    const l = document.createElement('span')
    l.className = 'drawer-label'
    l.textContent = label
    b.append(i, l)
    if (sub != null) {
      const c = document.createElement('span')
      c.className = 'drawer-count'
      c.textContent = sub
      b.appendChild(c)
    }
    b.addEventListener('click', () => fn(b))
    panel.appendChild(b)
    return b
  }
  const sec = (t) => {
    const h = document.createElement('div')
    h.className = 'drawer-h'
    h.textContent = t
    panel.appendChild(h)
  }
  sec('Tabs')
  for (const t of tabsList().filter((x) => !x.archived)) {
    row(t, t.name, isNotesTab(t) ? String(counts.get(t.id) || 0) : '', () => {
      closeDrawer()
      setActiveTab(t.id)
    }, t.id === activeTabId ? 'on' : '')
  }
  row('+', 'New NotePad', null, () => {
    closeDrawer()
    addTab('notes')
  }, 'drawer-add')
  row('+', 'New to-do list', null, () => {
    closeDrawer()
    addTab('tasks')
  }, 'drawer-add')
  row('+', 'New document', null, () => {
    closeDrawer()
    addTab('doc')
  }, 'drawer-add')
  row('+', 'New mind map', null, () => {
    closeDrawer()
    addTab('mindmap')
  }, 'drawer-add')
  row('+', 'New Sketch Pad', null, () => {
    closeDrawer()
    addTab('draw')
  }, 'drawer-add')
  sec('More')
  row('calendar', 'Today’s journal', null, () => {
    closeDrawer()
    openToday()
  })
  row('search', 'Go to a note…', null, () => {
    closeDrawer()
    openQuickSwitcher()
  })
  row('note', 'New from template…', null, () => {
    closeDrawer()
    chooseTemplate((tpl) => newFromTemplate(tpl))
  })
  row('⌂', 'Home, search & archived tabs', null, () => {
    closeDrawer()
    openHome()
  })
  const hidden = activeTab() ? hiddenCounts(activeTab().id) : { trash: 0, archived: 0 }
  row('🗄', 'Archived & trash in this tab', hidden.trash + hidden.archived ? String(hidden.trash + hidden.archived) : '', () => {
    closeDrawer()
    if (activeTab()) openHiddenPanel(activeTab().id)
  })
  const cols = Number(getSettings().phoneCols) === 1 ? 1 : 2
  row(cols === 1 ? '▦' : '▤', cols === 1 ? 'Show two columns' : 'Show one column', null, () => {
    setSetting('phoneCols', cols === 1 ? 2 : 1)
    phoneRefresh()
  })
  row('⚙', 'Settings & backup', null, () => {
    closeDrawer()
    openSettingsMenu(document.getElementById('settings'))
  })
}
function openDrawer() {
  renderDrawer()
  drawer.hidden = false
  requestAnimationFrame(() => drawer.classList.add('open'))
}
function closeDrawer() {
  drawer.classList.remove('open')
  setTimeout(() => {
    if (!drawer.classList.contains('open')) drawer.hidden = true
  }, 180)
}
drawer.addEventListener('click', (e) => {
  if (e.target === drawer) closeDrawer()
})

function newPhoneNote(kind) {
  const id = createNote(PAPER[Math.floor(Math.random() * 4)])
  if (kind === 'todo') {
    const n = yNotes.get(id)
    doc.transact(() => replaceAllLines(n.get('body'), [{ text: '', attrs: { lt: 'todo' } }]))
  }
  setTimeout(() => openFullscreen(id), 30)
}
;(() => {
  let t = null
  let long = false
  fab.addEventListener('pointerdown', () => {
    long = false
    t = setTimeout(() => {
      long = true
      if (navigator.vibrate) navigator.vibrate(12)
      ui.menu(
        fab,
        [
          { icon: '✎', label: 'New note', onClick: () => newPhoneNote('note') },
          { icon: '☑', label: 'New checklist', onClick: () => newPhoneNote('todo') },
          'sep',
          { icon: '☰', label: 'New NotePad tab', onClick: () => addTab('notes') },
          { icon: 'todo', label: 'New to-do tab', onClick: () => addTab('tasks') },
          { icon: 'text', label: 'New document tab', onClick: () => addTab('doc') },
          { icon: 'map', label: 'New mind map tab', onClick: () => addTab('mindmap') },
          { icon: '✎', label: 'New Sketch Pad tab', onClick: () => addTab('draw') },
        ],
        { align: 'right' }
      )
    }, 450)
  })
  const cancel = () => clearTimeout(t)
  fab.addEventListener('pointerup', cancel)
  fab.addEventListener('pointercancel', cancel)
  fab.addEventListener('pointerleave', cancel)
  fab.addEventListener('contextmenu', (e) => e.preventDefault())
  fab.addEventListener('click', (e) => {
    e.stopPropagation()
    if (long) return
    if (pageState?.list) pageState.list.addTask() // a To-do tab: + adds a task
    else if (pageState?.map) pageState.map.addChild() // a mind map: + adds an idea
    else newPhoneNote('note')
  })
})()

phoneBar.addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (!b) return
  e.stopPropagation()
  const act = b.dataset.act
  if (act === 'tabs') openDrawer()
  else if (act === 'home') toggleHome()
  else if (act === 'settings') {
    if (phonePage() === 'settings') closeMenus()
    else openSettingsMenu(b)
  }
})
phoneTitle.addEventListener('click', (e) => {
  e.stopPropagation()
  openDrawer()
})
search.addEventListener('blur', () => {
  if (!search.value.trim()) document.body.classList.remove('searching')
})

// keep the full-screen editor and its toolbar above the on-screen keyboard
if (window.visualViewport) {
  const vv = window.visualViewport
  const upd = () => {
    const root = document.documentElement.style
    root.setProperty('--vvh', vv.height + 'px')
    root.setProperty('--vvtop', vv.offsetTop + 'px')
  }
  vv.addEventListener('resize', upd)
  vv.addEventListener('scroll', upd)
  upd()
}

// ---- overlays: home page, hidden notes (trash / archived), history ----------
const overlay = document.getElementById('overlay')
let overlayKind = null // 'home' | 'hidden' | 'history'
let releasePanelFocus = null

function closeOverlay() {
  overlay.hidden = true
  overlay.replaceChildren()
  overlayKind = null
  releasePanelFocus?.()
  releasePanelFocus = null
}
function closeHome() {
  if (overlayKind === 'home') closeOverlay()
}
function openPanel(kind, title, build) {
  releasePanelFocus?.()
  closeMenus()
  closeAllPopovers()
  overlay.replaceChildren()
  overlayKind = kind
  const panel = document.createElement('div')
  panel.className = 'panel panel-' + kind
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', title)
  const head = document.createElement('div')
  head.className = 'panel-head'
  const h = document.createElement('div')
  h.className = 'panel-title'
  h.textContent = title
  const x = document.createElement('button')
  x.className = 'panel-x'
  iconLabel(x, '×')
  x.title = 'Close (Esc)'

  x.setAttribute('aria-label', x.title)
  x.addEventListener('click', closeOverlay)
  head.append(h, x)
  const body = document.createElement('div')
  body.className = 'panel-body'
  panel.append(head, body)
  overlay.appendChild(panel)
  overlay.hidden = false
  build(body, panel)
  body.addEventListener('scroll', () => panel.classList.toggle('scrolled', body.scrollTop > 24), { passive:true })
  releasePanelFocus = ui.trapFocus(panel)
  requestAnimationFrame(() => panel.querySelector('input, button')?.focus({ preventScroll:true }))
  return body
}
overlay.addEventListener('pointerdown', (e) => {
  if (e.target === overlay) closeOverlay()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !overlay.hidden) closeOverlay()
})

function toggleHome() {
  if (overlayKind === 'home') closeOverlay()
  else openHome()
}

// Phone pages form one strip: Home, then every tab in order, then Settings.
// Swipe left for the next tab (Settings after the last), swipe right for the
// previous one (Home before the first). Home and Settings swipe back to the tab
// you were on. A swipe that starts on a note still archives it (see
// attachPhoneGestures), so page swipes come from the title, the bottom bar, the
// gaps between notes, the open page itself, or the edges of the screen.
function phonePage() {
  if (overlayKind === 'home') return 'home'
  if (document.querySelector('.settings-menu')) return 'settings'
  return 'tabs'
}
function syncPhoneBar() {
  const page = phonePage()
  for (const b of phoneBar.querySelectorAll('button')) b.classList.toggle('on', b.dataset.act === page)
}
new MutationObserver(syncPhoneBar).observe(document.body, { childList: true })
new MutationObserver(syncPhoneBar).observe(overlay, { attributes: true, attributeFilter: ['hidden'] })
let pageSwipe = null
let swallowClickUntil = 0
document.addEventListener('click', (e) => {
  if (Date.now() < swallowClickUntil) { e.stopPropagation(); e.preventDefault() }
}, true)
document.addEventListener('touchstart', (e) => {
  pageSwipe = null
  if (!phoneMode() || e.touches.length !== 1 || full || !drawer.hidden) return
  const t = e.touches[0]
  const el = e.target instanceof Element ? e.target : null
  if (!el) return
  if (el.closest('input, textarea, select, [contenteditable="true"], .drawer, .full-back, .dlg-back, .draw-view, .page-view, .mm-wrap, .sel-bar, .lightbox')) return
  const edge = t.clientX < 28 || t.clientX > window.innerWidth - 28
  if (!edge && el.closest('.card')) return // swiping a note archives it
  pageSwipe = { x: t.clientX, y: t.clientY, at: Date.now(), page: phonePage() }
}, { passive: true, capture: true })
document.addEventListener('touchend', (e) => {
  const s = pageSwipe
  pageSwipe = null
  if (!s || !e.changedTouches.length) return
  const t = e.changedTouches[0]
  const dx = t.clientX - s.x
  const dy = t.clientY - s.y
  if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 2 || Date.now() - s.at > 700) return
  const right = dx > 0
  swallowClickUntil = Date.now() + 400 // a browser may still synthesise a click after the swipe
  if (s.page === 'tabs') {
    const list = tabsList().filter((t) => !t.archived)
    const cur = activeTab()
    const i = cur ? list.findIndex((t) => t.id === cur.id) : -1
    if (right) {
      if (i > 0) setActiveTab(list[i - 1].id)
      else openHome()
    } else if (i >= 0 && i < list.length - 1) setActiveTab(list[i + 1].id)
    else openSettingsMenu(phoneBar.querySelector('[data-act="settings"]'))
  } else if (s.page === 'home' && !right) closeOverlay()
  else if (s.page === 'settings' && right) closeMenus()
}, { passive: true, capture: true })

function noteSnippet(n, max = 90) {
  return snippetOf(n, max)
}

// Home: every tab as a card (with who is on it), archived tabs below, and a
// search box that looks across every tab.
function openHome(query = '') {
  openPanel('home', 'All tabs', (body) => {
    const search = document.createElement('input')
    search.className = 'home-search'
    search.type = 'search'
    search.placeholder = 'Search every tab…  (try tag:, tab:, is:todo, by:)'
    search.autocomplete = 'off'
    search.setAttribute('aria-label', 'Search every tab')
    const quick = document.createElement('div')
    quick.className = 'home-quick'
    const qBtn = (label, ico, title, fn) => {
      const b = document.createElement('button')
      b.className = 'pop-btn'
      b.type = 'button'
      iconLabel(b, label, ico)
      b.title = title
      b.addEventListener('click', fn)
      quick.appendChild(b)
    }
    qBtn('Today', 'calendar', 'Open (or start) today’s journal note', () => openToday())
    qBtn('Go to…', 'search', 'Quick switcher (Ctrl/Cmd+K)', () => {
      closeOverlay()
      openQuickSwitcher()
    })
    qBtn('From template…', 'note', 'A new note from a template', () => chooseTemplate((tpl) => newFromTemplate(tpl)))
    const results = document.createElement('div')
    results.className = 'home-results'
    const grid = document.createElement('div')
    grid.className = 'home-grid'
    const tagWrap = document.createElement('div')
    tagWrap.className = 'home-tags'
    const archWrap = document.createElement('div')
    archWrap.className = 'home-archived'
    body.append(search, quick, results, grid, tagWrap, archWrap)

    const renderTags = () => {
      tagWrap.replaceChildren()
      const tags = tagCounts(doc)
      if (!tags.length) return
      const h = document.createElement('div')
      h.className = 'home-h'
      h.textContent = 'Tags'
      const cloud = document.createElement('div')
      cloud.className = 'tag-cloud'
      for (const t of tags) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'tag-chip' + (t.name.includes('/') ? ' sub' : '')
        b.textContent = '#' + t.name
        const c = document.createElement('span')
        c.className = 'tag-count'
        c.textContent = t.count
        b.appendChild(c)
        b.title = 'Notes tagged #' + t.name + ' (right-click to rename)'
        b.addEventListener('click', () => {
          search.value = 'tag:' + t.name
          doSearch()
        })
        b.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          ui.menu(b, [{ label: 'Rename or merge #' + t.name + '…', icon: 'pencil', onClick: () => renameTagFlow(t.name) }])
        })
        cloud.appendChild(b)
      }
      tagWrap.append(h, cloud)
    }

    const render = () => {
      grid.replaceChildren()
      archWrap.replaceChildren()
      renderTags()
      const counts = new Map()
      const edited = new Map()
      yNotes.forEach((n) => {
        if (isHidden(n)) return
        const t = n.get('tabId')
        counts.set(t, (counts.get(t) || 0) + 1)
        const at = n.get('lastEditedAt') || n.get('created') || 0
        if (at > (edited.get(t) || 0)) edited.set(t, at)
      })
      const here = new Map()
      for (const [cid, st] of awareness.getStates()) {
        if (cid === doc.clientID || !st || !st.user || !st.tab) continue
        if (!here.has(st.tab)) here.set(st.tab, [])
        here.get(st.tab).push(st.user)
      }
      const list = tabsList()
      const live = list.filter((t) => !t.archived)
      const arch = list.filter((t) => t.archived)
      for (const t of live) grid.appendChild(tabCard(t, counts.get(t.id) || 0, edited.get(t.id), here.get(t.id) || []))
      if (arch.length) {
        const h = document.createElement('div')
        h.className = 'home-h'
        h.textContent = 'Archived'
        archWrap.appendChild(h)
        const g = document.createElement('div')
        g.className = 'home-grid'
        for (const t of arch) g.appendChild(tabCard(t, counts.get(t.id) || 0, edited.get(t.id), []))
        archWrap.appendChild(g)
      }
    }

    const tabCard = (t, count, at, people) => {
      const c = document.createElement('button')
      c.className = 'home-tab' + (t.archived ? ' archived' : '') + (t.id === activeTabId ? ' on' : '')
      const top = document.createElement('div')
      top.className = 'home-tab-top'
      const name = document.createElement('span')
      name.className = 'home-tab-name'
      iconLabel(name, t.name, isNotesTab(t) ? 'folder' : kindInfo(t.kind).icon)
      if (t.icon || t.color) name.firstChild.replaceWith(tabGlyph(t.icon ? t : { ...t, icon: isNotesTab(t) ? 'i:folder' : null }, 'icon'))
      top.appendChild(name)
      if (people.length) {
        const pp = document.createElement('span')
        pp.className = 'home-people'
        people.slice(0, 4).forEach((u) => {
          const d = document.createElement('span')
          d.className = 'editor-dot'
          d.style.setProperty('--c', u.color || 'var(--label-2)')
          d.title = u.name + ' is here'

          d.setAttribute('aria-label', d.title)
          d.textContent = initials(u.name || '?')
          pp.appendChild(d)
        })
        top.appendChild(pp)
      }
      const sub = document.createElement('div')
      sub.className = 'home-tab-sub'
      sub.textContent =
        !isNotesTab(t) ? kindInfo(t.kind).sub : count + (count === 1 ? ' note' : ' notes') + (at ? ' · edited ' + relTime(at) : '')
      c.append(top, sub)
      if (backup.isExcluded(t.id)) {
        const nb = document.createElement('div')
        nb.className = 'home-tab-flag'
        nb.textContent = 'Not in this device’s backups'
        c.appendChild(nb)
      }
      if (t.archived) {
        const un = document.createElement('span')
        un.className = 'home-unarchive'
        un.textContent = 'Unarchive'
        un.addEventListener('click', (e) => {
          e.stopPropagation()
          setTabArchived(t.id, false)
          render()
        })
        c.appendChild(un)
      }
      c.addEventListener('click', () => setActiveTab(t.id))
      return c
    }

    const doSearch = () => {
      const q = search.value.trim()
      results.replaceChildren()
      grid.style.display = q ? 'none' : ''
      tagWrap.style.display = q ? 'none' : ''
      archWrap.style.display = q ? 'none' : ''
      if (!q) return
      const tabsById = new Map(tabsList().map((t) => [t.id, t]))
      const terms = parseQuery(q)
      const hits = []
      yOrder.toArray().forEach((id) => {
        const n = yNotes.get(id)
        if (!n || n.get('deleted')) return
        if (matchFacts(terms, noteFacts(n, tabsById.get(n.get('tabId'))?.name || ''))) hits.push({ id, n })
      })
      if (tagOnly(terms)) {
        const h = document.createElement('div')
        h.className = 'home-h'
        h.textContent = terms.map((t) => '#' + t.value).join(' ') + ' · ' + hits.length + (hits.length === 1 ? ' note' : ' notes')
        const ren = document.createElement('button')
        ren.className = 'home-h-act'
        ren.type = 'button'
        ren.textContent = 'Rename tag'
        ren.addEventListener('click', () => renameTagFlow(terms[0].value))
        if (terms.length === 1) h.appendChild(ren)
        results.appendChild(h)
      }
      if (!hits.length) {
        const e = document.createElement('div')
        e.className = 'home-empty'
        e.textContent = 'Nothing matches.'
        results.appendChild(e)
        return
      }
      for (const { id, n } of hits.slice(0, 60)) {
        const row = document.createElement('button')
        row.className = 'home-hit'
        const t = tabsById.get(n.get('tabId'))
        const title = document.createElement('div')
        title.className = 'home-hit-title'
        title.textContent = n.get('title').toString().trim() || 'Untitled'
        const meta = document.createElement('div')
        meta.className = 'home-hit-meta'
        meta.textContent = (t ? t.name : '?') + (n.get('archived') ? ' · archived' : '')
        const snip = document.createElement('div')
        snip.className = 'home-hit-snip'
        snip.textContent = noteSnippet(n)
        row.append(title, meta, snip)
        row.addEventListener('click', () => goToNote(id, { push: true }))
        results.appendChild(row)
      }
    }
    search.addEventListener('input', doSearch)
    render()
    if (query) {
      search.value = query
      doSearch()
    }
    requestAnimationFrame(() => search.focus())
    // keep it live while open
    const refresh = () => {
      if (overlayKind !== 'home') return
      if (!search.value.trim()) render()
      else doSearch()
    }
    const stop1 = () => awareness.off('change', refresh)
    awareness.on('change', refresh)
    yTabs.observeDeep(refresh)
    const obs = new MutationObserver(() => {
      if (overlay.hidden || overlayKind !== 'home') {
        stop1()
        yTabs.unobserveDeep(refresh)
        obs.disconnect()
      }
    })
    obs.observe(overlay, { attributes: true, childList: true })
  })
}

const tagOnly = (terms) => terms.length > 0 && terms.every((t) => t.op === 'tag' && !t.neg)

// Rename #from everywhere (onto an existing tag: merge them).
async function renameTagFlow(from) {
  const typed = await ui.prompt('Rename #' + from + ' to:', from, { title: 'Rename tag', okLabel: 'Rename', maxLength: 60 })
  if (typed == null) return
  const to = typed.trim().replace(/^#/, '')
  if (!to || to === from) return
  if (!/^[\p{L}\p{N}_-]+(\/[\p{L}\p{N}_-]+)*$/u.test(to) || /^[\d/]+$/.test(to)) return ui.toast('A tag is letters, numbers, - and _, with / between levels.')
  const n = renameTag(doc, from, to)
  ui.toast(n ? `Renamed #${from} to #${to} in ${n} place${n === 1 ? '' : 's'}` : 'No notes use #' + from)
  if (overlayKind === 'home') openHome('tag:' + to)
}

// Trash + archived notes for one tab.
function openHiddenPanel(tabId) {
  const t = tabsList().find((x) => x.id === tabId)
  openPanel('hidden', 'Hidden notes · ' + (t ? t.name : ''), (body) => {
    const render = () => {
      body.replaceChildren()
      const archived = []
      const trash = []
      yOrder.toArray().forEach((id) => {
        const n = yNotes.get(id)
        if (!n || n.get('tabId') !== tabId) return
        if (n.get('deleted')) trash.push({ id, n })
        else if (n.get('archived')) archived.push({ id, n })
      })
      const sectionEl = (title, hint, items, actions) => {
        const h = document.createElement('div')
        h.className = 'home-h'
        h.textContent = title
        body.appendChild(h)
        if (hint) {
          const p = document.createElement('div')
          p.className = 'panel-hint'
          p.textContent = hint
          body.appendChild(p)
        }
        if (!items.length) {
          const e = document.createElement('div')
          e.className = 'home-empty'
          e.textContent = 'Nothing here.'
          body.appendChild(e)
          return
        }
        for (const { id, n } of items) {
          const row = document.createElement('div')
          row.className = 'hidden-row'
          const txt = document.createElement('div')
          txt.className = 'hidden-txt'
          const title = document.createElement('div')
          title.className = 'home-hit-title'
          title.textContent = n.get('title').toString().trim() || 'Untitled'
          const snip = document.createElement('div')
          snip.className = 'home-hit-snip'
          snip.textContent = noteSnippet(n)
          txt.append(title, snip)
          row.appendChild(txt)
          const btns = document.createElement('div')
          btns.className = 'hidden-btns'
          for (const [label, fn, danger] of actions) {
            const b = document.createElement('button')
            b.className = 'pop-btn' + (danger ? ' danger' : '')
            iconLabel(b, label)
            b.addEventListener('click', () => fn(id, n))
            btns.appendChild(b)
          }
          row.appendChild(btns)
          body.appendChild(row)
        }
      }
      sectionEl('Archived', 'Out of the way, but kept.', archived, [
        ['Unarchive', (id) => setNoteArchived(id, false)],
        ['Delete', (id) => deleteNote(id)],
      ])
      sectionEl('Trash', 'Deleted notes stay here for 30 days, then the Pi removes them.', trash, [
        ['Restore', (id) => restoreNote(id)],
        [
          'Delete forever',
          async (id, n) => {
            const ok = await ui.confirm('Delete this note for everyone, permanently?', {
              title: n.get('title').toString().trim() || 'Untitled',
              okLabel: 'Delete forever',
              danger: true,
            })
            if (ok) hardDeleteNote(id)
          },
          true,
        ],
      ])
    }
    render()
    const refresh = () => {
      if (overlayKind === 'hidden') render()
      else yNotes.unobserveDeep(refresh)
    }
    yNotes.observeDeep(refresh)
  })
}

// Earlier versions of a note, read from the Pi's git history of the Markdown
// mirror. Restore writes the old text back as a normal edit.
function openHistoryPanel(noteId) {
  const n = yNotes.get(noteId)
  if (!n) return
  openPanel('history', 'History · ' + (n.get('title').toString().trim() || 'Untitled'), async (body) => {
    const status = document.createElement('div')
    status.className = 'panel-hint'
    status.textContent = 'Loading…'
    body.appendChild(status)
    let data = null
    try {
      const r = await fetch('/api/history/' + encodeURIComponent(noteId))
      data = await r.json()
    } catch {
      data = null
    }
    if (!data || data.available === false) {
      status.textContent = data
        ? 'History is not available on this server (git is not set up on the Pi).'
        : 'Could not reach the server. History needs the Pi.'
      return
    }
    const versions = data.versions || []
    if (!versions.length) {
      status.textContent = 'No saved versions yet. The Pi snapshots the board about once a minute after edits.'
      return
    }
    status.textContent = versions.length + ' version' + (versions.length === 1 ? '' : 's') + '. Pick one to preview.'
    const wrap = document.createElement('div')
    wrap.className = 'hist-wrap'
    const list = document.createElement('div')
    list.className = 'hist-list'
    const view = document.createElement('div')
    view.className = 'hist-view'
    view.textContent = 'Select a version on the left.'
    wrap.append(list, view)
    body.appendChild(wrap)
    for (const v of versions) {
      const b = document.createElement('button')
      b.className = 'hist-item'
      const when = new Date(v.ts)
      b.textContent = when.toLocaleString()
      b.title = v.commit

      b.setAttribute('aria-label', b.title)
      b.addEventListener('click', async () => {
        list.querySelectorAll('.hist-item').forEach((x) => x.classList.toggle('on', x === b))
        view.textContent = 'Loading…'
        let ver = null
        try {
          const r = await fetch('/api/history/' + encodeURIComponent(noteId) + '/' + encodeURIComponent(v.commit))
          ver = r.ok ? await r.json() : null
        } catch {
          ver = null
        }
        if (!ver) {
          view.textContent = 'Could not load that version.'
          return
        }
        view.replaceChildren()
        const t = document.createElement('div')
        t.className = 'hist-title'
        t.textContent = ver.title || 'Untitled'
        const pre = document.createElement('pre')
        pre.className = 'hist-body'
        pre.textContent = (ver.body || '') + (ver.body2 ? '\n\n— right page —\n' + ver.body2 : '')
        const act = document.createElement('div')
        act.className = 'pop-row'
        const restore = document.createElement('button')
        restore.className = 'pop-btn primary'
        restore.textContent = 'Restore this version'
        restore.addEventListener('click', async () => {
          const ok = await ui.confirm('Replace the current text with this version? (You can undo by restoring a newer one.)', {
            okLabel: 'Restore',
          })
          if (ok) restoreVersion(noteId, ver)
        })
        act.appendChild(restore)
        view.append(t, pre, act)
      })
      list.appendChild(b)
    }
  })
}

function stripMd(text) {
  return String(text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/<\/?u>/g, '')
}

// Write an old version back as an ordinary edit (so it is itself undoable by
// restoring a newer one). Lists, checkboxes and headings come back from their
// Markdown form; bold/italic marks are dropped.
function restoreVersion(noteId, ver) {
  const n = yNotes.get(noteId)
  if (!n) return
  const was = n.get('title').toString()
  const title = stripMd(ver.title)
  doc.transact(() => {
    const t = n.get('title')
    if (t.length) t.delete(0, t.length)
    if (title) t.insert(0, title)
    if (n.get('kind') === 'todo') n.set('kind', 'note')
    replaceAllLines(n.get('body'), markdownToLines(ver.body || ''))
    if (ver.body2) {
      const b2 = n.get('body2') || ensureBody2(n)
      replaceAllLines(b2, markdownToLines(ver.body2))
      n.set('layout', 'book')
    }
    n.set('lastEditedAt', Date.now())
    n.set('lastEditedBy', { id: me.id, name: me.name })
  })
  followRename(doc, noteId, was, title) // links follow the old name back
  closeOverlay()
  ui.toast('Version restored')
}

// ---- presence rendering ----
function renderPresence() {
  const states = awareness.getStates()

  peopleEl.innerHTML = ''
  const seen = []
  for (const [cid, st] of states) {
    if (!st || !st.user) continue
    seen.push({ cid, user: st.user, self: cid === doc.clientID })
  }
  seen.sort((a, b) => (a.self ? -1 : 0) - (b.self ? -1 : 0))
  for (const p of seen) {
    const a = document.createElement('span')
    a.className = 'avatar'
    a.style.setProperty('--c', p.user.color || 'var(--label-2)')
    a.textContent = initials(p.user.name || '?')
    a.title = p.self ? p.user.name + ' (you)' : p.user.name

    a.setAttribute('aria-label', a.title)
    peopleEl.appendChild(a)
  }

  const byNote = new Map()
  for (const [cid, st] of states) {
    if (cid === doc.clientID || !st || !st.focus || !st.user) continue
    if (!byNote.has(st.focus)) byNote.set(st.focus, [])
    byNote.get(st.focus).push(st.user)
  }
  const all = Array.from(cards)
  if (full) all.push([full.id, full.card])
  for (const [id, card] of all) {
    const editors = byNote.get(id) || []
    card.el.classList.toggle('active', editors.length > 0)
    card.presenceEl.innerHTML = ''
    editors.slice(0, 4).forEach((u) => {
      const d = document.createElement('span')
      d.className = 'editor-dot'
      d.style.setProperty('--c', u.color || 'var(--label-2)')
      d.title = u.name + ' is editing'

      d.setAttribute('aria-label', d.title)
      d.textContent = initials(u.name || '?')
      card.presenceEl.appendChild(d)
    })
  }
}

awareness.on('change', renderPresence)

// ---- search filter (scoped to the visible tab) ----
function applyFilter() {
  const q = search.value.trim()
  const terms = q ? parseQuery(q) : []
  const tabName = activeTab()?.name || ''
  for (const [id, card] of cards) {
    if (!terms.length) {
      card.el.classList.remove('hidden')
      continue
    }
    const n = yNotes.get(id)
    if (!n) continue
    card.el.classList.toggle('hidden', !matchFacts(terms, noteFacts(n, tabName)))
  }
  if (canvasMode) viewport.refreshMap()
}
// while searching, folded lines are shown (so a match can't hide inside a fold)
let wasSearching = false
search.addEventListener('input', () => {
  applyFilter()
  const now = !!search.value.trim()
  if (now !== wasSearching) {
    wasSearching = now
    for (const [, c] of cards) if (c.body && c.body.editors) c.body.editors.forEach((r) => r.refresh())
  }
})

// ---- toolbar actions ----
addBtn.addEventListener('click', () => {
  const id = createNote(PAPER[Math.floor(Math.random() * 4)])
  requestAnimationFrame(() => cards.get(id)?.titleEl.focus())
})

document.getElementById('goto').addEventListener('click', () => openQuickSwitcher())
document.getElementById('today').addEventListener('click', () => openToday())
document.getElementById('rename').addEventListener('click', async () => {
  const typed = await ui.prompt('Display name:', me.name, { title: 'Your name', maxLength: 24 })
  if (typed == null) return
  const name = typed.trim().slice(0, 24)
  if (!name) return
  me = { ...me, name }
  saveMe()
  awareness.setLocalStateField('user', me)
  youName.textContent = me.name
})

// ---- settings (per device) ----
document.getElementById('settings').addEventListener('click', (e) => {
  e.stopPropagation()
  openSettingsMenu(e.currentTarget)
})

// ---- reminders (Web Push) on this device ----------------------------------------
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
const b64uBytes = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(b, (c) => c.charCodeAt(0))
}
async function pushSubscription(create) {
  // .ready never settles if the service worker could not be installed
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('the app’s service worker is not running; reload and try again')), 8000))])
  let sub = await reg.pushManager.getSubscription()
  if (!create) return sub
  const r = await fetch('/api/push/key')
  const { publicKey } = r.ok ? await r.json() : {}
  if (typeof publicKey !== 'string' || !publicKey) throw new Error('the Pi has reminders turned off')
  const key = b64uBytes(publicKey)
  // a subscription made for another key (the Pi's keys were reset) must go first
  if (sub && sub.options?.applicationServerKey && new Uint8Array(sub.options.applicationServerKey).join() !== key.join()) {
    await sub.unsubscribe().catch(() => {})
    sub = null
  }
  return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
}
async function saveReminders(on, hour) {
  try {
    if (on) {
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') {
        ui.toast('Notifications are blocked for this site. Allow them in the browser’s site settings, then try again.', { ms: 9000 })
        return false
      }
      const sub = await pushSubscription(true)
      const r = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, hour, name: me.name }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'the Pi said no')
      setSetting('reminders', true)
      setSetting('remindHour', hour)
      return true
    }
    const sub = await pushSubscription(false)
    if (sub) {
      await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {})
      await sub.unsubscribe().catch(() => {})
    }
    setSetting('reminders', false)
    return true
  } catch (err) {
    ui.toast('Reminders: ' + (err && err.message ? err.message : 'could not be changed'), { ms: 8000 })
    return false
  }
}
function drawReminderSettings(host) {
  host.replaceChildren()
  const st = getSettings()
  if (!pushSupported()) {
    host.textContent = /iPhone|iPad/.test(navigator.userAgent)
      ? 'On an iPhone, add Notes to the home screen first (Share → Add to Home Screen) and open it from there; then turn reminders on here.'
      : 'This browser can’t receive notifications from the Pi.'
    return
  }
  const row = document.createElement('label')
  row.className = 'menu-check remind-row'
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.className = 'switch remind-on'
  box.setAttribute('role', 'switch')
  box.checked = !!st.reminders && Notification.permission === 'granted'
  const lbl = document.createElement('span')
  lbl.textContent = 'Daily reminder of what’s due'
  row.append(box, lbl)
  const hourRow = document.createElement('div')
  hourRow.className = 'remind-hour'
  const hl = document.createElement('span')
  hl.textContent = 'At'
  const sel = document.createElement('select')
  sel.className = 'pop-select'
  sel.setAttribute('aria-label', 'Reminder time')
  for (let h = 5; h <= 22; h++) {
    const o = document.createElement('option')
    o.value = String(h)
    o.textContent = String(h).padStart(2, '0') + ':00'
    o.selected = h === Number(st.remindHour)
    sel.appendChild(o)
  }
  const test = document.createElement('button')
  test.type = 'button'
  test.className = 'pop-btn remind-test'
  test.textContent = 'Send a test'
  hourRow.append(hl, sel, test)
  const hint = document.createElement('small')
  hint.className = 'remind-hint'
  hint.textContent = 'To-do tasks and @dated checkboxes that are due or overdue, once a day, even with the app closed.'
  host.append(row, hourRow, hint)
  const sync = () => {
    sel.disabled = !box.checked
    test.disabled = !box.checked
  }
  sync()
  box.addEventListener('change', async () => {
    box.disabled = true
    const ok = await saveReminders(box.checked, Number(sel.value))
    if (!ok) box.checked = !box.checked
    box.disabled = false
    sync()
    if (ok && box.checked) ui.toast('Reminders on: every day at ' + sel.options[sel.selectedIndex].text)
  })
  sel.addEventListener('change', () => {
    if (box.checked) saveReminders(true, Number(sel.value))
  })
  test.addEventListener('click', async () => {
    try {
      const sub = await pushSubscription(false)
      const r = sub ? await fetch('/api/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }) : null
      const d = r ? await r.json() : null
      ui.toast(d && d.ok ? 'Sent: it should arrive in a moment.' : 'The test did not go through' + (d && d.error ? ': ' + d.error : '.'))
    } catch {
      ui.toast('The test did not go through.')
    }
  })
}

// ---- import (Markdown folders, Obsidian, this app's mirror, Google Keep) ----------
async function openImport() {
  const choice = await ui.dialog({
    title: 'Import notes',
    message:
      'Pick a folder (an Obsidian vault, a Markdown folder, a Notes backup or a Google Keep Takeout folder) or some files. Folders become tabs and files become notes; pictures come along when they are in what you pick.',
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Choose files…', value: 'files' },
      { label: 'Choose a folder…', value: 'folder', primary: true },
    ],
  })
  if (!choice) return
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  if (choice === 'folder') input.webkitdirectory = true
  else input.accept = '.md,.markdown,.txt,.json,image/*'
  input.style.display = 'none'
  document.body.appendChild(input)
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || [])
    input.remove()
    if (!files.length) return
    const busy = ui.toast('Importing ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '…', { ms: 60000 })
    try {
      const out = await importFiles(files, { doc, me, upload: uploadImages, genId, makeTabMap })
      busy()
      if (!out.notes && !out.docs) return ui.toast('Nothing to import there' + (out.skipped ? ` (${out.skipped} file${out.skipped === 1 ? '' : 's'} not understood)` : '') + '.')
      const first = out.tabs[0]
      ui.toast(`Imported ${out.notes} note${out.notes === 1 ? '' : 's'}${out.docs ? ` and ${out.docs} document${out.docs === 1 ? '' : 's'}` : ''} into ${out.tabs.map((t) => t.name).join(', ')}`, {
        action: first ? 'Open' : undefined,
        ms: 9000,
        onAction: () => first && setActiveTab(first.id),
      })
    } catch (err) {
      busy()
      ui.toast('Import failed: ' + (err && err.message ? err.message : 'unknown error'))
    }
  })
  input.click()
}

function openSettingsMenu(anchor) {
  closeMenus()
  const st = getSettings()
  const menu = document.createElement('div')
  menu.className = 'menu settings-menu'
  menu.addEventListener('click', (e) => e.stopPropagation())
  const r = anchor.getBoundingClientRect()
  const fromBottom = r.width && r.top > window.innerHeight / 2 // e.g. the phone's bottom bar
  if (!r.width) menu.style.top = '56px' // anchor hidden (phone): just below the top bar
  else if (fromBottom) menu.style.bottom = window.innerHeight - r.top + 6 + 'px'
  else menu.style.top = r.bottom + 6 + 'px'
  menu.style.right = (r.width ? Math.max(8, window.innerWidth - r.right) : 8) + 'px'
  menu.style.left = 'auto'

  const head = (t) => {
    const h = document.createElement('div')
    h.className = 'menu-h'
    h.textContent = t
    menu.appendChild(h)
  }
  const check = (label, key, hint) => {
    const l = document.createElement('label')
    l.className = 'menu-check'
    const c = document.createElement('input')
    c.type = 'checkbox'
    c.checked = !!st[key]
    c.addEventListener('change', () => setSetting(key, c.checked))
    const span = document.createElement('span')
    span.textContent = label
    l.append(c, span)
    if (hint) {
      const hh = document.createElement('small')
      hh.textContent = hint
      l.appendChild(hh)
    }
    menu.appendChild(l)
  }
  head('Appearance')
  const themeRow = document.createElement('div')
  themeRow.className = 'settings-enum'
  const themeLabel = document.createElement('span')
  iconLabel(themeLabel, 'Theme', 'sun')
  themeRow.append(themeLabel, ui.segmented('Theme', [['system', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']], st.theme, value => setSetting('theme', value)))
  menu.appendChild(themeRow)
  const ribbonRow = document.createElement('div')
  ribbonRow.className = 'settings-enum'
  const ribbonLabel = document.createElement('span')
  iconLabel(ribbonLabel, 'Toolbar', 'rows')
  ribbonRow.append(ribbonLabel, ui.segmented('Toolbar', [['always', 'Always'], ['editing', 'While editing']], st.ribbon, (value) => setSetting('ribbon', value)))
  menu.appendChild(ribbonRow)
  const colsRow = document.createElement('div')
  colsRow.className = 'settings-enum'
  const colsLabel = document.createElement('span')
  iconLabel(colsLabel, 'Phone columns', 'grid')
  colsRow.append(colsLabel, ui.segmented('Phone columns', [['1', 'One'], ['2', 'Two']], String(st.phoneCols), value => { setSetting('phoneCols', Number(value)); phoneRefresh() }))
  menu.appendChild(colsRow)
  head('Editing')
  check('Spell-check underline', 'spellcheck', 'Red squiggles in notes')
  check('Smart arrows', 'arrows', '-> becomes →, -- becomes —')
  check('Dates from words', 'dates', '@friday, @tomorrow or @in 3 days becomes a date')
  head('Board')
  check('Snap notes to each other', 'snap', 'Edges and centres line up while dragging (hold Alt to place freely)')
  check('Snap to a grid', 'grid', 'Every ' + (st.gridSize || 20) + ' px')
  const launch = document.createElement('label')
  launch.className = 'menu-check'
  const lc = document.createElement('input')
  lc.type = 'checkbox'
  lc.checked = st.launch === 'home'
  lc.addEventListener('change', () => setSetting('launch', lc.checked ? 'home' : 'last'))
  const ls = document.createElement('span')
  ls.textContent = 'Open the home page on launch'
  launch.append(lc, ls)
  menu.appendChild(launch)

  head('Reminders on this device')
  const remRow = document.createElement('div')
  remRow.className = 'menu-note reminders'
  menu.appendChild(remRow)
  drawReminderSettings(remRow)

  head('Backup on this device')
  check('Keep an offline copy', 'offline', 'The board opens even with the Pi off')
  const btn = (label, fn, cls) => {
    const b = document.createElement('button')
    b.className = 'menu-item' + (cls ? ' ' + cls : '')
    iconLabel(b, label)
    b.addEventListener('click', () => {
      closeMenus()
      fn()
    })
    menu.appendChild(b)
    return b
  }
  const link = (label, href) => {
    const a = document.createElement('a')
    a.className = 'menu-item menu-sub'
    a.href = href
    iconLabel(a, label)
    a.addEventListener('click', () => closeMenus())
    menu.appendChild(a)
  }
  btn('⬇  Download all notes (Markdown)', () => backup.download(doc, 'md'), 'backup-md')
  btn('⬇  Download all notes (JSON)', () => backup.download(doc, 'json'), 'backup-json')
  if (folderBackup) {
    const st = folderBackup.status()
    if (st.state === 'off') btn('📁  Auto-save to a folder…', () => folderBackup.choose(), 'backup-folder')
    else {
      if (st.state === 'paused') btn('▶  Resume saving to "' + st.folder + '"', () => folderBackup.resume(), 'backup-folder')
      btn('■  Stop saving to "' + st.folder + '"', () => folderBackup.stop(), 'backup-folder')
    }
    const fs = document.createElement('div')
    fs.className = 'menu-note backup-status'
    fs.textContent = folderStatusText(st)
    menu.appendChild(fs)
  }
  const ex = backup.excludedTabs()
  const exNames = tabsList()
    .filter((t) => ex.has(t.id))
    .map((t) => t.name)
  const note = document.createElement('div')
  note.className = 'menu-note'
  note.textContent =
    (exNames.length ? 'Left out here: ' + exNames.join(', ') + ' (tab menu ⋯). ' : '') +
    'Built from this device, so it works with the Pi off. The Pi also keeps a full copy with history in data/export/.'
  menu.appendChild(note)
  link('⬇  Download from the Pi (everything, Markdown)', '/api/export.md')
  link('⬇  Download from the Pi (everything, JSON)', '/api/export.json')
  link('⬇  Download from the Pi (ZIP with every picture)', '/api/export.zip')
  btn('⬆  Import notes (Markdown, Obsidian, Google Keep)…', () => openImport(), 'import-btn')

  head('Account')
  btn('Change your name', () => document.getElementById('rename').click())
  for (const input of menu.querySelectorAll('input[type="checkbox"]')) {
    input.classList.add('switch')
    input.setAttribute('role', 'switch')
  }
  for (const row of menu.querySelectorAll('.menu-check')) {
    const tile = document.createElement('span')
    tile.className = 'settings-tile'
    tile.appendChild(makeIcon(row.textContent.includes('offline') ? 'cloud' : row.textContent.includes('launch') ? 'home' : row.textContent.includes('Snap') ? 'grid' : row.textContent.includes('reminder') ? 'calendar' : row.textContent.includes('Dates') ? 'calendar' : 'text'))
    row.prepend(tile)
  }

  document.body.appendChild(menu)
  const dismiss = ui.popover(menu, anchor, { menu: !menu.classList.contains('settings-menu'), label: 'Settings' })
  openMenus.push({ remove: dismiss })
}

onSettingChange((key, value) => {
  if (key === 'backupExclude') {
    if (folderBackup) folderBackup.schedule()
    renderTabs()
  }
  if (key === 'spellcheck') {
    for (const [, c] of cards) {
      c.titleEl.spellcheck = value
      if (c.body && c.body.editors) c.body.editors.forEach((r) => r.setSpellcheck(value))
      c.el.querySelectorAll('.todo-text').forEach((i) => (i.spellcheck = value))
    }
  } else if (key === 'offline') applyOfflineSetting()
})

// ---- this device's own backup to a folder (Chromium desktop) ----
function folderStatusText(st) {
  if (st.state === 'off') return 'Keeps a readable copy in a folder on this computer, updated as you edit.'
  if (st.state === 'paused') return 'Paused: the browser needs your OK again after a restart.'
  if (st.error) return 'Last try failed: ' + st.error
  return st.lastSaved ? 'Saved to "' + st.folder + '" ' + relTime(st.lastSaved) : 'Saving to "' + st.folder + '"…'
}
let folderPausedToast = false
const folderBackup = backup.folderSupported
  ? backup.createFolderBackup(doc, {
      onStatus: (st) => {
        if (st.state === 'paused' && !folderPausedToast) {
          folderPausedToast = true
          ui.toast('Backups to "' + st.folder + '" are paused.', {
            action: 'Resume',
            ms: 15000,
            onAction: () => folderBackup.resume(),
          })
        }
        if (st.state === 'on') folderPausedToast = false
        const el = document.querySelector('.backup-status')
        if (el) el.textContent = folderStatusText(st)
      },
    })
  : null

// Keep relative timestamps fresh.
setInterval(() => {
  for (const [, card] of cards) card.setMeta()
}, 60000)

// Run the one-time migration only after the server's state has arrived, so we
// never race a populated board into a duplicate default tab. If we never reach
// the server (offline first run), seed a tab after a short grace period.
// deep link: #note=<id> opens that note's tab and flashes it; #note=<id>&full
// opens it full screen
function followHash(initial) {
  if (location.hash === '#today') {
    // the installed app's "Today" shortcut
    navReplace({})
    openToday()
    return
  }
  if (location.hash === '#new') {
    // the installed app's "New note" shortcut
    try {
      history.replaceState(null, '', location.pathname + location.search)
    } catch {
      /* ignore */
    }
    const t = activeTab()
    if (t && !isNotesTab(t)) {
      const n = tabsList().find((x) => isNotesTab(x) && !x.archived)
      if (n) setActiveTab(n.id, { push: false })
    }
    const id = createNote(PAPER[Math.floor(Math.random() * 4)])
    setTimeout(() => openFullscreen(id), 50)
    return
  }
  const tm = /#tab=([A-Za-z0-9_-]+)/.exec(location.hash)
  if (tm) {
    // the Android widget's "open this tab"
    if (tabsList().some((t) => t.id === tm[1])) setActiveTab(tm[1], { push: false })
    try {
      history.replaceState(null, '', location.pathname + location.search)
    } catch {
      /* ignore */
    }
    return
  }
  const m = /#note=([A-Za-z0-9_-]+)(&full)?/.exec(location.hash)
  if (!m) return
  if (full && full.id === m[1] && m[2]) return
  goToNote(m[1], { unarchive: false, keepHash: !!m[2] })
  if (m[2]) openFullscreen(m[1], { fromHash: true, focus: !initial })
}
let hashFollowed = false
function followHashOnce() {
  if (hashFollowed) return
  hashFollowed = true
  followHash(true)
}
provider.onSync(() => {
  migrateBoard()
  // the entry we started on was stamped before the tabs arrived
  if (history.state && history.state.nav && !history.state.tab) {
    const rest = { ...history.state }
    delete rest.nav
    delete rest.tab
    navReplace(rest, location.href)
  }
  followHashOnce()
})
// With the Pi unreachable the server never syncs, but the board is in IndexedDB:
// still follow a deep link (the Android widgets' #tab= / #note= / #new) from the
// local copy once it has loaded and the server has had a moment to answer.
if (localStore) {
  localStore.whenSynced.then(() => {
    setTimeout(() => {
      if (!provider.synced && location.hash) followHashOnce()
    }, 1500)
  })
}
awareness.setLocalStateField('tab', activeTabId)
// the entry we start on gets our state too, so Back to it is ours to handle
if (!history.state || !history.state.nav) navReplace({}, location.href)
window.addEventListener('hashchange', () => {
  // Back/Forward between our own entries also changes the hash; popstate has it covered
  if (ignoreHash || Date.now() - poppedAt < 200) return
  followHash(false)
})
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}
// Offline first-run only: if we never even connected, seed a starter board. If we
// HAVE connected but sync is just slow, wait for onSync — seeding here would race
// the server's real tabs and leave a duplicate "Ideas" tab.
setTimeout(() => {
  if (!provider.synced && !everConnected) migrateBoard()
}, 2500)
reconcile()

mountIcons()
initTooltips()
tabsEl.setAttribute('role', 'tablist')
window.addEventListener('notes-theme-change', () => {
  for (const [, card] of cards) {
    applyNoteStyle(card.el, card.note)
    card.pop?.querySelectorAll('.pop-swatch').forEach(b => { b.style.background = renderedPaper(b.dataset.color); b.style.color = inkFor(renderedPaper(b.dataset.color)) })
  }
  if (full) applyFullStyle(full.card)
  viewport.refreshMap()
})
const searchClear = document.getElementById('search-clear')
search.addEventListener('input', () => { searchClear.hidden = !search.value })
searchClear.addEventListener('click', () => { search.value = ''; search.dispatchEvent(new Event('input')); search.focus() })
document.getElementById('empty-add').addEventListener('click', () => phoneMode() ? newPhoneNote('note') : addBtn.click())
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault(); if (phoneMode()) document.body.classList.add('searching'); search.focus(); search.select()
  }
})
const syncScrollChrome = rafThrottle(() => {
  document.querySelector('.topbar').classList.toggle('scrolled', scrollY > 8 || board.scrollTop > 8)
  document.body.classList.toggle('compact-title', scrollY > 40)
})
window.addEventListener('scroll', syncScrollChrome, { passive: true })
board.addEventListener('scroll', syncScrollChrome, { passive: true })
let pullStart = null
board.addEventListener('touchstart', e => { if (phoneMode() && scrollY <= 0) pullStart = e.touches[0].clientY }, { passive: true })
board.addEventListener('touchend', e => { if (pullStart != null && e.changedTouches[0].clientY - pullStart > 70) document.body.classList.add('searching'); pullStart = null }, { passive: true })
