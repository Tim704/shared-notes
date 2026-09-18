import fs from 'fs'
import path from 'path'
import * as Y from 'yjs'
import { connect, sleep } from './lib.mjs'
import { parseNoteMarkdown } from '../server/mirror.js'

// Exercises the JSON API, the markdown mirror and the history endpoint against
// a running server. Assumes a server on PORT (started separately, like the
// other suites) with a throwaway data dir; nothing is cleaned up.
const PORT = process.env.PORT || 3807
const HTTP = `http://127.0.0.1:${PORT}`
const URL = `ws://127.0.0.1:${PORT}/ws`
// where the server writes the mirror: NOTES_EXPORT_DIR, else <NOTES_DATA_DIR or data>/export
const EXPORT_DIR = process.env.NOTES_EXPORT_DIR
  ? path.resolve(process.env.NOTES_EXPORT_DIR)
  : path.join(path.resolve(process.env.NOTES_DATA_DIR || 'data'), 'export')

let failures = 0
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name)
  if (!cond) failures++
}

const api = async (method, url, body) => {
  const res = await fetch(HTTP + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const type = res.headers.get('content-type') || ''
  const data = type.includes('json') ? await res.json() : await res.text()
  return { status: res.status, headers: res.headers, data }
}

const A = connect(URL)
await A.ready
await sleep(300)

// --- a tab and a checklist note, made the way the client makes them ---
const tabId = 'tab_' + Math.random().toString(36).slice(2, 8)
const todoId = 'note_' + Math.random().toString(36).slice(2, 8)
const suffix = Math.random().toString(36).slice(2, 8)
A.doc.transact(() => {
  A.doc.getArray('tabs').push([{ id: tabId, name: 'Api Tab', kind: 'notes' }])
  const n = new Y.Map()
  const title = new Y.Text()
  title.insert(0, 'Shopping ' + suffix)
  n.set('title', title)
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
  t.insert(0, 'Buy oat milk')
  A.doc.getMap('notes').set(todoId, n)
  A.doc.getArray('order').unshift([todoId])
})
await sleep(300)

// --- POST a note, then it shows up in the tab (both via API and via Yjs) ---
const marker = 'zebra' + suffix
const created = await api('POST', `/api/tabs/${tabId}/notes`, {
  title: 'Hello API',
  body: 'Some body text with a ' + marker + ' in it',
  color: '#bde0fe',
})
check('POST /api/tabs/:id/notes -> 201 {id}', created.status === 201 && typeof created.data.id === 'string')
const noteId = created.data.id
await sleep(300)
const yn = A.doc.getMap('notes').get(noteId)
check('Yjs client received the API note', yn && yn.get('title').toString() === 'Hello API')
check(
  'API note has the fields the client renders',
  yn && yn.get('kind') === 'note' && yn.get('tabId') === tabId && yn.get('w') === 250 && typeof yn.get('z') === 'number'
)
check('API note is first in order', A.doc.getArray('order').get(0) === noteId)

const tabsRes = await api('GET', '/api/tabs')
const tabRow = Array.isArray(tabsRes.data) && tabsRes.data.find((t) => t.id === tabId)
check('GET /api/tabs lists the tab with a count', tabRow && tabRow.name === 'Api Tab' && tabRow.count === 2)

const tabRes = await api('GET', `/api/tabs/${tabId}`)
check('GET /api/tabs/:id -> 200 with tab + notes', tabRes.status === 200 && tabRes.data.tab.id === tabId)
const apiNote = tabRes.data.notes.find((n) => n.id === noteId)
check('GET /api/tabs/:id includes the new note', apiNote && apiNote.title === 'Hello API' && apiNote.body.includes(marker))
check('GET /api/tabs/:id note carries color/layout/kind', apiNote && apiNote.color === '#bde0fe' && apiNote.layout === 'single' && apiNote.kind === 'note')
const apiTodo = tabRes.data.notes.find((n) => n.id === todoId)
check('GET /api/tabs/:id shows checklist items', apiTodo && apiTodo.items.length === 1 && apiTodo.items[0].text === 'Buy oat milk')
check('GET /api/tabs/unknown -> 404', (await api('GET', '/api/tabs/nope_' + suffix)).status === 404)

// --- PATCH check on the checklist ---
const patched = await api('PATCH', `/api/notes/${todoId}/check`, { itemId: 'i1', done: true })
check('PATCH /api/notes/:id/check -> 200', patched.status === 200 && patched.data.done === true)
await sleep(300)
check('Yjs client sees the item ticked', A.doc.getMap('notes').get(todoId).get('items').get(0).get('done') === true)
check('PATCH unknown item -> 404', (await api('PATCH', `/api/notes/${todoId}/check`, { itemId: 'nope', done: true })).status === 404)

// --- search ---
const found = await api('GET', '/api/search?q=' + encodeURIComponent(marker.toUpperCase()))
const hit = Array.isArray(found.data) && found.data.find((h) => h.id === noteId)
check('GET /api/search finds the note (case-insensitive)', hit && hit.tabId === tabId && hit.tabName === 'Api Tab')
check('search hit has a snippet around the match', hit && hit.snippet.toLowerCase().includes(marker))
const foundItem = await api('GET', '/api/search?q=oat%20milk')
check('search covers checklist items', Array.isArray(foundItem.data) && foundItem.data.some((h) => h.id === todoId))
check('empty search -> []', Array.isArray((await api('GET', '/api/search?q=')).data) && (await api('GET', '/api/search?q=')).data.length === 0)

// --- exports ---
const md = await api('GET', '/api/export.md')
check('GET /api/export.md is an attachment', md.status === 200 && /attachment; filename="notes-\d{4}-\d{2}-\d{2}\.md"/.test(md.headers.get('content-disposition')))
check('export.md contains the tab, the note and the ticked item', md.data.includes('# Api Tab') && md.data.includes('## Hello API') && md.data.includes('- [x] Buy oat milk'))
const js = await api('GET', '/api/export.json')
const jsTab = js.data.tabs && js.data.tabs.find((t) => t.id === tabId)
check('GET /api/export.json contains the note', js.status === 200 && jsTab && jsTab.notes.some((n) => n.id === noteId && n.title === 'Hello API'))
check('export.json is an attachment', /attachment; filename="notes-.*\.json"/.test(js.headers.get('content-disposition')))

// --- markdown mirror (debounced ~3s after the last change) ---
await sleep(4000)
let index = { tabs: [] }
try {
  index = JSON.parse(fs.readFileSync(path.join(EXPORT_DIR, 'index.json'), 'utf8'))
} catch (err) {
  console.log('(could not read mirror index at ' + EXPORT_DIR + ': ' + err.message + ')')
}
const idxTab = index.tabs.find((t) => t.id === tabId)
check('mirror index.json lists the tab', idxTab && idxTab.name === 'Api Tab' && /^api-tab(-\d+)?$/.test(idxTab.dir))
const idxNote = idxTab && idxTab.notes.find((n) => n.id === noteId)
check('mirror file path follows <tab-slug>/<title-slug>--<id>.md', idxNote && idxNote.file === `${idxTab.dir}/hello-api--${noteId}.md`)
const mirrorPath = idxNote && path.join(EXPORT_DIR, idxNote.file)
check('mirror file exists', !!mirrorPath && fs.existsSync(mirrorPath))
const parsed = mirrorPath && fs.existsSync(mirrorPath) ? parseNoteMarkdown(fs.readFileSync(mirrorPath, 'utf8')) : null
check('mirror file parses back (front matter + title + body)', parsed && parsed.front.id === noteId && parsed.front.tabId === tabId && parsed.title === 'Hello API' && parsed.body.includes(marker))
check('mirror front matter has numbers + editor', parsed && parsed.front.w === 250 && parsed.front.lastEditedBy === 'API' && parsed.front.kind === 'note')
const todoFile = idxTab && idxTab.notes.find((n) => n.id === todoId)
const todoParsed = todoFile && parseNoteMarkdown(fs.readFileSync(path.join(EXPORT_DIR, todoFile.file), 'utf8'))
check('checklist mirrors as task list lines', todoParsed && todoParsed.front.kind === 'todo' && todoParsed.body === '- [x] Buy oat milk')
check('mirror README.md exists', fs.existsSync(path.join(EXPORT_DIR, 'README.md')))

// --- history endpoint: shape only (git may or may not be installed / committed yet) ---
const hist = await api('GET', `/api/history/${noteId}`)
check('GET /api/history/:id -> {available, versions[]}', hist.status === 200 && typeof hist.data.available === 'boolean' && Array.isArray(hist.data.versions))
check('GET /api/history/:id/badcommit -> 400', (await api('GET', `/api/history/${noteId}/zzz`)).status === 400)
check('GET /api/history/:id/<unknown sha> -> 404', (await api('GET', `/api/history/${noteId}/0123456789abcdef`)).status === 404)

A.close()
await sleep(150)

console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'))
process.exit(failures === 0 ? 0 : 1)
