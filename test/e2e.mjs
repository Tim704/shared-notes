import * as Y from 'yjs'
import { connect, sleep } from './lib.mjs'

const PORT = process.env.PORT || 3801
const URL = `ws://127.0.0.1:${PORT}/ws`

let failures = 0
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name)
  if (!cond) failures++
}

const A = connect(URL)
const B = connect(URL)
await Promise.all([A.ready, B.ready])
await sleep(300)

// --- A creates a note; B should receive it ---
const id = 'note_' + Math.random().toString(36).slice(2, 8)
A.doc.transact(() => {
  const n = new Y.Map()
  n.set('title', new Y.Text())
  n.set('body', new Y.Text())
  n.set('color', '#fff7a8')
  n.set('created', Date.now())
  A.doc.getMap('notes').set(id, n)
  A.doc.getArray('order').unshift([id])
})
await sleep(250)

const bNotes = B.doc.getMap('notes')
const bOrder = B.doc.getArray('order')
check('B received the new note', bNotes.has(id))
check('B order has 1 entry', bOrder.length === 1 && bOrder.get(0) === id)

// --- live character-by-character text sync (typing) ---
const aTitle = A.doc.getMap('notes').get(id).get('title')
for (const ch of 'Groceries') {
  aTitle.insert(aTitle.length, ch)
  await sleep(8)
}
await sleep(200)
check('B sees A title text', bNotes.get(id).get('title').toString() === 'Groceries')

// --- concurrent edits from both ends to the body merge (CRDT) ---
const aBody = A.doc.getMap('notes').get(id).get('body')
const bBody = bNotes.get(id).get('body')
aBody.insert(0, 'milk\n')
bBody.insert(0, 'eggs\n')
await sleep(300)
check('A and B body converged', aBody.toString() === bBody.toString())
check('body kept both inserts', /milk/.test(aBody.toString()) && /eggs/.test(aBody.toString()))

// --- presence / awareness ---
A.awareness.setLocalState({ user: { name: 'Alice', color: '#ef4444' }, focus: id })
await sleep(200)
const peers = () =>
  Array.from(B.awareness.getStates().entries()).filter(([cid]) => cid !== B.doc.clientID)
const seenByB = peers().map(([, s]) => s)
check('B sees exactly one peer (excluding self)', peers().length === 1)
check('B sees Alice editing the note', seenByB.some((s) => s.user?.name === 'Alice' && s.focus === id))

// --- disconnect clears presence ---
A.close()
await sleep(400)
check('B presence cleared after A leaves', peers().length === 0)

B.close()
await sleep(100)

console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'))
process.exit(failures === 0 ? 0 : 1)
