// Shared Notes server.
// - Serves the static client from /public
// - Runs a WebSocket endpoint at /ws that syncs a single shared Yjs document
//   (the board) using the standard y-protocols sync + awareness messages.
// - Persists the board to data/board.bin (pure JS, no native deps so it builds
//   cleanly on a Raspberry Pi).
// - Mirrors the board to data/export/ as Markdown (+ git history when git is
//   installed), serves a small JSON API under /api, purges old trash, and can
//   optionally sit behind a shared password (NOTES_PASSWORD). See server/*.js.

import express from 'express'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { createMirror } from './server/mirror.js'
import { initHistory, scheduleCommit } from './server/history.js'
import { createApi } from './server/api.js'
import { createAuth } from './server/auth.js'
import { createMedia, referencedMedia } from './server/media.js'
import { migrateLegacyTodos } from './shared/migrate.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3000)
const HOST = process.env.HOST || '0.0.0.0'
const DATA_DIR = process.env.NOTES_DATA_DIR
  ? path.resolve(process.env.NOTES_DATA_DIR)
  : path.join(__dirname, 'data')
const DATA_FILE = path.join(DATA_DIR, 'board.bin')
const EXPORT_DIR = process.env.NOTES_EXPORT_DIR
  ? path.resolve(process.env.NOTES_EXPORT_DIR)
  : path.join(DATA_DIR, 'export')
const MIRROR_MS = Number(process.env.NOTES_MIRROR_MS) > 0 ? Number(process.env.NOTES_MIRROR_MS) : 3000
const COMMIT_MS = Number(process.env.NOTES_COMMIT_MS) > 0 ? Number(process.env.NOTES_COMMIT_MS) : 60000
const TRASH_DAYS = Number(process.env.NOTES_TRASH_DAYS) >= 0 ? Number(process.env.NOTES_TRASH_DAYS) : 30
const MEDIA_DIR = process.env.NOTES_MEDIA_DIR
  ? path.resolve(process.env.NOTES_MEDIA_DIR)
  : path.join(DATA_DIR, 'media')
const MEDIA_MAX_MB = Number(process.env.NOTES_MEDIA_MAX_MB) > 0 ? Number(process.env.NOTES_MEDIA_MAX_MB) : 8
const HISTORY_ENABLED = process.env.NOTES_HISTORY !== '0'
const PASSWORD = process.env.NOTES_PASSWORD || ''
fs.mkdirSync(DATA_DIR, { recursive: true })

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const HEARTBEAT_MS = 30000
const SAVE_DEBOUNCE_MS = 1500
const PURGE_INTERVAL_MS = 60 * 60 * 1000

// ---- the single shared board document ----------------------------------
const ydoc = new Y.Doc()
if (fs.existsSync(DATA_FILE)) {
  try {
    Y.applyUpdate(ydoc, fs.readFileSync(DATA_FILE))
    console.log('Loaded board from', DATA_FILE)
  } catch (err) {
    console.error('Could not load saved board:', err.message)
  }
}

const awareness = new awarenessProtocol.Awareness(ydoc)
awareness.setLocalState(null) // the server itself is not a participant

// Whole-note checklists from older versions become notes made of todo lines.
// Done here, on the one server, so two browsers never both migrate a note.
// Runs at boot and again shortly after any change that brings an old one in
// (an old client, an IndexedDB copy from before the upgrade, the API).
function runMigrations() {
  try {
    const n = migrateLegacyTodos(ydoc)
    if (n) console.log(`Migrated ${n} checklist note(s) to todo lines`)
  } catch (err) {
    console.error('Migration failed:', err.message)
  }
}
runMigrations()
let migrateTimer = null
function scheduleMigrations() {
  if (migrateTimer) return
  migrateTimer = setTimeout(() => {
    migrateTimer = null
    runMigrations()
  }, 150)
}

/** @type {Set<import('ws').WebSocket>} */
const conns = new Set()
/** Track which awareness client ids each connection owns, so we can clear them on disconnect. */
const controlled = new Map() // conn -> Set<number>

