import * as Y from 'yjs'
import { connect, sleep } from './lib.mjs'
import { linesOf } from '../shared/lines.js'
import { tabRec, buildMirror, exportMarkdown } from '../shared/serialise.js'
import { smoothPoint, simplify } from '../src/stroke.js'
import { taskTree, progress, dueState, dueLabel, dueCount, orderBetween } from '../shared/tasks.js'
import { mapTree, layoutMap, fromOutline, mapMarkdown, branchToTasks } from '../shared/mindmap.js'
import { outlineTree } from '../shared/lines.js'
import { referencedMedia } from '../server/media.js'

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

// --- document / mind map tabs and ink: shared data and the Markdown mirror ---
{
  const ydoc = new Y.Doc()
  const docId = 'doc_tab'
  const mapId = 'map_tab'
  const notesId = 'notes_tab'
  ydoc.transact(() => {
    const tabs = ydoc.getArray('tabs')
    for (const [id, name, kind] of [[notesId, 'Board', 'notes'], [docId, 'Essay', 'doc'], [mapId, 'Plans', 'mindmap']]) {
      const t = new Y.Map()
      t.set('id', id)
      t.set('name', name)
      t.set('kind', kind)
      tabs.push([t])
    }
    const page = (title, body) => {
      const p = new Y.Map()
      const tt = new Y.Text()
      tt.insert(0, title)
      const bb = new Y.Text()
      bb.insert(0, body)
      p.set('title', tt)
      p.set('body', bb)
      return p
    }
    ydoc.getMap('pages').set(docId, page('Essay', 'Dear diary\n'))
    ydoc.getMap('pages').set(mapId, page('Plans', 'Holiday\n'))
    const ink = new Y.Array()
    const s = new Y.Map()
    s.set('color', '#ff3b30')
    s.set('width', 3)
    const pts = new Y.Array()
    pts.push([10, 20, 110, 60])
    s.set('points', pts)
    ink.push([s])
    ydoc.getMap('drawings').set('ink:' + notesId, ink)
    // an old board: an arrow between notes and a note shown as a mind map
    const n = new Y.Map()
    const nt = new Y.Text()
    nt.insert(0, 'Old map note')
    n.set('title', nt)
    const nb = new Y.Text()
    nb.insert(0, '- a\n')
    n.set('body', nb)
    n.set('tabId', notesId)
    n.set('view', 'map')
    ydoc.getMap('notes').set('old1', n)
    ydoc.getArray('order').push(['old1'])
    const e = new Y.Map()
    e.set('id', 'e1')
    e.set('from', 'old1')
    e.set('to', 'old1')
    ydoc.getArray('edges').push([e])
  })
  const kinds = ydoc.getArray('tabs').toArray().map((t) => tabRec(t).kind)
  check('tabRec keeps the doc and mindmap kinds', kinds.join(',') === 'notes,doc,mindmap')
  const files = buildMirror(ydoc)
  const names = Object.keys(files)
  const docFile = names.find((f) => f.endsWith(`document--${docId}.md`))
  const mapFile = names.find((f) => f.endsWith(`mindmap--${mapId}.md`))
  const inkFile = names.find((f) => f.endsWith('/ink.svg'))
  check('the mirror writes a document tab as document--<id>.md', !!docFile && /Dear diary/.test(files[docFile]))
  check('the mirror writes a mind map with its centre as a heading', !!mapFile && /^# Plans/.test(files[mapFile]) && /Holiday/.test(files[mapFile]))
  check('ink between notes is mirrored as a cropped ink.svg', !!inkFile && /polyline/.test(files[inkFile]) && !/<rect/.test(files[inkFile]))
  const oldNote = names.find((f) => f.endsWith('--old1.md'))
  check('an old note shown as a mind map still mirrors, without the view key', !!oldNote && !/view: map/.test(files[oldNote]))
  check('old arrows do not break the export', !!files['index.json'] && /Dear diary/.test(exportMarkdown(ydoc)))
}

// --- stroke smoothing helpers ---
{
  let p = { x: 0, y: 0 }
  for (let i = 0; i < 20; i++) p = smoothPoint(p, { x: 10, y: 10 })
  check('smoothPoint converges on the pen', Math.abs(p.x - 10) < 0.01 && Math.abs(p.y - 10) < 0.01)
  const straight = []
  for (let i = 0; i <= 50; i++) straight.push(i, i * 0.5 + (i % 2) * 0.1)
  const lean = simplify(straight, 0.5)
  check('simplify keeps both end points', lean[0] === 0 && lean[lean.length - 2] === 50)
  check('simplify drops points on a near-straight line', lean.length < 10)
  check('simplify keeps a corner', simplify([0, 0, 10, 0, 10, 10], 0.5).length === 6)
}

// --- To-do tab: tree, progress over leaf parts, due dates, mirror ---
{
  const ydoc = new Y.Doc()
  const tid = 'tasks1'
  const item = (items, id, text, extra = {}) => {
    const m = new Y.Map()
    m.set('text', text)
    m.set('order', extra.order ?? 1)
    if (extra.parent) m.set('parent', extra.parent)
    if (extra.done) m.set('done', true)
    if (extra.due) m.set('due', extra.due)
    items.set(id, m)
  }
  ydoc.transact(() => {
    const t = new Y.Map()
    t.set('id', tid)
    t.set('name', 'School')
    t.set('kind', 'tasks')
    ydoc.getArray('tabs').push([t])
    const page = new Y.Map()
    const title = new Y.Text()
    title.insert(0, 'School')
    page.set('title', title)
    const items = new Y.Map()
    page.set('items', items)
    ydoc.getMap('pages').set(tid, page)
    item(items, 'calc', 'Calc HW', { due: '2026-10-30' })
    item(items, 'p1', 'Part 1', { parent: 'calc', order: 1 })
    item(items, 'p2', 'Part 2', { parent: 'calc', order: 2, done: true })
    item(items, 'q1', 'Q1', { parent: 'p1', order: 1, done: true, due: '2026-10-20' })
    item(items, 'q2', 'Q2', { parent: 'p1', order: 2 })
    item(items, 'essay', 'Essay', { order: 2, due: '2026-10-24' })
  })
  const items = ydoc.getMap('pages').get(tid).get('items')
  const tree = taskTree(items)
  check('tasks: tabRec keeps the tasks kind', tabRec(ydoc.getArray('tabs').get(0)).kind === 'tasks')
  check('tasks: the tree nests parts under their task in order', tree.map((n) => n.id).join() === 'calc,essay' && tree[0].children.map((n) => n.id).join() === 'p1,p2' && tree[0].children[0].children.length === 2)
  const pr = progress(tree[0])
  check('tasks: progress counts the leaf parts (2 of 3)', pr.done === 2 && pr.total === 3)
  const today = '2026-10-24'
  check('tasks: due states', dueState('2026-10-20', today) === 'overdue' && dueState(today, today) === 'today' && dueState('2026-10-26', today) === 'soon' && dueState('2026-11-20', today) === 'later' && dueState(null, today) === null)
  check('tasks: due labels', dueLabel('2026-10-20', today) === '4 days overdue' && dueLabel(today, today) === 'Today' && dueLabel('2026-10-25', today) === 'Tomorrow' && dueLabel('2026-11-20', today) === 'Nov 20' && dueLabel('2020-01-01', today) === 'Overdue since Jan 1 2020')
  check('tasks: the badge counts unticked items due today or overdue', dueCount(items, today) === 1)
  check('tasks: orderBetween', orderBetween(1, 2) === 1.5 && orderBetween(null, 1) === 0 && orderBetween(3, null) === 4)
  const files = buildMirror(ydoc)
  const f = Object.keys(files).find((k) => k.endsWith(`todo--${tid}.md`))
  check('tasks: the mirror writes todo--<id>.md as a nested checklist', !!f && /^- \[ \] Calc HW \(due 2026-10-30\)$/m.test(files[f]) && /^    - \[x\] Q1 \(due 2026-10-20\)$/m.test(files[f]))
  check('tasks: the Markdown export includes the list', /- \[x\] Part 2/.test(exportMarkdown(ydoc)))
  // a parent loop must not lose items
  ydoc.transact(() => { items.get('calc').set('parent', 'q2') })
  check('tasks: a parent loop keeps every item reachable', taskTree(items).length >= 1 && JSON.stringify(taskTree(items)).split('"id"').length - 1 === 6)
}

// --- Mind map: own bubbles, layout, pins, conversion, mirror ---
{
  const ydoc = new Y.Doc()
  const mid = 'map1'
  const IMG = '/media/' + 'a'.repeat(64) + '.png'
  ydoc.transact(() => {
    const t = new Y.Map()
    t.set('id', mid)
    t.set('name', 'Trip')
    t.set('kind', 'mindmap')
    ydoc.getArray('tabs').push([t])
    const page = new Y.Map()
    const title = new Y.Text()
    title.insert(0, 'Trip')
    page.set('title', title)
    page.set('body', new Y.Text())
    const nodes = new Y.Map()
    const node = (id, text, parent, order, extra = {}) => {
      const m = new Y.Map()
      m.set('text', text)
      if (parent) m.set('parent', parent)
      m.set('order', order)
      for (const [k, v] of Object.entries(extra)) m.set(k, v)
      nodes.set(id, m)
    }
    node('a', 'Budget', 'root', 1, { note: 'max 500' })
    node('a1', 'Flights', 'a', 1)
    node('a2', 'Hotel', 'a', 2, { image: IMG })
    node('b', 'Packing', 'root', 2, { x: 400, y: -300 })
    node('b1', 'Shoes', 'b', 1)
    node('c', 'Ask Sam', null, 1, { x: -500, y: 300 })
    node('orphan', 'Lost', 'gone', 3)
    page.set('nodes', nodes)
    const links = new Y.Map()
    const l = new Y.Map()
    l.set('from', 'a1')
    l.set('to', 'b1')
    l.set('label', 'same day')
    links.set('l1', l)
    page.set('links', links)
    page.set('v', 2)
    ydoc.getMap('pages').set(mid, page)
  })
  const page = ydoc.getMap('pages').get(mid)
  const tree = mapTree(page.get('nodes'), 'Trip')
  check('mindmap: branches hang off the centre in order', tree.root.children.map((n) => n.id).join() === 'a,b,orphan')
  check('mindmap: a missing parent falls back to the centre, loose ideas stay loose', tree.loose.map((n) => n.id).join() === 'c')
  // a loop must not lose bubbles
  ydoc.transact(() => page.get('nodes').get('a').set('parent', 'a1'))
  const loopTree = mapTree(page.get('nodes'), 'Trip')
  check('mindmap: a parent loop keeps every bubble', loopTree.byId.size === 8 && loopTree.root.children.some((n) => n.id === 'a'))
  ydoc.transact(() => page.get('nodes').get('a').set('parent', 'root'))
  const size = () => ({ w: 100, h: 30 })
  const L1 = layoutMap(mapTree(page.get('nodes'), 'Trip'), size).map((n) => `${n.id}:${n.x},${n.y}`).join()
  const L2 = layoutMap(mapTree(page.get('nodes'), 'Trip'), size).map((n) => `${n.id}:${n.x},${n.y}`).join()
  check('mindmap: layout is deterministic', L1 === L2)
  const laid = new Map(layoutMap(mapTree(page.get('nodes'), 'Trip'), size).map((n) => [n.id, n]))
  check('mindmap: a pinned bubble sits where it was put', laid.get('b').x === 400 && laid.get('b').y === -300)
  check('mindmap: its branch is laid out next to it', laid.get('b1').x > 400 && laid.get('b1').y === -300)
  check('mindmap: a loose idea keeps its spot', laid.get('c').x === -500 && laid.get('c').y === 300)
  check('mindmap: unpinned branches fan out right of the centre', laid.get('a').x > 0)
  ydoc.transact(() => page.get('nodes').get('a').set('folded', true))
  const folded = layoutMap(mapTree(page.get('nodes'), 'Trip'), size).map((n) => n.id)
  check('mindmap: a folded branch hides what is under it', !folded.includes('a1') && folded.includes('a'))
  ydoc.transact(() => page.get('nodes').get('a').delete('folded'))
  const md = mapMarkdown('Trip', page.get('nodes'), page.get('links'))
  check('mindmap: Markdown nests bubbles, quotes notes, lists loose ideas and links',
    /^# Trip$/m.test(md) && /^- Budget\n  > max 500\n  - Flights$/m.test(md) && /## Loose ideas\n\n- Ask Sam/.test(md) && /- Flights → Shoes \(same day\)/.test(md))
  const tasks = branchToTasks(mapTree(page.get('nodes'), 'Trip').byId.get('a'))
  check('mindmap: a branch becomes a task with parts', tasks.text === 'Budget' && tasks.children.map((c) => c.text).join() === 'Flights,Hotel')
  const files = buildMirror(ydoc)
  const f = Object.keys(files).find((k) => k.endsWith(`mindmap--${mid}.md`))
  check('mindmap: the mirror writes the bubbles', !!f && /- Packing\n  - Shoes/.test(files[f]))
  check('mindmap: a picture in a bubble counts as used (not swept)', referencedMedia(ydoc).has('a'.repeat(64) + '.png'))
  // an old outline converts with every idea
  const old = linesOf((() => {
    const d = new Y.Doc()
    const t = d.getText('x')
    t.insert(0, 'Holiday\nBeach\n')
    t.format(6, 1, { lt: 'li' })
    t.format(5, 1, {})
    return t
  })())
  let n = 0
  const rows = fromOutline(outlineTree(old), () => 'id' + ++n)
  check('mindmap: an old outline converts to bubbles', rows.length === 2 && rows[0].parent === 'root' && rows.map((r) => r.text).join() === 'Holiday,Beach')
}

A.close()
B.close()
await sleep(150)

console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'))
process.exit(failures === 0 ? 0 : 1)
