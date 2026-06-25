import * as Y from 'yjs'
import { connect, sleep } from './lib.mjs'

// Exercises the v2 data model through the real server: tabs, per-note fields,
// rich-text formatting attributes, and collaborative drawing strokes all sync.
const PORT = process.env.PORT || 3805
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

// --- tabs sync (plain objects in a Y.Array) ---
const tabId = 'tab_' + Math.random().toString(36).slice(2, 8)
A.doc.transact(() => {
  A.doc.getArray('tabs').push([{ id: tabId, name: 'Ideas', kind: 'notes' }])
})
await sleep(200)
const bTabs = B.doc.getArray('tabs').toArray()
check('B received the tab', bTabs.length === 1 && bTabs[0].id === tabId)
check('B tab has name + kind', bTabs[0].name === 'Ideas' && bTabs[0].kind === 'notes')

// --- note with new fields (tabId, color, fontSize, size) ---
const id = 'note_' + Math.random().toString(36).slice(2, 8)
A.doc.transact(() => {
  const n = new Y.Map()
  n.set('title', new Y.Text())
  n.set('body', new Y.Text())
  n.set('color', '#bde0fe')
  n.set('created', Date.now())
  n.set('tabId', tabId)
  n.set('fontSize', 18)
  n.set('size', 'l')
  A.doc.getMap('notes').set(id, n)
  A.doc.getArray('order').unshift([id])
})
await sleep(200)
const bn = B.doc.getMap('notes').get(id)
check('B note carries tabId', bn && bn.get('tabId') === tabId)
check('B note carries fontSize/size', bn.get('fontSize') === 18 && bn.get('size') === 'l')

// --- rich-text formatting attributes survive sync ---
const aBody = A.doc.getMap('notes').get(id).get('body')
A.doc.transact(() => {
  aBody.insert(0, 'Hello', { b: true })
  aBody.insert(5, ' world', {}) // the binding always passes explicit attributes
})
await sleep(200)
const bDelta = B.doc.getMap('notes').get(id).get('body').toDelta()
check('B body text converged', B.doc.getMap('notes').get(id).get('body').toString() === 'Hello world')
check('B sees bold on first run', bDelta[0] && bDelta[0].attributes && bDelta[0].attributes.b === true)
check('B sees plain second run', bDelta[1] && (!bDelta[1].attributes || !bDelta[1].attributes.b))

// toggling bold off over a range removes the attribute
A.doc.transact(() => {
  aBody.format(0, 5, { b: null })
})
await sleep(200)
const bDelta2 = B.doc.getMap('notes').get(id).get('body').toDelta()
check('B sees bold removed (single plain run)', bDelta2.length === 1 && !(bDelta2[0].attributes && bDelta2[0].attributes.b))

// --- collaborative drawing strokes ---
A.doc.transact(() => {
  const strokes = new Y.Array()
  A.doc.getMap('drawings').set(tabId, strokes)
  const s = new Y.Map()
  const pts = new Y.Array()
  s.set('color', '#1f2228')
  s.set('width', 4)
  s.set('mode', 'pen')
  s.set('points', pts)
  pts.push([10, 10, 20, 25, 30, 40])
  strokes.push([s])
})
await sleep(200)
const bStrokes = B.doc.getMap('drawings').get(tabId)
check('B received a drawing array', bStrokes && bStrokes.length === 1)
const bPts = bStrokes && bStrokes.get(0).get('points').toArray()
check('B stroke has the points', JSON.stringify(bPts) === JSON.stringify([10, 10, 20, 25, 30, 40]))
check('B stroke carries mode/color', bStrokes.get(0).get('mode') === 'pen' && bStrokes.get(0).get('color') === '#1f2228')

// live append to an in-progress stroke streams across
A.doc.transact(() => {
  A.doc.getMap('drawings').get(tabId).get(0).get('points').push([55, 60])
})
await sleep(200)
const bPts2 = B.doc.getMap('drawings').get(tabId).get(0).get('points').toArray()
check('B sees streamed points', bPts2.length === 8 && bPts2[6] === 55 && bPts2[7] === 60)

A.close()
B.close()
await sleep(150)

console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'))
process.exit(failures === 0 ? 0 : 1)