function send(conn, message) {
  if (conn.readyState !== conn.OPEN) return
  try {
    conn.send(message)
  } catch {
    /* the socket is going away; ignore */
  }
}

let saveTimer = null
function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      fs.writeFileSync(DATA_FILE, Y.encodeStateAsUpdate(ydoc))
    } catch (err) {
      console.error('Save failed:', err.message)
    }
  }, SAVE_DEBOUNCE_MS)
}

// Broadcast document updates to every peer except the one that produced them.
ydoc.on('update', (update, origin) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeUpdate(encoder, update)
  const message = encoding.toUint8Array(encoder)
  conns.forEach((conn) => {
    if (conn !== origin) send(conn, message)
  })
  scheduleSave()
  mirror.schedule()
  if (origin !== 'migrate') scheduleMigrations()
})

// ---- markdown mirror + git history ---------------------------------------
// Regenerated a few seconds after the last change; history commits a while
// after each mirror write. Both are best-effort and log rather than throw.
const mirror = createMirror({
  ydoc,
  exportDir: EXPORT_DIR,
  debounceMs: MIRROR_MS,
  onWritten: () => scheduleCommit(),
  // pictures are linked from the note files (which sit one folder down)
  mediaPrefix: path.relative(path.join(EXPORT_DIR, 'tab'), MEDIA_DIR).split(path.sep).join('/') + '/',
})
initHistory({ exportDir: EXPORT_DIR, enabled: HISTORY_ENABLED, commitMs: COMMIT_MS })
  .catch((err) => console.error('History setup failed:', err.message))
  .then(() => mirror.schedule()) // first mirror (and, with git, a baseline commit) shortly after boot

// ---- trash purge -----------------------------------------------------------
// Notes carry `deleted: <ms>` while in the trash. Anything older than
// NOTES_TRASH_DAYS is removed for good, on boot and then hourly.
function purgeTrash() {
  try {
    const cutoff = Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000
    const yNotes = ydoc.getMap('notes')
    const yOrder = ydoc.getArray('order')
    const gone = []
    yNotes.forEach((note, id) => {
      if (!note || typeof note.get !== 'function') return
      const deleted = note.get('deleted')
      if (typeof deleted === 'number' && deleted < cutoff) gone.push(id)
    })
    if (gone.length) {
      const goneSet = new Set(gone)
      const yEdges = ydoc.getArray('edges')
      ydoc.transact(() => {
        gone.forEach((id) => yNotes.delete(id))
        // walk backwards so indexes stay valid while deleting
        for (let i = yOrder.length - 1; i >= 0; i--) {
          if (goneSet.has(yOrder.get(i))) yOrder.delete(i, 1)
        }
        for (let i = yEdges.length - 1; i >= 0; i--) {
          const e = yEdges.get(i)
          const get = e && typeof e.get === 'function' ? (k) => e.get(k) : (k) => e && e[k]
          if (goneSet.has(get('from')) || goneSet.has(get('to'))) yEdges.delete(i, 1)
        }
      }, 'purge')
      console.log(`Trash: purged ${gone.length} note(s) deleted more than ${TRASH_DAYS} day(s) ago`)
    }
  } catch (err) {
    console.error('Trash purge failed:', err.message)
  }
  // pictures no note mentions any more (trash included), once past the trash window
  media
    .sweep(referencedMedia(ydoc), Math.max(1, TRASH_DAYS) * 24 * 60 * 60 * 1000)
    .then((n) => n && console.log(`Media: removed ${n} unused picture(s)`))
    .catch((err) => console.error('Media sweep failed:', err.message))
}
const media = createMedia({ mediaDir: MEDIA_DIR, maxBytes: MEDIA_MAX_MB * 1024 * 1024 })
purgeTrash()
const purgeTimer = setInterval(purgeTrash, PURGE_INTERVAL_MS)
purgeTimer.unref()

