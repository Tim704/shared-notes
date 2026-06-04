import * as Y from 'yjs'
import { connect, sleep } from './lib.mjs'

const PORT = process.env.PORT || 3803
const URL = `ws://127.0.0.1:${PORT}/ws`
const mode = process.argv[2]

const c = connect(URL)
await c.ready
await sleep(300)

if (mode === 'write') {
  const id = 'persist_note'
  c.doc.transact(() => {
    const n = new Y.Map()
    const title = new Y.Text()
    title.insert(0, 'PERSIST')
    n.set('title', title)
    n.set('body', new Y.Text())
    n.set('color', '#caffbf')
    n.set('created', Date.now())
    c.doc.getMap('notes').set(id, n)
    c.doc.getArray('order').unshift([id])
  })
  await sleep(1900) // let the debounced disk save fire
  c.close()
  await sleep(100)
  console.log('wrote note')
  process.exit(0)
}

if (mode === 'read') {
  const notes = c.doc.getMap('notes')
  let found = false
  notes.forEach((n) => {
    if (n.get('title')?.toString() === 'PERSIST') found = true
  })
  console.log((found ? 'PASS' : 'FAIL') + '  note survived server restart')
  c.close()
  await sleep(100)
  process.exit(found ? 0 : 1)
}

console.log('unknown mode')
process.exit(2)
