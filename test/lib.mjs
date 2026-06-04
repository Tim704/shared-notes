import { WebSocket } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

export function connect(url) {
  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'

  const send = (m) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(m)
  }

  doc.on('update', (update, origin) => {
    if (origin === 'srv') return
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MESSAGE_SYNC)
    syncProtocol.writeUpdate(enc, update)
    send(encoding.toUint8Array(enc))
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
    send(encoding.toUint8Array(enc))
  })

  const ready = new Promise((resolve) => {
    ws.on('open', () => {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MESSAGE_SYNC)
      syncProtocol.writeSyncStep1(enc, doc)
      send(encoding.toUint8Array(enc))
      resolve()
    })
  })

  ws.on('message', (data) => {
    const decoder = decoding.createDecoder(new Uint8Array(data))
    const type = decoding.readVarUint(decoder)
    if (type === MESSAGE_SYNC) {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MESSAGE_SYNC)
      syncProtocol.readSyncMessage(decoder, enc, doc, 'srv')
      if (encoding.length(enc) > 1) send(encoding.toUint8Array(enc))
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        awareness,
        decoding.readVarUint8Array(decoder),
        'remote'
      )
    }
  })

  return { doc, awareness, ws, ready, close: () => ws.close() }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
