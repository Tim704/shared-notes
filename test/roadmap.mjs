// Roadmap 2 (links, capture, tags, search, dates, to-dos from notes, reminders,
// share links, ZIP export, webhooks): the shared modules on their own, then the
// API on a running server (PORT, started by run.mjs on a throwaway data dir).
import crypto from 'crypto'
import http from 'http'
import * as Y from 'yjs'
import { connect, sleep } from './lib.mjs'
import { linesOf, markdownToLines, linesToMarkdown, parseInline } from '../shared/lines.js'
import { insertLinesAt } from '../shared/lineops.js'
import { backlinks, unlinkedMentions, followRename, rewriteLinks, tagCounts, renameTag, noteTodos, parseTarget, linkMention } from '../shared/links.js'
import { parseNatural, dateBeforeCaret } from '../shared/dates.js'
import { parseQuery, matchNote } from '../shared/search.js'
import { taskTree, tasksMarkdown } from '../shared/tasks.js'
import { encryptPayload, decryptPayload, validSubscription, digest, localNow, createPush } from '../server/push.js'
import { isPublicAddress, titleFromHtml } from '../server/unfurl.js'
import { readZip, createZip } from '../server/zip.js'
import { capture } from '../server/capture.js'
import { isKeepNote, keepToNote, splitFrontMatter, importFiles } from '../src/importer.js'

const PORT = process.env.PORT || 3808
const HTTP = `http://127.0.0.1:${PORT}`
const HOOK_PORT = Number(process.env.HOOK_PORT || 0)

let failures = 0
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name)
  if (!cond) failures++
}

// ---- a board in memory -------------------------------------------------------
function board() {
  const doc = new Y.Doc()
  doc.getArray('tabs').push([{ id: 't1', name: 'Ideas', kind: 'notes' }, { id: 't2', name: 'Plans', kind: 'doc' }])
  const page = new Y.Map()
  page.set('title', new Y.Text())
  page.set('body', new Y.Text())
  doc.getMap('pages').set('t2', page)
  insertLinesAt(page.get('body'), 0, markdownToLines('See [[Recipes#Soup]]\n- [ ] book tickets @2026-10-20'))
  return doc
}
function note(doc, id, title, md, extra = {}) {
  const n = new Y.Map()
  const t = new Y.Text()
  t.insert(0, title)
  const b = new Y.Text()
  insertLinesAt(b, 0, markdownToLines(md))
  n.set('title', t)
  n.set('body', b)
  n.set('tabId', 't1')
  for (const [k, v] of Object.entries(extra)) n.set(k, v)
  doc.getMap('notes').set(id, n)
  doc.getArray('order').unshift([id])
  return n
}

// ---- line model: highlights, labelled links, dividers, callouts, todo states ----
{
  const md = '**bold** ==hi== <mark data-color="green">g</mark> [label](https://example.com/a)\n> [!tip] Remember\n> this too\n> plain quote\n***\n- [/] doing\n- [-] dropped\n- [>] later'
  const lines = markdownToLines(md)
  check('inline marks parse: bold, highlights and a labelled link', JSON.stringify(lines[0].runs.map((r) => r.marks)) === JSON.stringify([{ b: true }, {}, { hl: 'yellow' }, {}, { hl: 'green' }, {}, { href: 'https://example.com/a' }]))
  check('callouts: a [!tip] line and the "> " lines after it', lines[1].attrs.co === 'tip' && lines[2].attrs.co === 'tip' && lines[1].attrs.lt === 'callout')
  check('a divider and the extra checkbox states', lines[4].attrs.lt === 'hr' && lines[5].attrs.ts === '/' && lines[6].attrs.ts === '-' && lines[7].attrs.ts === '>')
  const doc = new Y.Doc()
  const yt = doc.getText('t')
  insertLinesAt(yt, 0, lines)
  const back = linesToMarkdown(linesOf(yt))
  check('Markdown round trip keeps marks, links, callouts, dividers and states', back === md)
  check('an unbalanced * stays plain text', parseInline('5 * 3 = 15').length === 1 && parseInline('5 * 3 = 15')[0].text === '5 * 3 = 15')
}