// Broadcast and bookkeep awareness (presence) changes.
awareness.on('update', ({ added, updated, removed }, origin) => {
  const changed = added.concat(updated, removed)

  if (origin && controlled.has(origin)) {
    const owned = controlled.get(origin)
    added.forEach((id) => owned.add(id))
    removed.forEach((id) => owned.delete(id))
  }

  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, changed)
  )
  const message = encoding.toUint8Array(encoder)
  conns.forEach((conn) => send(conn, message))
})

// ---- http + websocket ---------------------------------------------------
const app = express()
const auth = createAuth(PASSWORD)
if (auth.enabled) console.log('Password protection is ON (NOTES_PASSWORD is set)')
app.get('/health', (_req, res) => res.json({ ok: true, peers: conns.size }))
app.use(auth.router) // /login (no-op when no password is set)
app.use(auth.middleware) // gate everything below (no-op when no password is set)
app.use('/api/media', media.router)
app.use('/media', media.files)
app.use('/api', createApi({ ydoc }))
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }))

const server = http.createServer(app)
// noServer so we can check the password cookie before completing the handshake
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  let pathname = ''
  try {
    pathname = new URL(req.url, 'http://localhost').pathname
  } catch {
    /* fall through: not /ws */
  }
  const reject = (code, text) => {
    try {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    } catch {
      /* the socket is already gone */
    }
    socket.destroy()
  }
  if (pathname !== '/ws') return reject(404, 'Not Found')
  if (!auth.isAuthed(req)) return reject(401, 'Unauthorized')
  wss.handleUpgrade(req, socket, head, (conn) => wss.emit('connection', conn, req))
})

wss.on('connection', (conn) => {
  conn.binaryType = 'arraybuffer'
  conn.isAlive = true
  conns.add(conn)
  controlled.set(conn, new Set())

  // 1) Ask the client for its state and offer ours.
  {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoder, ydoc)
    send(conn, encoding.toUint8Array(encoder))
  }
  // 2) Send everyone's current presence to the newcomer.
  {
    const states = awareness.getStates()
    if (states.size > 0) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(states.keys()))
      )
      send(conn, encoding.toUint8Array(encoder))
    }
  }

  conn.on('pong', () => {
    conn.isAlive = true
  })

  conn.on('message', (data) => {
    try {
      const decoder = decoding.createDecoder(new Uint8Array(data))
      const messageType = decoding.readVarUint(decoder)
      if (messageType === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        // origin = conn so our update handler can skip echoing back.
        syncProtocol.readSyncMessage(decoder, encoder, ydoc, conn)
        if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder))
      } else if (messageType === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(
          awareness,
          decoding.readVarUint8Array(decoder),
          conn
        )
      }
    } catch (err) {
      console.error('Bad message:', err.message)
    }
  })

  const cleanup = () => {
    conns.delete(conn)
    const owned = controlled.get(conn)
    controlled.delete(conn)
    if (owned && owned.size) {
      awarenessProtocol.removeAwarenessStates(awareness, Array.from(owned), null)
    }
  }
  conn.on('close', cleanup)
  conn.on('error', cleanup)
})

// Drop dead connections so presence stays accurate.
const heartbeat = setInterval(() => {
  wss.clients.forEach((conn) => {
    if (conn.isAlive === false) {
      conn.terminate()
      return
    }
    conn.isAlive = false
    try {
      conn.ping()
    } catch {
      /* ignore */
    }
  })
}, HEARTBEAT_MS)
wss.on('close', () => clearInterval(heartbeat))

server.listen(PORT, HOST, () => {
  console.log(`Shared Notes running on http://${HOST}:${PORT}`)
  console.log('Open it on any device on your network using the Pi\'s IP, e.g. http://192.168.1.x:' + PORT)
})

// ---- save on shutdown ---------------------------------------------------
let closing = false
function shutdown() {
  if (closing) return
  closing = true
  try {
    fs.writeFileSync(DATA_FILE, Y.encodeStateAsUpdate(ydoc))
    console.log('Board saved. Bye.')
  } catch (err) {
    console.error('Final save failed:', err.message)
  }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
