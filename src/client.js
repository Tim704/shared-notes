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
import {
  genId,
  clamp,
  rafThrottle,
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
  el.value = ytext.toString()

  const observer = (event) => {
    if (event.transaction.local) return
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
    })
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
const yDrawings = doc.getMap('drawings') // tabId -> Y.Array<stroke>

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
const FS_DEFAULT = 13

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
youName.textContent = me.name
youName.style.setProperty('--me', me.color)

let everConnected = false
provider.onStatus((connected) => {
  if (connected) everConnected = true
  dot.classList.toggle('on', connected)
  dot.title = connected ? 'Connected' : 'Reconnecting...'
})

// ---- active tab (per-user) ----
let activeTabId = null
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
    return { id: t.get('id'), name: t.get('name') || '', kind: t.get('kind') || 'notes', archived: !!t.get('archived') }
  }
  return { id: t.id, name: t.name || '', kind: t.kind || 'notes', archived: !!t.archived }
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
function setActiveTab(id) {
  activeTabId = id
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
async function addTab(kind) {
  const label = kind === 'draw' ? 'Sketch' : 'List'
  const typed = await ui.prompt(`Name this ${label.toLowerCase()} tab:`, label, { title: 'New tab', maxLength: 28 })
  if (typed == null) return
  const name = typed.trim().slice(0, 28) || label
  const id = genId()
  doc.transact(() => {
    yTabs.push([makeTabMap({ id, name, kind })])
  })
  setActiveTab(id)
}

function renameTab(id, name) {
  const t = tabsList().find((x) => x.id === id)
  if (!t) return
  const next = (name || '').trim().slice(0, 28)
  if (!next || next === t.name) return
  updateTab(id, { name: next })
}

function setTabArchived(id, archived) {
  updateTab(id, { archived: !!archived })
  if (archived && activeTabId === id) {
    const next = tabsList().find((t) => !t.archived && t.id !== id)
    if (next) setActiveTab(next.id)
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
  const kindWord = t.kind === 'draw' ? 'sketch and all its strokes' : 'tab and all its notes'
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
    // remove notes that belong to this tab
    const ids = yOrder.toArray()
    for (let k = ids.length - 1; k >= 0; k--) {
      const n = yNotes.get(ids[k])
      if (n && n.get('tabId') === id) {
        yOrder.delete(k, 1)
        yNotes.delete(ids[k])
      }
    }
    if (yDrawings.has(id)) yDrawings.delete(id)
    if (i >= 0) yTabs.delete(i, 1)
  })
  const remaining = tabsList().filter((x) => !x.archived)
  if (remaining.length) setActiveTab(remaining[Math.max(0, Math.min(i, remaining.length - 1))].id)
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
function renderTabs() {
  const all = tabsList()
  const active = activeTab()
  const list = all.filter((t) => !t.archived || (active && t.id === active.id))
  tabsEl.innerHTML = ''

  const home = document.createElement('button')
  home.className = 'tab-home'
  home.title = 'All tabs (home)'
  home.innerHTML = '&#8962;'
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

    const icon = document.createElement('span')
    icon.className = 'tab-icon'
    icon.textContent = t.kind === 'draw' ? '✎' : '☰' // pencil / list
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

    if (isActive) {
      const more = document.createElement('button')
      more.className = 'tab-x'
      more.textContent = '⋯'
      more.title = 'Tab options'
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
  add.textContent = '+'
  add.title = 'Add a tab'
  add.addEventListener('click', (e) => {
    e.stopPropagation()
    openAddMenu(add)
  })
  tabsEl.appendChild(add)

  // right side: collapse-all + hidden notes (trash / archived) for this tab
  const right = document.createElement('div')
  right.className = 'tab-right'
  if (active && active.kind !== 'draw') {
    const hidden = hiddenCounts(active.id)
    const fold = document.createElement('button')
    fold.className = 'tab-tool'
    const allCollapsed = cards.size > 0 && Array.from(cards.keys()).every((id) => collapsed.has(id))
    fold.textContent = allCollapsed ? '⌄ Expand all' : '⌃ Collapse all'
    fold.title = 'Collapse or expand every note on this tab (just for you)'
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
    b.textContent = label
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
  item(t.archived ? 'Unarchive' : 'Archive', () => setTabArchived(t.id, !t.archived))
  item('Delete…', () => deleteTab(t.id), 'danger')
  document.body.appendChild(menu)
  openMenus.push(menu)
}

function openAddMenu(anchor) {
  closeMenus()
  const menu = document.createElement('div')
  menu.className = 'menu'
  const r = anchor.getBoundingClientRect()
  menu.style.left = r.left + 'px'
  menu.style.top = r.bottom + 4 + 'px'
  const mkItem = (label, kind) => {
    const b = document.createElement('button')
    b.className = 'menu-item'
    b.textContent = label
    b.addEventListener('click', () => {
      closeMenus()
      addTab(kind)
    })
    return b
  }
  menu.append(mkItem('☰  List of notes', 'notes'), mkItem('✎  Sketch board', 'draw'))
  document.body.appendChild(menu)
  openMenus.push(menu)
}

const openMenus = []
function closeMenus() {
  while (openMenus.length) openMenus.pop().remove()
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

function createNote(color) {
  const id = genId()
  const active = activeTab()
  const pos = nextNotePos()
  const z = maxZ() + 1
  doc.transact(() => {
    const n = new Y.Map()
    n.set('title', new Y.Text())
    n.set('body', new Y.Text())
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

// Flip a note between prose and checklist, carrying the text across. prose→todo
// splits the body into items (one per non-blank line); todo→prose joins items
// back into the body. Done-state is dropped on the way back to prose.
function setNoteKind(note, kind) {
  const cur = note.get('kind') || 'note'
  if (cur === kind) return
  note.doc.transact(() => {
    if (kind === 'todo') {
      const lines = note
        .get('body')
        .toString()
        .split('\n')
        .map((s) => s.replace(/\s+$/, ''))
        .filter((s) => s.trim() !== '')
      const arr = new Y.Array()
      note.set('items', arr)
      const use = lines.length ? lines : ['']
      for (const line of use) {
        const it = new Y.Map()
        const t = new Y.Text()
        it.set('id', genId())
        it.set('text', t)
        it.set('done', false)
        arr.push([it])
        if (line) t.insert(0, line)
      }
      note.set('kind', 'todo')
    } else {
      const items = note.get('items')
      const text = items
        ? items
            .toArray()
            .map((it) => it.get('text').toString())
            .join('\n')
        : ''
      const body = note.get('body')
      if (body.length) body.delete(0, body.length)
      if (text) body.insert(0, text)
      note.set('kind', 'note')
    }
  })
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

// Searchable text for a note (title + body, or title + item texts for a list).
function noteHay(note) {
  const title = note.get('title').toString()
  let body = ''
  if ((note.get('kind') || 'note') === 'todo') {
    const items = note.get('items')
    body = items
      ? items
          .toArray()
          .map((it) => it.get('text').toString())
          .join(' ')
      : ''
  } else {
    body = note.get('body').toString()
    const b2 = note.get('body2')
    if (b2) body += ' ' + b2.toString()
  }
  return (title + ' ' + body).toLowerCase()
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

// ---- navigation to a note (links, home page, toasts) ----
function goToNote(id, opts = {}) {
  const n = yNotes.get(id)
  if (!n) return false
  const tid = n.get('tabId')
  if (tid && activeTabId !== tid) setActiveTab(tid)
  closeHome()
  if (n.get('deleted')) restoreNote(id)
  if (n.get('archived') && opts.unarchive !== false) setNoteArchived(id, false)
  if (collapsed.has(id)) setCollapsed(id, false)
  try {
    history.replaceState(null, '', '#note=' + id)
  } catch {
    /* ignore */
  }
  // the card may not exist until reconcile has run
  const tryFlash = (left) => {
    const c = cards.get(id)
    if (c) {
      c.el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      c.el.classList.add('flash')
      setTimeout(() => c.el.classList.remove('flash'), 1400)
      return
    }
    if (left > 0) setTimeout(() => tryFlash(left - 1), 60)
  }
  tryFlash(20)
  return true
}

// [[Title]] → the note or tab with that title (notes first, current tab first)
function resolveLink(label) {
  const want = label.trim().toLowerCase()
  if (!want) return null
  let best = null
  yNotes.forEach((n, id) => {
    if (n.get('deleted')) return
    if (n.get('title').toString().trim().toLowerCase() !== want) return
    if (!best || (n.get('tabId') === activeTabId && best.tabId !== activeTabId)) best = { noteId: id, tabId: n.get('tabId') }
  })
  if (best) return best
  const t = tabsList().find((x) => x.name.trim().toLowerCase() === want)
  return t ? { tabId: t.id } : null
}

function followLink(href) {
  if (!href) return
  if (href[0] === '[') {
    const target = resolveLink(href.slice(2, -2))
    if (!target) {
      ui.toast('No note or tab called ' + href)
      return
    }
    if (target.noteId) goToNote(target.noteId)
    else setActiveTab(target.tabId)
    return
  }
  window.open(href, '_blank', 'noopener')
}

function linkCandidates() {
  const out = []
  const tabsById = new Map(tabsList().map((t) => [t.id, t]))
  yNotes.forEach((n) => {
    if (isHidden(n)) return
    const title = n.get('title').toString().trim()
    if (!title) return
    const t = tabsById.get(n.get('tabId'))
    out.push({ label: title, hint: t ? t.name : '' })
  })
  for (const t of tabsById.values()) if (t.name.trim()) out.push({ label: t.name.trim(), hint: 'tab' })
  return out
}

// ---- card construction ----
const cards = new Map() // id -> { ... }

function applyNoteStyle(el, note) {
  const color = note.get('color') || PAPER[0]
  el.style.background = color
  el.style.setProperty('--note-ink', inkFor(color))
  el.style.setProperty('--note-ink-dim', inkDimFor(color))
  el.style.setProperty('--note-line', hairlineFor(color))
  el.style.setProperty('--note-fs', (note.get('fontSize') || FS_DEFAULT) + 'px')
  // title follows the body (+1px) unless the note opted into its own size
  const ts = note.get('titleSize')
  if (ts) el.style.setProperty('--title-fs', ts + 'px')
  else el.style.removeProperty('--title-fs')
  el.classList.toggle('autogrow', !!note.get('autoGrow'))
  el.classList.toggle('book', note.get('layout') === 'book')
  for (const cls of Object.values(SIZES)) el.classList.remove(cls)
  el.classList.add(SIZES[note.get('size')] || SIZES.m)
}

// ---- free-floating "corkboard" layout -------------------------------------
// Desktop: notes are absolutely positioned — drag the header to move, drag the
// corner grip to resize. Narrow screens fall back to the stacked flow layout
// (x/y/w/h are ignored there so a phone stays usable).
const mqStack = window.matchMedia('(max-width: 560px)')
let freeLayout = !mqStack.matches

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
  const bw = board.clientWidth || window.innerWidth
  const x = clamp(note.get('x') || 0, 0, Math.max(0, bw - w))
  const y = Math.max(0, note.get('y') || 0)
  el.style.left = x + 'px'
  el.style.top = y + 'px'
  el.style.width = w + 'px'
  // collapsed (title only) and auto-growing notes size themselves to content
  const fluid = collapsed.has(el.dataset.id) || note.get('autoGrow')
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
  if (!freeLayout) {
    board.style.minHeight = ''
    return
  }
  let maxB = 0
  for (const [id, c] of cards) {
    const n = c.note
    const y = Math.max(0, n.get('y') || 0)
    const fluid = collapsed.has(id) || n.get('autoGrow')
    const h = fluid ? c.el.offsetHeight || H_MIN : Math.max(H_MIN, n.get('h') || H_DEFAULT)
    if (y + h > maxB) maxB = y + h
  }
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
  return { x: 24 + (n % 7) * step, y: 24 + (n % 7) * step }
}

mqStack.addEventListener('change', () => {
  freeLayout = !mqStack.matches
  relayoutAll()
})
window.addEventListener(
  'resize',
  rafThrottle(() => {
    if (freeLayout) relayoutAll()
  })
)

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

  const optBtn = document.createElement('button')
  optBtn.className = 'icon-btn opt'
  optBtn.title = 'Type, colour, size & text'
  optBtn.innerHTML = '&#9881;'

  const del = document.createElement('button')
  del.className = 'icon-btn del'
  del.title = 'Delete note'
  del.textContent = '×'
  del.addEventListener('click', () => deleteNote(id)) // soft delete + Undo toast

  const fold = document.createElement('button')
  fold.className = 'icon-btn fold'
  fold.title = 'Collapse / expand (just for you)'
  fold.textContent = '⌄'
  fold.addEventListener('click', (e) => {
    e.stopPropagation()
    setCollapsed(id, !collapsed.has(id))
  })

  tools.append(fold, optBtn, del)
  top.append(presenceEl, tools)
  if (collapsed.has(id)) el.classList.add('collapsed')

  const titleEl = document.createElement('input')
  titleEl.className = 'card-title'
  titleEl.placeholder = 'Title'
  titleEl.maxLength = 120
  titleEl.spellcheck = getSettings().spellcheck
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

  // formatting toolbar (prose notes only; appears while the note is focused)
  const fmt = document.createElement('div')
  fmt.className = 'card-fmt'
  const fmtBtns = {}
  ;[
    ['b', 'B', 'Bold  (Ctrl/Cmd+B)'],
    ['i', 'I', 'Italic  (Ctrl/Cmd+I)'],
    ['u', 'U', 'Underline  (Ctrl/Cmd+U)'],
    ['s', 'S', 'Strikethrough  (Ctrl/Cmd+Shift+S)'],
  ].forEach(([mark, label, tip]) => {
    const b = document.createElement('button')
    b.className = 'fmt-btn fmt-' + mark
    b.textContent = label
    b.title = tip
    b.addEventListener('mousedown', (e) => {
      e.preventDefault() // keep the body's selection
      const rich = card.activeRich || (card.body && card.body.rich)
      if (rich) rich.toggleMark(mark)
    })
    fmt.appendChild(b)
    fmtBtns[mark] = b
  })

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

  el.append(top, titleEl, bodyHost, fmt, meta, grip)

  applyNoteStyle(el, note)
  applyNoteLayout(el, note)

  // ---- drag to move (header) + drag to resize (grip), free layout only ----
  // `card.interacting` lets noteObs skip re-laying-out while WE drive the inline
  // style; `card.abortInteraction` lets destroyCard tear down an in-flight drag.
  let pendingPos = null
  let pendingSize = null
  const commitPos = () => {
    if (!pendingPos) return
    const p = pendingPos
    pendingPos = null
    if (!yNotes.has(id)) return // note was deleted mid-drag; don't resurrect keys
    note.doc.transact(() => {
      note.set('x', p.x)
      note.set('y', p.y)
    })
  }
  const commitSize = () => {
    if (!pendingSize) return
    const s = pendingSize
    pendingSize = null
    if (!yNotes.has(id)) return
    note.doc.transact(() => {
      note.set('w', s.w)
      note.set('h', s.h)
      if (note.get('autoGrow')) note.delete('autoGrow')
    })
  }
  const schedulePos = rafThrottle(commitPos)
  const scheduleSize = rafThrottle(commitSize)

  top.addEventListener('pointerdown', (e) => {
    if (!freeLayout) return
    if (e.button != null && e.button !== 0 && e.pointerType === 'mouse') return
    if (e.target.closest('.card-tools')) return // let the gear / delete buttons work
    e.preventDefault()
    bringToFront(note)
    const sx = e.clientX
    const sy = e.clientY
    const ox = note.get('x') || 0
    const oy = note.get('y') || 0
    const bw = board.clientWidth
    const w = note.get('w') || W_DEFAULT
    try {
      top.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    card.interacting = true
    el.classList.add('dragging')
    const move = (ev) => {
      const nx = clamp(ox + (ev.clientX - sx), 0, Math.max(0, bw - w))
      const ny = Math.max(0, oy + (ev.clientY - sy))
      el.style.left = nx + 'px'
      el.style.top = ny + 'px'
      pendingPos = { x: nx, y: ny }
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
      card.interacting = false
      card.abortInteraction = null
      el.classList.remove('dragging')
      commitPos()
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
    const sx = e.clientX
    const sy = e.clientY
    const ow = note.get('w') || W_DEFAULT
    const oh = note.get('h') || H_DEFAULT
    const x = note.get('x') || 0
    const bw = board.clientWidth
    try {
      grip.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    card.interacting = true
    el.classList.add('resizing')
    const move = (ev) => {
      const nw = clamp(ow + (ev.clientX - sx), W_MIN, Math.max(W_MIN, bw - x))
      const nh = Math.max(H_MIN, oh + (ev.clientY - sy))
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
      commitSize()
      updateBoardExtent()
    }
    card.abortInteraction = end
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', end)
    grip.addEventListener('pointercancel', end)
  })

  const unbinds = []
  unbinds.push(bindInput(note.get('title'), titleEl, () => applyFilter()))
  el.addEventListener('input', () => stamp(note))
  el.addEventListener('change', () => stamp(note))

  const card = {
    el,
    unbinds,
    body: null,
    fmtBtns,
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

  optBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    bringToFront(note) // raise the card so its popover isn't trapped under a neighbour
    togglePopover(card)
  })

  // presence focus follows any field inside the card (title, body, list items)
  el.addEventListener('focusin', () => {
    awareness.setLocalStateField('focus', id)
    bringToFront(note)
  })
  el.addEventListener('focusout', (e) => {
    if (el.contains(e.relatedTarget)) return
    if (awareness.getLocalState()?.focus === id) awareness.setLocalStateField('focus', null)
  })

  const noteObs = (e) => {
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
      e.keysChanged.has('autoGrow')
    ) {
      applyNoteStyle(el, note)
      if (card.pop) refreshPopover(card)
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
      applyNoteLayout(el, note)
      updateBoardExtent()
    }
    if (e.keysChanged.has('tabId')) scheduleReconcile()
  }
  note.observe(noteObs)
  card.noteObs = noteObs

  if (typeof ResizeObserver !== 'undefined') {
    card.ro = new ResizeObserver(
      rafThrottle(() => {
        if (freeLayout && (collapsed.has(id) || note.get('autoGrow'))) updateBoardExtent()
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
  if (kind === 'todo') {
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
    const rich = bindRichText(ytext, bodyEl, {
      onChange: () => applyFilter(),
      onLocal: () => stamp(note),
      onLink: followLink,
      linkCandidates,
      arrows: () => getSettings().arrows,
      spellcheck: () => getSettings().spellcheck,
      onState: (marks) => {
        for (const m of ['b', 'i', 'u', 's']) card.fmtBtns[m].classList.toggle('on', !!marks[m])
      },
    })
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
  addBtn.textContent = '+ Add item'
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
    delB.textContent = '×'
    delB.title = 'Remove item'
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
    card.pop.remove()
    card.pop = null
  }
  card.el.remove()
}

// ---- options popover (colour / size / text) ----
function closeAllPopovers() {
  for (const [, c] of cards) {
    if (c.pop) {
      c.pop.classList.remove('open')
    }
  }
}

function togglePopover(card) {
  const wasOpen = card.pop && card.pop.classList.contains('open')
  closeAllPopovers()
  if (wasOpen) return
  if (!card.pop) buildPopover(card)
  refreshPopover(card)
  const pop = card.pop
  // reset any prior on-screen flip, then keep it within the viewport
  pop.style.left = ''
  pop.style.right = ''
  pop.classList.add('open')
  const r = pop.getBoundingClientRect()
  if (r.left < 8) {
    pop.style.right = 'auto'
    pop.style.left = '6px' // flip to anchor on the card's left edge
  } else if (r.right > window.innerWidth - 8) {
    pop.style.right = '6px'
    pop.style.left = 'auto'
  }
}

function buildPopover(card) {
  const pop = document.createElement('div')
  pop.className = 'card-pop'
  pop.addEventListener('click', (e) => e.stopPropagation())

  // Type (prose note vs checklist)
  const kSec = section('Type')
  const kRow = document.createElement('div')
  kRow.className = 'pop-row pop-sizes'
  const kindBtns = {}
  ;[
    ['note', 'Note'],
    ['todo', 'Checklist'],
  ].forEach(([k, label]) => {
    const b = document.createElement('button')
    b.className = 'pop-btn size-btn'
    b.textContent = label
    b.addEventListener('click', () => setNoteKind(card.note, k))
    kRow.appendChild(b)
    kindBtns[k] = b
  })
  kSec.append(kRow)

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
  saveFav.textContent = '★ Save'
  saveFav.title = 'Save this colour to favourites'
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
    b.textContent = label
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
    b.textContent = label
    b.title = k === 'book' ? 'Two pages side by side' : 'One page'
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
    if (agChk.checked) card.note.set('autoGrow', true)
    else card.note.delete('autoGrow')
  })
  agRow.append(agChk, document.createTextNode(' Grow with content (no inner scroll)'))
  oSec.append(tsRow, tsStep, agRow)

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
  aRow.className = 'pop-row pop-sizes'
  const archiveBtn = document.createElement('button')
  archiveBtn.className = 'pop-btn'
  archiveBtn.textContent = 'Archive'
  archiveBtn.title = 'Hide this note without deleting it'
  archiveBtn.addEventListener('click', () => {
    closeAllPopovers()
    setNoteArchived(card.id, true)
  })
  const histBtn = document.createElement('button')
  histBtn.className = 'pop-btn'
  histBtn.textContent = 'History'
  histBtn.title = 'Earlier versions of this note'
  histBtn.addEventListener('click', () => {
    closeAllPopovers()
    openHistoryPanel(card.id)
  })
  aRow.append(archiveBtn, histBtn)
  aSec.append(aRow)

  pop.append(kSec, lSec, cSec, tSec, wSec, oSec, mSec, aSec)
  card.el.appendChild(pop)
  card.pop = pop
  card.popRefs = { colorInput, favWrap, fsVal, sizeBtns, kindBtns, layoutBtns, tsChk, tsStep, tsVal, agChk, mSel, lSec }
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
  b.style.background = color
  b.title = color
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
  if (!card.popRefs) return
  const { colorInput, fsVal, sizeBtns, kindBtns } = card.popRefs
  colorInput.value = normalizeHex(card.note.get('color') || PAPER[0])
  fsVal.textContent = (card.note.get('fontSize') || FS_DEFAULT) + 'px'
  const sz = card.note.get('size') || 'm'
  for (const k of Object.keys(sizeBtns)) sizeBtns[k].classList.toggle('on', k === sz)
  const kind = card.note.get('kind') || 'note'
  for (const k of Object.keys(kindBtns)) kindBtns[k].classList.toggle('on', k === kind)
  const { layoutBtns, tsChk, tsStep, tsVal, agChk, mSel, lSec } = card.popRefs
  const layout = card.note.get('layout') || 'single'
  for (const k of Object.keys(layoutBtns)) layoutBtns[k].classList.toggle('on', k === layout)
  lSec.style.display = kind === 'todo' ? 'none' : ''
  const ts = card.note.get('titleSize')
  tsChk.checked = !!ts
  tsStep.style.display = ts ? '' : 'none'
  tsVal.textContent = (ts || (card.note.get('fontSize') || FS_DEFAULT) + 1) + 'px'
  agChk.checked = !!card.note.get('autoGrow')
  mSel.replaceChildren()
  for (const t of tabsList()) {
    if (t.kind === 'draw') continue
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
  b.textContent = text
  b.title = title
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
  return { color: '#1f2228', width: 4, mode: 'pen' }
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
  b.textContent = label
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
  const drawing = active && active.kind === 'draw'

  board.style.display = drawing ? 'none' : ''
  drawView.style.display = drawing ? 'flex' : 'none'
  addBtn.style.display = drawing ? 'none' : ''
  searchWrap.style.visibility = drawing ? 'hidden' : ''

  if (drawing) {
    for (const [id, card] of cards) {
      destroyCard(card)
      cards.delete(id)
    }
    empty.style.display = 'none'
    mountDraw(active.id)
    renderTabs()
    renderPresence()
    return
  }

  unmountDraw()
  board.classList.toggle('free', freeLayout)

  const order = yOrder
    .toArray()
    .filter((id) => yNotes.has(id) && belongsToActive(yNotes.get(id), active))
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
    const ref = prev ? prev.nextSibling : board.firstChild
    if (ref !== card.el) board.insertBefore(card.el, ref)
    prev = card.el
  }

  empty.style.display = order.length ? 'none' : 'flex'
  updateBoardExtent()
  renderTabs()
  renderPresence()
  applyFilter()
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

// ---- overlays: home page, hidden notes (trash / archived), history ----------
const overlay = document.getElementById('overlay')
let overlayKind = null // 'home' | 'hidden' | 'history'

function closeOverlay() {
  overlay.hidden = true
  overlay.replaceChildren()
  overlayKind = null
}
function closeHome() {
  if (overlayKind === 'home') closeOverlay()
}
function openPanel(kind, title, build) {
  closeMenus()
  closeAllPopovers()
  overlay.replaceChildren()
  overlayKind = kind
  const panel = document.createElement('div')
  panel.className = 'panel panel-' + kind
  const head = document.createElement('div')
  head.className = 'panel-head'
  const h = document.createElement('div')
  h.className = 'panel-title'
  h.textContent = title
  const x = document.createElement('button')
  x.className = 'panel-x'
  x.textContent = '×'
  x.title = 'Close (Esc)'
  x.addEventListener('click', closeOverlay)
  head.append(h, x)
  const body = document.createElement('div')
  body.className = 'panel-body'
  panel.append(head, body)
  overlay.appendChild(panel)
  overlay.hidden = false
  build(body, panel)
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

function noteSnippet(n, max = 90) {
  const kind = n.get('kind') || 'note'
  let text = ''
  if (kind === 'todo') {
    const items = n.get('items')
    text = items ? items.toArray().map((it) => (it.get('done') ? '☑ ' : '☐ ') + it.get('text').toString()).join('  ') : ''
  } else text = n.get('body').toString()
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

// Home: every tab as a card (with who is on it), archived tabs below, and a
// search box that looks across every tab.
function openHome() {
  openPanel('home', 'All tabs', (body) => {
    const search = document.createElement('input')
    search.className = 'home-search'
    search.type = 'search'
    search.placeholder = 'Search every tab…'
    search.autocomplete = 'off'
    const results = document.createElement('div')
    results.className = 'home-results'
    const grid = document.createElement('div')
    grid.className = 'home-grid'
    const archWrap = document.createElement('div')
    archWrap.className = 'home-archived'
    body.append(search, results, grid, archWrap)

    const render = () => {
      grid.replaceChildren()
      archWrap.replaceChildren()
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
      name.textContent = (t.kind === 'draw' ? '✎ ' : '☰ ') + t.name
      top.appendChild(name)
      if (people.length) {
        const pp = document.createElement('span')
        pp.className = 'home-people'
        people.slice(0, 4).forEach((u) => {
          const d = document.createElement('span')
          d.className = 'editor-dot'
          d.style.setProperty('--c', u.color || '#888')
          d.title = u.name + ' is here'
          d.textContent = initials(u.name || '?')
          pp.appendChild(d)
        })
        top.appendChild(pp)
      }
      const sub = document.createElement('div')
      sub.className = 'home-tab-sub'
      sub.textContent =
        t.kind === 'draw' ? 'Sketch board' : count + (count === 1 ? ' note' : ' notes') + (at ? ' · edited ' + relTime(at) : '')
      c.append(top, sub)
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
      const q = search.value.trim().toLowerCase()
      results.replaceChildren()
      grid.style.display = q ? 'none' : ''
      archWrap.style.display = q ? 'none' : ''
      if (!q) return
      const tabsById = new Map(tabsList().map((t) => [t.id, t]))
      const hits = []
      yOrder.toArray().forEach((id) => {
        const n = yNotes.get(id)
        if (!n || n.get('deleted')) return
        if (noteHay(n).includes(q)) hits.push({ id, n })
      })
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
        row.addEventListener('click', () => goToNote(id))
        results.appendChild(row)
      }
    }
    search.addEventListener('input', doSearch)
    render()
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
            b.textContent = label
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

function restoreVersion(noteId, ver) {
  const n = yNotes.get(noteId)
  if (!n) return
  const title = stripMd(ver.title)
  const bodyText = stripMd(ver.body)
  const body2Text = stripMd(ver.body2)
  doc.transact(() => {
    const t = n.get('title')
    if (t.length) t.delete(0, t.length)
    if (title) t.insert(0, title)
    if ((n.get('kind') || 'note') === 'todo' || /^- \[[ xX]\] /m.test(bodyText)) {
      // rebuild the checklist from "- [ ] item" lines
      const arr = new Y.Array()
      for (const line of bodyText.split('\n')) {
        const m = /^- \[([ xX])\] (.*)$/.exec(line)
        if (!m) continue
        const it = new Y.Map()
        const tx = new Y.Text()
        it.set('id', genId())
        it.set('text', tx)
        it.set('done', m[1] !== ' ')
        arr.push([it])
        if (m[2]) tx.insert(0, m[2])
      }
      if (arr.length === 0) {
        const it = new Y.Map()
        it.set('id', genId())
        it.set('text', new Y.Text())
        it.set('done', false)
        arr.push([it])
      }
      n.set('items', arr)
      n.set('kind', 'todo')
    } else {
      const b = n.get('body')
      if (b.length) b.delete(0, b.length)
      if (bodyText) b.insert(0, bodyText, {})
      if (n.get('kind') === 'todo') n.set('kind', 'note')
      if (body2Text) {
        const b2 = n.get('body2') || ensureBody2(n)
        if (b2.length) b2.delete(0, b2.length)
        b2.insert(0, body2Text, {})
        n.set('layout', 'book')
      }
    }
    n.set('lastEditedAt', Date.now())
    n.set('lastEditedBy', { id: me.id, name: me.name })
  })
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
    a.style.setProperty('--c', p.user.color || '#888')
    a.textContent = initials(p.user.name || '?')
    a.title = p.self ? p.user.name + ' (you)' : p.user.name
    peopleEl.appendChild(a)
  }

  const byNote = new Map()
  for (const [cid, st] of states) {
    if (cid === doc.clientID || !st || !st.focus || !st.user) continue
    if (!byNote.has(st.focus)) byNote.set(st.focus, [])
    byNote.get(st.focus).push(st.user)
  }
  for (const [id, card] of cards) {
    const editors = byNote.get(id) || []
    card.el.classList.toggle('active', editors.length > 0)
    card.presenceEl.innerHTML = ''
    editors.slice(0, 4).forEach((u) => {
      const d = document.createElement('span')
      d.className = 'editor-dot'
      d.style.setProperty('--c', u.color || '#888')
      d.title = u.name + ' is editing'
      d.textContent = initials(u.name || '?')
      card.presenceEl.appendChild(d)
    })
  }
}

awareness.on('change', renderPresence)

// ---- search filter (scoped to the visible tab) ----
function applyFilter() {
  const q = search.value.trim().toLowerCase()
  for (const [id, card] of cards) {
    if (!q) {
      card.el.classList.remove('hidden')
      continue
    }
    const n = yNotes.get(id)
    if (!n) continue
    card.el.classList.toggle('hidden', !noteHay(n).includes(q))
  }
}
search.addEventListener('input', applyFilter)

// ---- toolbar actions ----
addBtn.addEventListener('click', () => {
  const id = createNote(PAPER[Math.floor(Math.random() * 4)])
  requestAnimationFrame(() => cards.get(id)?.titleEl.focus())
})

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

function openSettingsMenu(anchor) {
  closeMenus()
  const st = getSettings()
  const menu = document.createElement('div')
  menu.className = 'menu settings-menu'
  menu.addEventListener('click', (e) => e.stopPropagation())
  const r = anchor.getBoundingClientRect()
  menu.style.top = r.bottom + 6 + 'px'
  menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px'
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
  head('Just for this device')
  check('Spell-check underline', 'spellcheck', 'Red squiggles in notes')
  check('Smart arrows', 'arrows', '-> becomes →, -- becomes —')
  check('Keep an offline copy', 'offline', 'The board opens even with the Pi off')
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

  head('Backup')
  const link = (label, href) => {
    const a = document.createElement('a')
    a.className = 'menu-item'
    a.href = href
    a.textContent = label
    a.addEventListener('click', () => closeMenus())
    menu.appendChild(a)
  }
  link('⬇  Download all notes (Markdown)', '/api/export.md')
  link('⬇  Download all notes (JSON)', '/api/export.json')
  const note = document.createElement('div')
  note.className = 'menu-note'
  note.textContent = 'The Pi also keeps a readable copy in data/export/ with full history.'
  menu.appendChild(note)

  document.body.appendChild(menu)
  openMenus.push(menu)
}

onSettingChange((key, value) => {
  if (key === 'spellcheck') {
    for (const [, c] of cards) {
      c.titleEl.spellcheck = value
      if (c.body && c.body.editors) c.body.editors.forEach((r) => r.setSpellcheck(value))
      c.el.querySelectorAll('.todo-text').forEach((i) => (i.spellcheck = value))
    }
  } else if (key === 'offline') applyOfflineSetting()
})

// Keep relative timestamps fresh.
setInterval(() => {
  for (const [, card] of cards) card.setMeta()
}, 60000)

// Run the one-time migration only after the server's state has arrived, so we
// never race a populated board into a duplicate default tab. If we never reach
// the server (offline first run), seed a tab after a short grace period.
provider.onSync(() => {
  migrateBoard()
  // deep link: #note=<id> opens that note's tab and flashes it
  const m = /#note=([A-Za-z0-9_-]+)/.exec(location.hash)
  if (m) goToNote(m[1], { unarchive: false })
})
awareness.setLocalStateField('tab', activeTabId)
window.addEventListener('hashchange', () => {
  const m = /#note=([A-Za-z0-9_-]+)/.exec(location.hash)
  if (m) goToNote(m[1], { unarchive: false })
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
