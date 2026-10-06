import * as Y from 'yjs'
import { connect, sleep } from './lib.mjs'
import { linesOf } from '../shared/lines.js'

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

// --- corkboard: note position/size fields sync ---
A.doc.transact(() => {
  const n = A.doc.getMap('notes').get(id)
  n.set('x', 120)
  n.set('y', 80)
  n.set('w', 300)
  n.set('h', 220)
  n.set('z', 5)
})
await sleep(200)
const bpos = B.doc.getMap('notes').get(id)
check('B note carries x/y', bpos.get('x') === 120 && bpos.get('y') === 80)
check('B note carries w/h/z', bpos.get('w') === 300 && bpos.get('h') === 220 && bpos.get('z') === 5)

// --- checklist note: kind + items (text + done) ---
const todoId = 'note_' + Math.random().toString(36).slice(2, 8)
A.doc.transact(() => {
  const n = new Y.Map()
  n.set('title', new Y.Text())
  n.set('body', new Y.Text())
  n.set('color', '#caffbf')
  n.set('created', Date.now())
  n.set('tabId', tabId)
  n.set('kind', 'todo')
  const items = new Y.Array()
  n.set('items', items)
  const it = new Y.Map()
  const t = new Y.Text()
  it.set('id', 'i1')
  it.set('text', t)
  it.set('done', false)
  items.push([it])
  t.insert(0, 'Buy milk')
  A.doc.getMap('notes').set(todoId, n)
  A.doc.getArray('order').unshift([todoId])
})
await sleep(700) // the server migrates old whole-note checklists to todo lines
const bTodo = B.doc.getMap('notes').get(todoId)
check('server migrated the checklist note to kind=note', bTodo && bTodo.get('kind') === 'note' && bTodo.get('migratedTodo') === true)
const bLines = linesOf(bTodo.get('body'))
check(
  'B sees one todo line with its text and the item id',
  bLines.length === 1 && bLines[0].text === 'Buy milk' && bLines[0].attrs.lt === 'todo' && bLines[0].attrs.bid === 'i1'
)
check('B todo starts not done', !bLines[0].attrs.done)

// ticking is a format on the line break, and syncs
A.doc.transact(() => {
  const body = A.doc.getMap('notes').get(todoId).get('body')
  const L = linesOf(body)[0]
  body.format(L.start + L.len, 1, { done: true })
})
await sleep(200)
check('B sees the line ticked', linesOf(B.doc.getMap('notes').get(todoId).get('body'))[0].attrs.done === true)

// --- line model: lists, indent, alignment and headings live on the line breaks ---
const lineNote = 'note_' + Math.random().toString(36).slice(2, 8)
A.doc.transact(() => {
  const n = new Y.Map()
  const body = new Y.Text()
  n.set('title', new Y.Text())
  n.set('body', body)
  n.set('tabId', tabId)
  A.doc.getMap('notes').set(lineNote, n)
  A.doc.getArray('order').unshift([lineNote])
  body.insert(0, 'Plan', { b: true })
  body.insert(4, '\n', { lt: 'h', al: 'center' })
  body.insert(5, 'one', {})
  body.insert(8, '\n', { lt: 'li', mk: 'decimal', bid: 'x1' })
  body.insert(9, 'sub', {})
  body.insert(12, '\n', { lt: 'li', mk: 'alpha', ind: 1, bid: 'x2' })
  body.insert(13, 'buy', {})
  body.insert(16, '\n', { lt: 'todo', bid: 'x3' })
})
await sleep(200)
const bl = linesOf(B.doc.getMap('notes').get(lineNote).get('body'))
check('B sees four lines', bl.length === 4 && bl.map((l) => l.text).join('|') === 'Plan|one|sub|buy')
check('heading + centre alignment sync', bl[0].attrs.lt === 'h' && bl[0].attrs.al === 'center')
check('inline bold stays on the characters, not the line', bl[0].runs[0].marks.b === true && !bl[0].attrs.b)
check('numbered list + nested letters sync', bl[1].attrs.mk === 'decimal' && bl[2].attrs.mk === 'alpha' && bl[2].attrs.ind === 1)
check('a todo line sits among the others', bl[3].attrs.lt === 'todo' && bl[3].attrs.bid === 'x3')

// concurrent: A ticks the todo while B types into the first line
A.doc.transact(() => {
  const body = A.doc.getMap('notes').get(lineNote).get('body')
  const L = linesOf(body)[3]
  body.format(L.start + L.len, 1, { done: true })
})
B.doc.transact(() => B.doc.getMap('notes').get(lineNote).get('body').insert(4, '!', { b: true }))
await sleep(250)
const al = linesOf(A.doc.getMap('notes').get(lineNote).get('body'))
const bl2 = linesOf(B.doc.getMap('notes').get(lineNote).get('body'))
check('concurrent tick + typing converge', al[0].text === 'Plan!' && al[3].attrs.done === true && JSON.stringify(al) === JSON.stringify(bl2))

// --- connector arrows between notes ---
A.doc.transact(() => {
  const e = new Y.Map()
  e.set('id', 'e1')
  e.set('from', id)
  e.set('to', lineNote)
  e.set('label', 'leads to')
  e.set('style', 'dashed')
  A.doc.getArray('edges').push([e])
})
await sleep(200)
const be = B.doc.getArray('edges').toArray()
check('B sees the arrow', be.length === 1 && be[0].get('from') === id && be[0].get('label') === 'leads to')

// --- sketch text label syncs (lives alongside strokes) ---
A.doc.transact(() => {
  const strokes = A.doc.getMap('drawings').get(tabId)
  const t = new Y.Map()
  t.set('type', 'text')
  t.set('x', 200)
  t.set('y', 150)
  t.set('text', 'hello canvas')
  t.set('color', '#1f2228')
  t.set('size', 32)
  strokes.push([t])
})
await sleep(200)
const bDrawings = B.doc.getMap('drawings').get(tabId)
const bTextObj = bDrawings && bDrawings.get(bDrawings.length - 1)
check('B received a text object', bTextObj && bTextObj.get('type') === 'text')
check(
  'B text object carries text + position',
  bTextObj.get('text') === 'hello canvas' && bTextObj.get('x') === 200 && bTextObj.get('y') === 150
)

A.close()
B.close()
await sleep(150)

console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'))
process.exit(failures === 0 ? 0 : 1)
