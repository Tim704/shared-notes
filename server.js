// Shared Notes server.
// - Serves the static client from /public
// - Runs a WebSocket endpoint at /ws that syncs a single shared Yjs document
//   (the board) using the standard y-protocols sync + awareness messages.
// - Persists the board to data/board.bin (pure JS, no native deps so it builds
//   cleanly on a Raspberry Pi).

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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3000)
const HOST = process.env.HOST || '0.0.0.0'
const DATA_DIR = path.join(__dirname, 'data')
const DATA_FILE = path.join(DATA_DIR, 'board.bin')
fs.mkdirSync(DATA_DIR, { recursive: true })

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const HEARTBEAT_MS = 30000
const SAVE_DEBOUNCE_MS = 1500

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
})

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
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }))
app.get('/health', (_req, res) => res.json({ ok: true, peers: conns.size }))

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

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