// ---- links: backlinks, mentions, renames, aliases --------------------------------
{
  const doc = board()
  note(doc, 'a', 'Groceries', 'milk and [[Recipes]]\n**see [[recipes#Soup]]** and [[Recipes^lx1]]\nrecipes are fun')
  note(doc, 'b', 'Recipes', 'Soup\nGroceries list is long')
  note(doc, 'c', 'Old', '[[Recipes]] from the trash', { deleted: 1 })
  note(doc, 'd', 'Cooking', 'x', { aliases: ['Kitchen'] })
  const bl = backlinks(doc, ['Recipes'], { excludeId: 'b' })
  check('backlinks: every live line linking here (any case, #heading and ^line too), plus documents', bl.length === 3 && bl.some((b) => b.kind === 'page'))
  const um = unlinkedMentions(doc, ['Recipes'], { excludeId: 'b' })
  check('unlinked mentions: plain text only, not inside [[links]]', um.length === 1 && um[0].line === 'recipes are fun')
  const n = followRename(doc, 'b', 'Recipes', 'Cookbook')
  const a = doc.getMap('notes').get('a').get('body').toString()
  check('a rename rewrites links, keeping #heading / ^line', n === 5 && a.includes('[[Cookbook]]') && a.includes('[[Cookbook#Soup]]') && a.includes('[[Cookbook^lx1]]'))
  check('…in the trash and in documents too', doc.getMap('notes').get('c').get('body').toString().includes('[[Cookbook]]') && doc.getMap('pages').get('t2').get('body').toString().includes('[[Cookbook#Soup]]'))
  const boldRun = doc.getMap('notes').get('a').get('body').toDelta().find((op) => op.attributes && op.attributes.b)
  check('…and keeps the formatting around them', !!boldRun && boldRun.insert.includes('[[Cookbook#Soup]]'))
  note(doc, 'e', 'Twin', 'a')
  note(doc, 'f', 'Twin', '[[Twin]]')
  check('no rewrite while another note still has the old name', followRename(doc, 'e', 'Twin', 'Solo') === 0)
  check('aliases count as names for backlinks', (note(doc, 'g', 'Ref', 'see [[kitchen]]'), backlinks(doc, ['Cooking', 'Kitchen']).length === 1))
  const m = unlinkedMentions(doc, ['Groceries'], { excludeId: 'a' })[0]
  linkMention(doc.getMap('notes').get(m.id).get('body'), m.start, m.len, 'Groceries')
  check('"Link" turns a mention into [[Title]]', doc.getMap('notes').get('b').get('body').toString().includes('[[Groceries]] list'))
  check('parseTarget splits #heading and ^line', JSON.stringify(parseTarget('A b#Soup')) === JSON.stringify({ title: 'A b', heading: 'Soup', block: null }) && parseTarget('X^l1').block === 'l1')
  check('rewriteLinks leaves other titles alone', rewriteLinks(doc, 'Nope', 'Other') === 0)
}

// ---- tags --------------------------------------------------------------------------
{
  const doc = board()
  note(doc, 'a', 'One #work', 'meet #work/meetings and #home, not #1 or a#b or https://x.com/#frag')
  note(doc, 'b', 'Two', '#WORK again')
  const counts = Object.fromEntries(tagCounts(doc).map((t) => [t.name.toLowerCase(), t.count]))
  check('tag counts: parents count their children, case-insensitive, no numbers or mid-word #', counts.work === 2 && counts['work/meetings'] === 1 && counts.home === 1 && !counts['1'] && !counts.b && !counts.frag)
  const n = renameTag(doc, 'work', 'job')
  check('renaming a tag rewrites it and its children everywhere', n === 3 && doc.getMap('notes').get('a').get('body').toString().includes('#job/meetings') && doc.getMap('notes').get('a').get('title').toString() === 'One #job')
}

