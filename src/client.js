import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

import { bindRichText } from './richbody.js'
import { createDrawSurface } from './draw.js'
import {
  genId,
  clamp,
  relTime,
  initials,
  PAPER,
  PRESENCE,
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
const yTabs = doc.getArray('tabs') // [{ id, name, kind }, ...]
const yDrawings = doc.getMap('drawings') // tabId -> Y.Array<stroke>

const SIZES = { s: 'size-s', m: 'size-m', l: 'size-l' }
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
  const name = (window.prompt('Pick a name (so friends know who is typing):', '') || 'Anon')
    .trim()
    .slice(0, 24) || 'Anon'
  me = { name, color: PRESENCE[Math.floor(Math.random() * PRESENCE.length)] }
  localStorage.setItem('notesUser', JSON.stringify(me))
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

provider.onStatus((connected) => {
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

function tabsList() {
  return yTabs.toArray()
}
function tabIndex(id) {
  return tabsList().findIndex((t) => t && t.id === id)
}
function activeTab() {
  const list = tabsList()
  if (list.length === 0) return null
  const found = list.find((t) => t && t.id === activeTabId)
  return found || list[0]
}
function setActiveTab(id) {
  activeTabId = id
  try {
    localStorage.setItem('notesActiveTab', id)
  } catch {
    /* ignore */
  }
  scheduleReconcile()
}

// One-time migration: make sure a tab exists and legacy notes land in it.
function ensureDefaultTab() {
  if (yTabs.length > 0) return
  doc.transact(() => {
    if (yTabs.length > 0) return
    const id = genId()
    yTabs.push([{ id, name: 'Ideas', kind: 'notes' }])
    yNotes.forEach((n) => {
      if (!n.get('tabId')) n.set('tabId', id)
    })
  })
}

// ---- tab operations ----
function addTab(kind) {
  const label = kind === 'draw' ? 'Sketch' : 'List'
  const name = (window.prompt(`Name this ${label.toLowerCase()} tab:`, label) || label).trim().slice(0, 28)
  if (!name) return
  const id = genId()
  doc.transact(() => {
    yTabs.push([{ id, name, kind }])
  })
  setActiveTab(id)
}

function renameTab(id) {
  const i = tabIndex(id)
  if (i < 0) return
  const t = yTabs.get(i)
  const name = (window.prompt('Rename tab:', t.name) || t.name).trim().slice(0, 28)
  if (!name || name === t.name) return
  doc.transact(() => {
    yTabs.delete(i, 1)
    yTabs.insert(i, [{ ...t, name }])
  })
}

function deleteTab(id) {
  const list = tabsList()
  if (list.length <= 1) {
    window.alert('Keep at least one tab.')
    return
  }
  const t = list.find((x) => x.id === id)
  if (!t) return
  const kindWord = t.kind === 'draw' ? 'sketch and all its strokes' : 'tab and all its notes'
  if (!window.confirm(`Delete "${t.name}"? This removes the ${kindWord} for everyone.`)) return
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
  const remaining = tabsList()
  setActiveTab(remaining[Math.max(0, Math.min(i, remaining.length - 1))].id)
}

function moveTab(fromId, toId) {
  if (fromId === toId) return
  const from = tabIndex(fromId)
  if (from < 0) return
  const t = yTabs.get(from)
  doc.transact(() => {
    yTabs.delete(from, 1)
    let to = tabIndex(toId) // target index after the removal
    if (to < 0) to = yTabs.length
    yTabs.insert(clamp(to, 0, yTabs.length), [t])
  })
}

// ---- tab bar rendering ----
let dragTabId = null
function renderTabs() {
  const list = tabsList()
  const active = activeTab()
  tabsEl.innerHTML = ''
  for (const t of list) {
    const isActive = active && t.id === active.id
    const tab = document.createElement('div')
    tab.className = 'tab' + (isActive ? ' on' : '')
    tab.draggable = true
    tab.dataset.id = t.id

    const icon = document.createElement('span')
    icon.className = 'tab-icon'
    icon.textContent = t.kind === 'draw' ? '✎' : '☰' // pencil / list
    const label = document.createElement('span')
    label.className = 'tab-name'
    label.textContent = t.name
    tab.append(icon, label)

    if (isActive && list.length > 1) {
      const close = document.createElement('button')
      close.className = 'tab-x'
      close.textContent = '×'
      close.title = 'Delete tab'
      close.addEventListener('click', (e) => {
        e.stopPropagation()
        deleteTab(t.id)
      })
      tab.appendChild(close)
    }

    tab.addEventListener('click', () => setActiveTab(t.id))
    tab.addEventListener('dblclick', (e) => {
      e.preventDefault()
      renameTab(t.id)
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
document.addEventListener('click', closeMenus)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMenus()
    closeAllPopovers()
  }
})

// ---- note operations ----
function createNote(color) {
  const id = genId()
  const active = activeTab()
  doc.transact(() => {
    const n = new Y.Map()
    n.set('title', new Y.Text())
    n.set('body', new Y.Text())
    n.set('color', color || PAPER[0])
    n.set('created', Date.now())
    n.set('tabId', active ? active.id : null)
    n.set('fontSize', FS_DEFAULT)
    n.set('size', 'm')
    yNotes.set(id, n)
    yOrder.unshift([id])
  })
  return id
}

function deleteNote(id) {
  doc.transact(() => {
    const arr = yOrder.toArray()
    const i = arr.indexOf(id)
    if (i >= 0) yOrder.delete(i, 1)
    yNotes.delete(id)
  })
}

function belongsToActive(note, active) {
  if (!active) return true
  const tid = note.get('tabId')
  if (!tid) return active.id === (tabsList()[0] && tabsList()[0].id)
  return tid === active.id
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
  for (const cls of Object.values(SIZES)) el.classList.remove(cls)
  el.classList.add(SIZES[note.get('size')] || SIZES.m)
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

  const optBtn = document.createElement('button')
  optBtn.className = 'icon-btn opt'
  optBtn.title = 'Colour, size & text'
  optBtn.innerHTML = '&#9881;'

  const del = document.createElement('button')
  del.className = 'icon-btn del'
  del.title = 'Delete note'
  del.textContent = '×'
  del.addEventListener('click', () => {
    if (window.confirm('Delete this note for everyone?')) deleteNote(id)
  })

  tools.append(optBtn, del)
  top.append(presenceEl, tools)

  const titleEl = document.createElement('input')
  titleEl.className = 'card-title'
  titleEl.placeholder = 'Title'
  titleEl.maxLength = 120

  // formatting toolbar (appears while the note is focused)
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
      rich.toggleMark(mark)
    })
    fmt.appendChild(b)
    fmtBtns[mark] = b
  })

  const bodyEl = document.createElement('div')
  bodyEl.className = 'card-body'
  bodyEl.setAttribute('data-ph', 'Take a note…')

  const meta = document.createElement('div')
  meta.className = 'card-meta'
  const timeEl = document.createElement('span')
  timeEl.textContent = relTime(note.get('created') || Date.now())
  meta.appendChild(timeEl)

  el.append(top, titleEl, fmt, bodyEl, meta)

  applyNoteStyle(el, note)

  // bindings
  const unbinds = []
  unbinds.push(bindInput(note.get('title'), titleEl, () => applyFilter()))
  const rich = bindRichText(note.get('body'), bodyEl, {
    onChange: () => applyFilter(),
    onState: (marks) => {
      for (const m of ['b', 'i', 'u', 's']) fmtBtns[m].classList.toggle('on', !!marks[m])
    },
  })

  optBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    togglePopover(card)
  })

  const focusOn = () => awareness.setLocalStateField('focus', id)
  const focusOff = () => {
    if (awareness.getLocalState()?.focus === id) awareness.setLocalStateField('focus', null)
  }
  titleEl.addEventListener('focus', focusOn)
  bodyEl.addEventListener('focus', focusOn)
  titleEl.addEventListener('blur', focusOff)
  bodyEl.addEventListener('blur', focusOff)

  const noteObs = (e) => {
    if (!e.keysChanged) return
    if (
      e.keysChanged.has('color') ||
      e.keysChanged.has('fontSize') ||
      e.keysChanged.has('size')
    ) {
      applyNoteStyle(el, note)
      if (card.pop) refreshPopover(card)
    }
    if (e.keysChanged.has('tabId')) scheduleReconcile()
  }
  note.observe(noteObs)

  const card = { el, unbinds, rich, titleEl, bodyEl, presenceEl, timeEl, note, noteObs, id, pop: null }
  return card
}

