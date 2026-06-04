import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

// ---------------------------------------------------------------------------
// Reconnecting WebSocket provider that speaks the y-protocols sync + awareness
// wire format used by the server. Kept tiny on purpose.
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

    doc.on('update', (update, origin) => {
      if (origin === this) return // this update came from the server already
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
      // Request the server's state...
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MESSAGE_SYNC)
      syncProtocol.writeSyncStep1(enc, this.doc)
      ws.send(encoding.toUint8Array(enc))
      // ...and re-announce our presence after a reconnect.
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
      syncProtocol.readSyncMessage(decoder, enc, this.doc, this) // origin = this
      if (encoding.length(enc) > 1) this.#send(encoding.toUint8Array(enc))
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
// Bind a Y.Text to an <input> or <textarea>. Local edits are diffed into the
// shared text; remote edits are applied to the element while keeping your
// caret/selection in the right place.
// ---------------------------------------------------------------------------
function bindText(ytext, el, afterRemote) {
  let applyingRemote = false
  el.value = ytext.toString()

  const observer = (event) => {
    if (event.transaction.local) return // our own edit; the DOM already has it
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
      /* element not focused / not selectable right now */
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
// App
// ---------------------------------------------------------------------------
const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'
const doc = new Y.Doc()
const awareness = new awarenessProtocol.Awareness(doc)
const provider = new WSProvider(wsUrl, doc, awareness)

const yNotes = doc.getMap('notes') // id -> Y.Map { title:Y.Text, body:Y.Text, color, created }
const yOrder = doc.getArray('order') // [id, ...] newest first

const PAPER = ['#fff7a8', '#ffd6a5', '#ffadad', '#a0e7e5', '#caffbf', '#d8c4ff', '#bde0fe', '#ffffff']
const PRESENCE = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']

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
const youName = document.getElementById('you-name')
youName.textContent = me.name
youName.style.setProperty('--me', me.color)

provider.onStatus((connected) => {
  dot.classList.toggle('on', connected)
  dot.title = connected ? 'Connected' : 'Reconnecting...'
})

// ---- note operations ----
function createNote(color) {
  const id = Math.random().toString(36).slice(2, 9) + Date.now().toString(36)
  doc.transact(() => {
    const n = new Y.Map()
    n.set('title', new Y.Text())
    n.set('body', new Y.Text())
    n.set('color', color || PAPER[0])
    n.set('created', Date.now())
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

function relTime(ts) {
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

// ---- card construction ----
const cards = new Map() // id -> { el, unbinds, titleEl, bodyEl, presenceEl, timeEl, note, noteObs }

function autoGrow(el) {
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 320) + 'px'
}

function createCard(id) {
  const note = yNotes.get(id)
  const el = document.createElement('article')
  el.className = 'card'
  el.dataset.id = id
  el.style.background = note.get('color') || PAPER[0]

  const top = document.createElement('div')
  top.className = 'card-top'

  const presenceEl = document.createElement('div')
  presenceEl.className = 'card-presence'

  const tools = document.createElement('div')
  tools.className = 'card-tools'

  const swatches = document.createElement('div')
  swatches.className = 'swatches'
  PAPER.forEach((c) => {
    const sw = document.createElement('button')
    sw.className = 'swatch'
    sw.style.background = c
    sw.title = 'Colour'
    sw.addEventListener('click', () => note.set('color', c))
    swatches.appendChild(sw)
  })

  const del = document.createElement('button')
  del.className = 'icon-btn del'
  del.title = 'Delete note'
  del.textContent = '\u00d7'
  del.addEventListener('click', () => {
    if (window.confirm('Delete this note for everyone?')) deleteNote(id)
  })

  tools.append(swatches, del)
  top.append(presenceEl, tools)

  const titleEl = document.createElement('input')
  titleEl.className = 'card-title'
  titleEl.placeholder = 'Title'
  titleEl.maxLength = 120

  const bodyEl = document.createElement('textarea')
  bodyEl.className = 'card-body'
  bodyEl.placeholder = 'Take a note...'
  bodyEl.rows = 1

  const meta = document.createElement('div')
  meta.className = 'card-meta'
  const timeEl = document.createElement('span')
  timeEl.textContent = relTime(note.get('created') || Date.now())
  meta.appendChild(timeEl)

  el.append(top, titleEl, bodyEl, meta)

  const unbinds = []
  unbinds.push(bindText(note.get('title'), titleEl, () => applyFilter()))
  unbinds.push(
    bindText(note.get('body'), bodyEl, () => {
      autoGrow(bodyEl)
      applyFilter()
    })
  )

  const focusOn = () => awareness.setLocalStateField('focus', id)
  const focusOff = () => {
    if (awareness.getLocalState()?.focus === id) awareness.setLocalStateField('focus', null)
  }
  titleEl.addEventListener('focus', focusOn)
  bodyEl.addEventListener('focus', focusOn)
  titleEl.addEventListener('blur', focusOff)
  bodyEl.addEventListener('blur', focusOff)
  bodyEl.addEventListener('input', () => autoGrow(bodyEl))

  // React to colour changes from anyone.
  const noteObs = (e) => {
    if (e.keysChanged && e.keysChanged.has('color')) {
      el.style.background = note.get('color')
    }
  }
  note.observe(noteObs)

  const card = { el, unbinds, titleEl, bodyEl, presenceEl, timeEl, note, noteObs }
  requestAnimationFrame(() => autoGrow(bodyEl))
  return card
}

function destroyCard(card) {
  card.unbinds.forEach((fn) => fn())
  card.note.unobserve(card.noteObs)
  card.el.remove()
}

// ---- reconcile board with shared state ----
function reconcile() {
  const order = yOrder.toArray().filter((id) => yNotes.has(id))
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
  renderPresence()
  applyFilter()
}

yOrder.observe(reconcile)
yNotes.observe(reconcile)

// ---- presence rendering ----
function initials(name) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

function renderPresence() {
  const states = awareness.getStates()

  // Top bar: everyone online (self included).
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

  // Per note: who is focused there right now.
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

// ---- search filter ----
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
document.getElementById('add').addEventListener('click', () => {
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

// First paint.
reconcile()