// ---- search operators ------------------------------------------------------------------
{
  const doc = board()
  const a = note(doc, 'a', 'Shopping', '- [ ] oat milk #food\n/media/' + 'a'.repeat(64) + '.png', { lastEditedBy: { id: 'x', name: 'Sam' } })
  const b = note(doc, 'b', 'Done list', '- [x] all of it', { pinned: true })
  check('tag:, is:todo, has:image, by: and words together', matchNote('tag:food is:todo has:image by:sam milk', a, 'Ideas'))
  check('is:done means every checkbox ticked', matchNote('is:done', b) && !matchNote('is:done', a))
  check('"phrases", -negation and tab:', matchNote('"oat milk" -bread tab:ide', a, 'Ideas') && !matchNote('"milk oat"', a) && !matchNote('-milk', a))
  check('one typo is forgiven in longer words', matchNote('shoping', a) && !matchNote('shxxping', a))
  check('unknown operators are just text', parseQuery('foo:bar')[0].op === null)
}

// ---- dates ---------------------------------------------------------------------------------
{
  const t = '2026-10-28' // a Wednesday
  check('weekday names: the next one, today counts', parseNatural('friday', t) === '2026-10-30' && parseNatural('wed', t) === t && parseNatural('next friday', t) === '2026-11-06')
  check('relative and calendar dates', parseNatural('tomorrow', t) === '2026-10-29' && parseNatural('in 3 days', t) === '2026-10-31' && parseNatural('in 2 weeks', t) === '2026-11-11' && parseNatural('3 nov', t) === '2026-11-03' && parseNatural('jan 5', t) === '2027-01-05')
  check('nonsense is not a date', parseNatural('sam', t) === null && parseNatural('31 feb', t) === null && parseNatural('next', t) === null)
  check('"@phrase" just before the caret, but not an e-mail address', JSON.stringify(dateBeforeCaret('call @in 2 days', t)) === JSON.stringify({ from: 5, to: 15, date: '2026-10-30' }) && dateBeforeCaret('mail tim@friday', t) === null)
}

// ---- to-dos from notes, kanban status, reminders' digest -------------------------------------
{
  const doc = board()
  note(doc, 'a', 'Errands', '- [ ] post the parcel @2026-10-27\n- [x] done @2026-10-27\n- [-] dropped @2026-10-27\n- [ ] someday')
  const todos = noteTodos(doc)
  check('checkboxes from every note and document, with their @dates', todos.length === 5 && todos.find((x) => x.text.startsWith('post')).due === '2026-10-27' && todos.some((x) => x.kind === 'page'))
  const tasks = new Y.Map()
  doc.getMap('pages').set('t3', new Y.Map())
  doc.getArray('tabs').push([{ id: 't3', name: 'To-do', kind: 'tasks' }])
  doc.getMap('pages').get('t3').set('items', tasks)
  const m = new Y.Map()
  m.set('text', 'Pay rent')
  m.set('due', '2026-10-28')
  m.set('status', 'doing')
  m.set('order', 1)
  tasks.set('i1', m)
  check('a task in progress is "doing", and shows as [/] in Markdown', taskTree(tasks)[0].doing === true && tasksMarkdown('T', tasks).includes('- [/] Pay rent'))
  const d = digest(doc, '2026-10-28')
  check('the daily reminder lists what is overdue and due (not ticked or cancelled ones)', d && d.title === '2 overdue, 1 due today' && /post the parcel/.test(d.body) && /Pay rent/.test(d.body) && /book tickets/.test(d.body) && !/dropped/.test(d.body))
  check('nothing due, no reminder', digest(new Y.Doc(), '2026-10-28') === null)
  check('local clocks per time zone', localNow('Pacific/Auckland', new Date('2026-10-28T12:00:00Z')).day === '2026-10-29' && localNow('America/Los_Angeles', new Date('2026-10-28T12:00:00Z')).hour === 5)
}