function destroyCard(card) {
  card.unbinds.forEach((fn) => fn())
  card.rich.destroy()
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
  card.pop.classList.add('open')
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
    b.addEventListener('click', () => card.note.set('size', k))
    wRow.appendChild(b)
    sizeBtns[k] = b
  })
  wSec.append(wRow)

  pop.append(cSec, tSec, wSec)
  card.el.appendChild(pop)
  card.pop = pop
  card.popRefs = { colorInput, favWrap, fsVal, sizeBtns }
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
  const { colorInput, fsVal, sizeBtns } = card.popRefs
  colorInput.value = normalizeHex(card.note.get('color') || PAPER[0])
  fsVal.textContent = (card.note.get('fontSize') || FS_DEFAULT) + 'px'
  const sz = card.note.get('size') || 'm'
  for (const k of Object.keys(sizeBtns)) sizeBtns[k].classList.toggle('on', k === sz)
  renderFavs(card)
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

function buildDrawBar(surface) {
  drawBar.innerHTML = ''

  const color = document.createElement('input')
  color.type = 'color'
  color.className = 'draw-color'
  color.value = normalizeHex(drawTool.color)
  color.title = 'Pen colour'
  color.addEventListener('input', () => {
    drawTool.color = color.value
    drawTool.mode = 'pen'
    surface.setColor(color.value)
    surface.setMode('pen')
    saveDrawTool()
    syncDrawBar()
  })

  const width = document.createElement('input')
  width.type = 'range'
  width.min = '1'
  width.max = '40'
  width.value = String(drawTool.width)
  width.className = 'draw-width'
  width.title = 'Pen size'
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

  const eraseBtn = drawBtn('⌫ Eraser', () => {
    drawTool.mode = 'erase'
    surface.setMode('erase')
    syncDrawBar()
  })
  eraseBtn.dataset.mode = 'erase'

  const undoBtn = drawBtn('↶ Undo', () => surface.undoLast())
  const clearBtn = drawBtn('Clear', () => {
    if (window.confirm('Clear the whole sketch for everyone?')) surface.clear()
  })
  clearBtn.classList.add('danger')

  drawBar.append(color, width, penBtn, eraseBtn, undoBtn, clearBtn)
  drawBar._modeBtns = [penBtn, eraseBtn]
  syncDrawBar()
}

