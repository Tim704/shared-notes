#!/usr/bin/env node
// Take the password lock off a tab whose password is forgotten.
//
//   node tools/unlock-tab.mjs "Tab name"        (on the Pi: docker compose exec notes node tools/unlock-tab.mjs "Tab name")
//   node tools/unlock-tab.mjs                   lists the locked tabs
//
// It talks to the running server over its WebSocket, so open browsers see the
// change at once. PORT (default 3000) and NOTES_PASSWORD are read from the
// environment, the same ones the server uses.

import WebSocket from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { lockOf } from '../shared/locks.js'

const want = process.argv.slice(2).join(' ').trim().toLowerCase()
const port = process.env.PORT || 3000
const headers = process.env.NOTES_PASSWORD ? { Authorization: 'Bearer ' + process.env.NOTES_PASSWORD } : {}
const doc = new Y.Doc()
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers })
ws.binaryType = 'arraybuffer'
const send = (enc) => ws.send(encoding.toUint8Array(enc))
doc.on('update', (update, origin) => {
  if (origin === 'remote') return
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, 0)
  syncProtocol.writeUpdate(enc, update)
  send(enc)
})
let done = false
ws.on('open', () => {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, 0)
  syncProtocol.writeSyncStep1(enc, doc)
  send(enc)
})
ws.on('message', (data) => {
  const dec = decoding.createDecoder(new Uint8Array(data))
  if (decoding.readVarUint(dec) !== 0) return
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, 0)
  const type = syncProtocol.readSyncMessage(dec, enc, doc, 'remote')
  if (encoding.length(enc) > 1) send(enc)
  if (type !== 1 || done) return // 1 = the server's full state has arrived
  done = true
  const tabs = doc.getArray('tabs').toArray()
  const name = (t) => String((typeof t.get === 'function' ? t.get('name') : t.name) || '')
  const locked = tabs.filter((t) => lockOf(t))
  if (!want) {
    console.log(locked.length ? 'Locked tabs:\n' + locked.map((t) => '  ' + name(t)).join('\n') : 'No tab is locked.')
    return finish(0)
  }
  const hit = locked.filter((t) => name(t).trim().toLowerCase() === want)
  if (!hit.length) {
    console.error(`No locked tab is called "${process.argv.slice(2).join(' ')}".`)
    return finish(1)
  }
  doc.transact(() => {
    for (const t of hit) {
      if (typeof t.get === 'function') t.delete('lock')
    }
  })
  console.log(`Unlocked ${hit.length} tab${hit.length > 1 ? 's' : ''} called "${name(hit[0])}".`)
  setTimeout(() => finish(0), 400) // let the update leave
})
ws.on('error', (err) => {
  console.error('Could not reach the server on port ' + port + ': ' + err.message)
  process.exit(1)
})
function finish(code) {
  ws.close()
  process.exit(code)
}