// ---- Web Push: encryption round trip, subscriptions, the daily tick ----------------------------
{
  const ua = crypto.createECDH('prime256v1')
  ua.generateKeys()
  const auth = crypto.randomBytes(16)
  const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }
  const body = encryptPayload('{"title":"Hé ✓"}', keys)
  check('a push message decrypts on the device side (aes128gcm)', decryptPayload(body, ua.getPrivateKey(), ua.getPublicKey(), auth) === '{"title":"Hé ✓"}')
  check('only real push services are accepted', validSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys }) && !validSubscription({ endpoint: 'https://evil.example/x', keys }) && !validSubscription({ endpoint: 'http://fcm.googleapis.com/x', keys }))
  const fs = await import('fs')
  const os = await import('os')
  const path = await import('path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-push-'))
  const doc = board()
  note(doc, 'a', 'Errands', '- [ ] post the parcel @2026-10-27')
  const sent = []
  const push = createPush({ ydoc: doc, dataDir: dir, send: async (endpoint, headers, b) => (sent.push({ endpoint, headers, b }), { status: 201 }), log: { error() {} } })
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys }
  push.subscribe({ subscription: sub, tz: 'UTC', hour: 9 })
  await push.tick(new Date('2026-10-28T08:59:00Z'))
  check('no reminder before the chosen hour', sent.length === 0 || sent[0].b == null)
  sent.length = 0
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'push.json'), 'utf8')).subs[0]
  s.lastSent = null // pretend it was subscribed yesterday
  fs.writeFileSync(path.join(dir, 'push.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, 'push.json'), 'utf8')), subs: [s] }))
  const push2 = createPush({ ydoc: doc, dataDir: dir, send: async (endpoint, headers, b) => (sent.push({ endpoint, headers, b }), { status: 201 }), log: { error() {} } })
  await push2.tick(new Date('2026-10-28T09:01:00Z'))
  await push2.tick(new Date('2026-10-28T15:00:00Z'))
  const msg = sent.length ? JSON.parse(decryptPayload(sent[0].b, ua.getPrivateKey(), ua.getPublicKey(), auth)) : {}
  check('one reminder a day at the hour, signed with VAPID', sent.length === 1 && /^vapid t=.+, k=.+/.test(sent[0].headers.Authorization) && sent[0].headers['Content-Encoding'] === 'aes128gcm' && msg.title === '2 overdue')
  const push3 = createPush({ ydoc: doc, dataDir: dir, send: async () => ({ status: 410 }), log: { error() {} } })
  await push3.test(sub.endpoint)
  check('a subscription the push service says is gone is dropped', push3.count() === 0)
  fs.rmSync(dir, { recursive: true, force: true })
}

// ---- capture, unfurl guard, zip, importer pieces (unit) ----------------------------------------
{
  const doc = board()
  const r1 = capture(doc, { text: 'first thing' })
  const r2 = capture(doc, { text: '- [ ] milk', note: 'Inbox', heading: 'Shopping' })
  const r3 = capture(doc, { text: 'eggs', note: 'inbox', heading: 'shopping', as: 'todo' })
  const lines = linesOf(doc.getMap('notes').get(r1.id).get('body')).map((L) => (L.attrs.lt || 'p') + ':' + L.text)
  check('capture makes an Inbox note, then adds under a heading (made once)', r1.created && !r2.created && r1.id === r3.id && JSON.stringify(lines) === JSON.stringify(['p:first thing', 'h:Shopping', 'todo:milk', 'todo:eggs']))
  let threw = null
  try {
    capture(doc, { text: '   ' })
  } catch (e) {
    threw = e
  }
  check('capture needs some text', threw && threw.status === 400)
  check('private and loopback addresses are refused for link titles', !isPublicAddress('127.0.0.1') && !isPublicAddress('192.168.1.5') && !isPublicAddress('100.112.108.54') && !isPublicAddress('::1') && !isPublicAddress('fd00::1') && isPublicAddress('93.184.216.34'))
  check('a page title from og:title or <title>', titleFromHtml('<head><meta property="og:title" content="A &amp; B"><title>x</title>') === 'A & B' && titleFromHtml('<title>\n Hello &#8212; world </title>') === 'Hello — world')
  const chunks = []
  const sink = { write: (b) => (chunks.push(Buffer.from(b)), true), once() {}, end() {} }
  const z = createZip(sink)
  await z.add('a/ü.md', '# hi')
  await z.add('media/x.png', Buffer.from([1, 2, 3]))
  await z.end()
  const files = readZip(Buffer.concat(chunks))
  check('the zip writer writes a valid archive (names, bytes and CRCs check out)', files.length === 2 && files[0].name === 'a/ü.md' && files[0].data.toString() === '# hi' && files[1].data.length === 3)
  const keep = { title: 'Trip', textContent: 'pack', listContent: [{ text: 'socks', isChecked: true }], color: 'BLUE', isPinned: true, isArchived: false, isTrashed: false, labels: [{ name: 'travel plans' }] }
  const k = keepToNote(keep)
  check('Google Keep notes: text, ticked list, labels as #tags, colour, pin', isKeepNote(keep) && k.lines[1].attrs.lt === 'todo' && k.lines[1].attrs.done === true && k.lines[k.lines.length - 1].text === '#travel-plans' && k.color === '#a0c4ff' && k.pinned)
  const fm = splitFrontMatter('---\naliases: [A, "B"]\ntags:\n  - x\n---\nbody')
  check('Obsidian front matter: aliases and tags, body after it', JSON.stringify(fm.meta.aliases) === '["A","B"]' && fm.meta.tags[0] === 'x' && fm.body === 'body')
}

// ---- import: a vault folder, this app's mirror, Keep; pictures uploaded ----------------------------
{
  const fake = (rel, content, type = 'text/markdown') => ({
    name: rel.split('/').pop(),
    webkitRelativePath: rel,
    lastModified: 1700000000000,
    type,
    text: async () => content,
  })
  const mirror = '---\nid: q1\ntab: Work stuff\ntabId: zz\nkind: note\nlayout: single\ncolor: #caffbf\nx: 40\ny: 60\nw: 300\nh: 200\npinned: true\naliases: Q, Quarter\n---\n# Q3 plan\n\n- [ ] ship it\n![](../../media/' + 'd'.repeat(64) + '.png)\n'
  const files = [
    fake('Vault/.obsidian/app.json', '{}', 'application/json'),
    fake('Vault/Projects/Big idea.md', '---\naliases: [BI]\ntags: [plan]\n---\nSee [[Other]] and ![[pic.png]]'),
    fake('Vault/Top.md', 'top level **bold**'),
    fake('Vault/pic.png', 'PNG', 'image/png'),
    fake('Vault/export/work/q3--q1.md', mirror),
    fake('Vault/export/essay/document--d1.md', '### Intro\nhello'),
    fake('Vault/Keep/trip.json', JSON.stringify({ title: 'Trip', textContent: 'pack', listContent: [{ text: 'socks', isChecked: false }], color: 'GREEN', isTrashed: false, isArchived: true, userEditedTimestampUsec: 1 }), 'application/json'),
    fake('Vault/Keep/old.json', JSON.stringify({ title: 'Gone', textContent: 'x', isTrashed: true }), 'application/json'),
  ]
  const doc = new Y.Doc()
  doc.getArray('tabs').push([{ id: 'p0', name: 'Projects', kind: 'notes' }])
  const uploads = []
  let n = 0
  const out = await importFiles(files, {
    doc,
    me: { id: 'me', name: 'Tester' },
    upload: async (fs) => fs.map((f) => (uploads.push(f.name), '/media/' + 'e'.repeat(64) + '.png')),
    genId: () => 'id' + ++n,
    makeTabMap: ({ id, name, kind }) => ({ id, name, kind }),
  })
  const notes = []
  doc.getMap('notes').forEach((m) => notes.push(m))
  const byTitle = (t) => notes.find((m) => m.get('title').toString() === t)
  const tabName = (id) => doc.getArray('tabs').toArray().find((t) => (t.get ? t.get('id') : t.id) === id)
  const big = byTitle('Big idea')
  check('import: a vault folder becomes tabs (an existing one reused), files become notes', out.notes === 4 && out.docs === 1 && big && big.get('tabId') === 'p0' && tabName(byTitle('Top').get('tabId')).name === 'Vault')
  check('…Obsidian front matter becomes aliases and #tags, ![[pic]] is uploaded', JSON.stringify(big.get('aliases')) === '["BI"]' && big.get('body').toString().includes('#plan') && big.get('body').toString().includes('/media/' + 'e'.repeat(64)) && uploads.join() === 'pic.png')
  check('…inline marks survive', JSON.stringify(byTitle('Top').get('body').toDelta()[1].attributes) === '{"b":true}')
  const q = byTitle('Q3 plan')
  check('…this app’s own mirror keeps tab, colour, place, pin, aliases and pictures', q && tabName(q.get('tabId')).name === 'Work stuff' && q.get('color') === '#caffbf' && q.get('x') === 40 && q.get('pinned') === true && JSON.stringify(q.get('aliases')) === '["Q","Quarter"]' && q.get('body').toString().includes('/media/' + 'd'.repeat(64) + '.png'))
  const trip = byTitle('Trip')
  check('…Keep notes land in a "Google Keep" tab (trash skipped, archive kept)', trip && tabName(trip.get('tabId')).name === 'Google Keep' && trip.get('archived') === true && !byTitle('Gone'))
  const docTab = doc.getArray('tabs').toArray().find((t) => t.kind === 'doc')
  check('…and document files become document tabs', docTab && doc.getMap('pages').get(docTab.id).get('body').toString().startsWith('Intro'))
}

// ---- the API on the running server ----------------------------------------------------------------
const api = async (method, url, body, headers = {}) => {
  const res = await fetch(HTTP + url, { method, headers: body ? { 'Content-Type': 'application/json', ...headers } : headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' })
  const type = res.headers.get('content-type') || ''
  const data = type.includes('json') ? await res.json() : type.includes('zip') ? Buffer.from(await res.arrayBuffer()) : await res.text()
  return { status: res.status, headers: res.headers, data }
}

let hookCalls = []
let hookServer = null
if (HOOK_PORT) {
  hookServer = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      hookCalls.push({ headers: req.headers, body: JSON.parse(b) })
      res.end('ok')
    })
  })
  await new Promise((r) => hookServer.listen(HOOK_PORT, '127.0.0.1', r))
}