function syncDrawBar() {
  if (!drawBar._modeBtns) return
  for (const b of drawBar._modeBtns) b.classList.toggle('on', b.dataset.mode === drawTool.mode)
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
  renderTabs()
  renderPresence()
  applyFilter()
}

yOrder.observe(scheduleReconcile)
yNotes.observe(scheduleReconcile)
yTabs.observe(scheduleReconcile)

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
    const hay = (n.get('title').toString() + ' ' + n.get('body').toString()).toLowerCase()
    card.el.classList.toggle('hidden', !hay.includes(q))
  }
}
search.addEventListener('input', applyFilter)

// ---- toolbar actions ----
addBtn.addEventListener('click', () => {
  const id = createNote(PAPER[Math.floor(Math.random() * 4)])
  requestAnimationFrame(() => cards.get(id)?.titleEl.focus())
})

document.getElementById('rename').addEventListener('click', () => {
  const name = (window.prompt('Display name:', me.name) || me.name).trim().slice(0, 24)
  if (!name) return
  me = { ...me, name }
  localStorage.setItem('notesUser', JSON.stringify(me))
  awareness.setLocalStateField('user', me)
  youName.textContent = me.name
})

// Keep relative timestamps fresh.
setInterval(() => {
  for (const [id, card] of cards) {
    const n = yNotes.get(id)
    if (n) card.timeEl.textContent = relTime(n.get('created') || Date.now())
  }
}, 60000)

// Run the one-time migration only after the server's state has arrived, so we
// never race a populated board into a duplicate default tab. If we never reach
// the server (offline first run), seed a tab after a short grace period.
provider.onSync(ensureDefaultTab)
setTimeout(() => {
  if (!provider.synced) ensureDefaultTab()
}, 2500)
reconcile()