const A = connect(`ws://127.0.0.1:${PORT}/ws`)
await A.ready
await sleep(300)
const tabId = 'tab_rm'
A.doc.transact(() => A.doc.getArray('tabs').push([{ id: tabId, name: 'Roadmap', kind: 'notes' }]))
await sleep(150)

{
  const r = await api('POST', '/api/capture', { text: 'from my phone', tab: 'Roadmap' })
  check('POST /api/capture adds to "Inbox" (made in the named tab)', r.status === 201 && r.data.title === 'Inbox')
  const r2 = await api('POST', '/api/capture', { text: '' })
  check('…and refuses empty text', r2.status === 400)
  await sleep(150)
  const inbox = A.doc.getMap('notes').get(r.data.id)
  check('the captured line reaches every client live', inbox && inbox.get('body').toString().startsWith('from my phone') && inbox.get('tabId') === tabId)
  const sh = await api('GET', '/share?title=Article&url=' + encodeURIComponent('https://example.com/x'), null, { 'Sec-Fetch-Site': 'none' })
  check('the share target saves to the Inbox and opens it', sh.status === 303 && sh.headers.get('location') === '/#note=' + r.data.id + '&full' && inbox.get('body').toString().includes('Article: https://example.com/x'))
  const bad = await api('GET', '/share?text=x', null, { 'Sec-Fetch-Site': 'cross-site' })
  check('…but not from a link on another site', bad.status === 403)
}

{
  // renames through the API rewrite links
  const mk = (id, title, md) =>
    A.doc.transact(() => {
      const n = new Y.Map()
      const t = new Y.Text()
      t.insert(0, title)
      const b = new Y.Text()
      insertLinesAt(b, 0, markdownToLines(md))
      n.set('title', t)
      n.set('body', b)
      n.set('tabId', tabId)
      A.doc.getMap('notes').set(id, n)
      A.doc.getArray('order').unshift([id])
    })
  mk('rm1', 'Target', 'hello #alpha')
  mk('rm2', 'Source', 'see [[Target]] - [ ] x')
  await sleep(200)
  const r = await api('PATCH', '/api/notes/rm1', { title: 'Renamed' })
  await sleep(200)
  check('PATCH title rewrites [[links]] to the note', r.status === 200 && A.doc.getMap('notes').get('rm2').get('body').toString().includes('[[Renamed]]'))
  const s = await api('GET', '/api/search?q=' + encodeURIComponent('tag:alpha'))
  check('GET /api/search understands operators', Array.isArray(s.data) && s.data.length === 1 && s.data[0].id === 'rm1')

  // share by link: read-only page, bypasses nothing else, revocable
  const token = 'Tok_' + crypto.randomBytes(12).toString('base64url')
  A.doc.transact(() => {
    const n = A.doc.getMap('notes').get('rm1')
    n.set('share', token)
    insertLinesAt(n.get('body'), 0, markdownToLines('**Shared** <script>x</script>\n- [x] ticked\n/media/' + 'b'.repeat(64) + '.png'))
  })
  await sleep(200)
  const page = await api('GET', '/s/' + token)
  check('/s/<token> serves the note read-only, escaped, without the app', page.status === 200 && page.data.includes('<h1>Renamed</h1>') && page.data.includes('<strong>Shared</strong>') && !page.data.includes('<script>x') && page.data.includes('☑') && !page.data.includes('bundle.js'))
  check('…and marks itself noindex and no-store', page.headers.get('cache-control') === 'no-store' && /noindex/.test(page.headers.get('x-robots-tag') || ''))
  const media = await api('GET', '/s/' + token + '/media/' + 'c'.repeat(64) + '.png')
  check('…it may only load pictures that note shows', media.status === 404)
  A.doc.transact(() => A.doc.getMap('notes').get('rm1').delete('share'))
  await sleep(150)
  const gone = await api('GET', '/s/' + token)
  check('stopping sharing kills the link', gone.status === 404 && /isn’t shared/.test(gone.data))
  check('a made-up token is not found', (await api('GET', '/s/' + 'x'.repeat(24))).status === 404)

  // export with pictures
  const zip = await api('GET', '/api/export.zip')
  let entries = []
  try {
    entries = readZip(zip.data)
  } catch {
    entries = []
  }
  check('GET /api/export.zip is a zip of the mirror (notes/<tab>/…, index.json)', zip.status === 200 && entries.some((e) => /^notes-[\d-]+\/notes\/roadmap\/renamed--rm1\.md$/.test(e.name)) && entries.some((e) => e.name.endsWith('/notes/index.json')))

  // push endpoints (no real push service is contacted here)
  const key = await api('GET', '/api/push/key')
  check('GET /api/push/key gives the VAPID public key', key.status === 200 && Buffer.from(key.data.publicKey, 'base64url').length === 65)
  const badSub = await api('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://127.0.0.1/x', keys: { p256dh: 'a', auth: 'b' } }, hour: 8 })
  check('a subscription to anything but a push service is refused', badSub.status === 400)
  const ua = crypto.createECDH('prime256v1')
  ua.generateKeys()
  const okSub = await api('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/test-' + Date.now(), keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } }, hour: 8, tz: 'Europe/Berlin' })
  check('a real-looking subscription is stored with its hour and zone', okSub.status === 200 && okSub.data.hour === 8 && okSub.data.tz === 'Europe/Berlin')
  const un = await api('POST', '/api/push/unsubscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/nope' })
  check('unsubscribing an unknown device is harmless', un.status === 200 && un.data.removed === false)
  const unf = await api('GET', '/api/unfurl?url=' + encodeURIComponent('http://127.0.0.1:' + PORT + '/'))
  check('GET /api/unfurl refuses the Pi itself', unf.status === 422)
}

if (HOOK_PORT) {
  await sleep(900) // NOTES_WEBHOOK_MS is short in the test run
  const ev = hookCalls.map((c) => c.body.event + ':' + (c.body.note.title || c.body.note.id))
  check('webhooks: created / updated note events arrive, signed', ev.includes('note.created:Renamed') || ev.includes('note.updated:Renamed'))
  check('…with an HMAC signature of the body', hookCalls.every((c) => /^sha256=[0-9a-f]{64}$/.test(c.headers['x-notes-signature'] || '')))
  const ok = hookCalls.every((c) => c.headers['x-notes-signature'] === 'sha256=' + crypto.createHmac('sha256', process.env.NOTES_WEBHOOK_SECRET || '').update(JSON.stringify(c.body)).digest('hex'))
  check('…that verifies with the shared secret', ok)
  hookCalls = []
  A.doc.transact(() => A.doc.getMap('notes').get('rm2').set('deleted', Date.now()))
  await sleep(900)
  check('trashing a note sends note.trashed', hookCalls.some((c) => c.body.event === 'note.trashed' && c.body.note.id === 'rm2'))
  hookServer.close()
}

A.close()
console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'))
process.exit(failures === 0 ? 0 : 1)
