// JSON REST API over the live board, for scripts, widgets and the client's
// history/export features. Mounted at /api by server.js. Every handler is
// wrapped so a bug answers 500 { error } instead of taking the server down.

import express from 'express'
import * as Y from 'yjs'
import { tabRec, text, deltaToMarkdown } from './mirror.js'
import { historyAvailable, listVersions, readVersion } from './history.js'

const NOTE_ID_RE = /^[A-Za-z0-9_-]+$/
const COMMIT_RE = /^[0-9a-f]{7,40}$/

/** Same id scheme as the browser client (src/util.js). */
const genId = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36)

/** Wrap an async handler so a throw becomes a 500 rather than an unhandled rejection. */
const safe = (fn) => async (req, res) => {
  try {
    await fn(req, res)
  } catch (err) {
    console.error('API error:', req.method, req.originalUrl, err.message)
    if (!res.headersSent) res.status(500).json({ error: 'internal error' })
  }
}

const datestamp = () => new Date().toISOString().slice(0, 10)

export function createApi({ ydoc }) {
  const yNotes = ydoc.getMap('notes')
  const yOrder = ydoc.getArray('order')
  const yTabs = ydoc.getArray('tabs')

  // ---- read helpers ------------------------------------------------------

  const tabs = () => yTabs.toArray().map(tabRec).filter((t) => t.id != null)
  const findTab = (id) => tabs().find((t) => t.id === String(id)) || null
  const isNote = (n) => n && typeof n.get === 'function'
  const inTrash = (n) => typeof n.get('deleted') === 'number'

  /** Ids in board order (newest first), then any note missing from `order`. */
  function noteIds() {
    const seen = new Set()
    const ids = []
    for (const id of yOrder.toArray()) {
      if (yNotes.has(id) && !seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
    for (const id of yNotes.keys()) if (!seen.has(id)) ids.push(id)
    return ids
  }

  /** Non-deleted notes (or all with includeTrash) as [id, Y.Map] pairs. */
  const listNotes = (includeTrash) =>
    noteIds()
      .map((id) => [id, yNotes.get(id)])
      .filter(([, n]) => isNote(n) && (includeTrash || !inTrash(n)))

  const itemsOf = (n) => {
    const items = n.get('items')
    if (!items || typeof items.toArray !== 'function') return []
    return items
      .toArray()
      .filter((it) => it && typeof it.get === 'function')
      .map((it) => ({ id: it.get('id'), text: text(it.get('text')), done: it.get('done') === true }))
  }

  /** The JSON shape of one note, as documented for GET /api/tabs/:id. */
  function noteView(id, n) {
    const editor = n.get('lastEditedBy')
    return {
      id,
      title: text(n.get('title')),
      kind: n.get('kind') === 'todo' ? 'todo' : 'note',
      body: text(n.get('body')),
      items: n.get('kind') === 'todo' ? itemsOf(n) : [],
      color: n.get('color') || null,
      created: n.get('created') || null,
      x: n.get('x') ?? null,
      y: n.get('y') ?? null,
      w: n.get('w') ?? null,
      h: n.get('h') ?? null,
      archived: n.get('archived') === true,
      layout: n.get('layout') === 'book' ? 'book' : 'single',
      body2: text(n.get('body2')),
      deleted: inTrash(n) ? n.get('deleted') : null,
      lastEditedAt: n.get('lastEditedAt') || null,
      lastEditedBy: editor && typeof editor === 'object' ? { id: editor.id, name: editor.name } : null,
    }
  }

  /** Searchable plain text of a note: title, body (or items), second page. */
  const searchText = (n) => {
    const parts = [text(n.get('title'))]
    if (n.get('kind') === 'todo') parts.push(...itemsOf(n).map((it) => it.text))
    else parts.push(text(n.get('body')), text(n.get('body2')))
    return parts.join('\n')
  }

  /** Note body as markdown for the whole-board export. */
  const bodyMarkdown = (n) => {
    if (n.get('kind') === 'todo') {
      return itemsOf(n)
        .map((it) => `- [${it.done ? 'x' : ' '}] ${it.text.replace(/\n/g, ' ')}`)
        .join('\n')
    }
    const rich = (v) => (v && typeof v.toDelta === 'function' ? deltaToMarkdown(v.toDelta()) : text(v))
    let md = rich(n.get('body'))
    if (n.get('layout') === 'book') md += '\n\n---\n\n' + rich(n.get('body2'))
    return md
  }

  /** Tabs with their notes: [{ tab, notes:[[id, Y.Map]] }] (notes with no known tab under a null tab). */
  function grouped(includeTrash) {
    const groups = tabs().map((tab) => ({ tab, notes: [] }))
    const byId = new Map(groups.map((g) => [g.tab.id, g]))
    let orphans = null
    for (const pair of listNotes(includeTrash)) {
      let g = byId.get(String(pair[1].get('tabId')))
      if (!g) {
        if (!orphans) {
          orphans = { tab: { id: null, name: '(no tab)', kind: 'notes', archived: false }, notes: [] }
          groups.push(orphans)
        }
        g = orphans
      }
      g.notes.push(pair)
    }
    return groups
  }

  // ---- router -----------------------------------------------------------

  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))

  router.get(
    '/tabs',
    safe((req, res) => {
      const includeTrash = req.query.trash === '1'
      const counts = new Map()
      for (const [, n] of listNotes(includeTrash)) {
        const t = String(n.get('tabId'))
        counts.set(t, (counts.get(t) || 0) + 1)
      }
      res.json(tabs().map((t) => ({ ...t, count: counts.get(t.id) || 0 })))
    })
  )

  router.get(
    '/tabs/:id',
    safe((req, res) => {
      const tab = findTab(req.params.id)
      if (!tab) return res.status(404).json({ error: 'unknown tab' })
      const includeTrash = req.query.trash === '1'
      const notes = listNotes(includeTrash)
        .filter(([, n]) => String(n.get('tabId')) === tab.id)
        .map(([id, n]) => noteView(id, n))
      res.json({ tab, notes })
    })
  )

  router.post(
    '/tabs/:id/notes',
    safe((req, res) => {
      const tab = findTab(req.params.id)
      if (!tab) return res.status(404).json({ error: 'unknown tab' })
      if (tab.kind !== 'notes') return res.status(400).json({ error: 'not a notes tab' })
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const title = body.title == null ? '' : String(body.title)
      const bodyText = body.body == null ? '' : String(body.body)
      const color = typeof body.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(body.color) ? body.color : '#fff7a8'

      const id = genId()
      const now = Date.now()
      // stagger new notes so several API-created notes do not stack exactly on top of each other
      const inTab = listNotes(false).filter(([, n]) => String(n.get('tabId')) === tab.id)
      const count = inTab.length
      let z = 0
      for (const [, n] of listNotes(true)) z = Math.max(z, Number(n.get('z')) || 0)

      ydoc.transact(() => {
        const n = new Y.Map()
        const t = new Y.Text()
        const b = new Y.Text()
        n.set('title', t)
        n.set('body', b)
        n.set('kind', 'note')
        n.set('color', color)
        n.set('created', now)
        n.set('tabId', tab.id)
        n.set('fontSize', 13)
        n.set('size', 'm')
        n.set('x', 24 + (count % 7) * 28)
        n.set('y', 24 + (count % 7) * 28)
        n.set('w', 250)
        n.set('h', 200)
        n.set('z', z + 1)
        n.set('lastEditedAt', now)
        n.set('lastEditedBy', { id: 'api', name: 'API' })
        yNotes.set(id, n)
        if (title) t.insert(0, title)
        if (bodyText) b.insert(0, bodyText)
        yOrder.unshift([id])
      }, 'api')
      res.status(201).json({ id })
    })
  )

  router.patch(
    '/notes/:id/check',
    safe((req, res) => {
      const n = yNotes.get(String(req.params.id))
      if (!isNote(n)) return res.status(404).json({ error: 'unknown note' })
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const items = n.get('items')
      const list = items && typeof items.toArray === 'function' ? items.toArray() : []
      const item = list.find((it) => it && typeof it.get === 'function' && it.get('id') === String(body.itemId))
      if (!item) return res.status(404).json({ error: 'unknown item' })
      const done = body.done === true || body.done === 'true' || body.done === 1
      ydoc.transact(() => {
        item.set('done', done)
        n.set('lastEditedAt', Date.now())
        n.set('lastEditedBy', { id: 'api', name: 'API' })
      }, 'api')
      res.json({ id: req.params.id, itemId: item.get('id'), done })
    })
  )

  router.get(
    '/search',
    safe((req, res) => {
      const q = String(req.query.q || '').trim().toLowerCase()
      if (!q) return res.json([])
      const tabName = new Map(tabs().map((t) => [t.id, t.name]))
      const hits = []
      for (const [id, n] of listNotes(req.query.trash === '1')) {
        const hay = searchText(n)
        const idx = hay.toLowerCase().indexOf(q)
        if (idx === -1) continue
        const start = Math.max(0, idx - 30)
        const snippet = hay.slice(start, start + 60).replace(/\s+/g, ' ').trim()
        const tabId = n.get('tabId') == null ? null : String(n.get('tabId'))
        hits.push({
          id,
          tabId,
          tabName: tabName.get(tabId) || '',
          title: text(n.get('title')),
          snippet,
          kind: n.get('kind') === 'todo' ? 'todo' : 'note',
        })
      }
      res.json(hits)
    })
  )

  router.get(
    '/history/:noteId',
    safe(async (req, res) => {
      const noteId = String(req.params.noteId)
      if (!NOTE_ID_RE.test(noteId)) return res.status(400).json({ error: 'bad note id' })
      const available = historyAvailable()
      const versions = available ? await listVersions(noteId) : []
      res.json({ available, versions })
    })
  )

  router.get(
    '/history/:noteId/:commit',
    safe(async (req, res) => {
      const noteId = String(req.params.noteId)
      const commit = String(req.params.commit)
      if (!NOTE_ID_RE.test(noteId) || !COMMIT_RE.test(commit)) return res.status(400).json({ error: 'bad id' })
      const v = await readVersion(noteId, commit)
      if (!v) return res.status(404).json({ error: 'no such version' })
      res.json({ title: v.title, body: v.body, body2: v.body2, front: v.front })
    })
  )

  router.get(
    '/export.md',
    safe((req, res) => {
      const out = [`# Shared Notes export (${new Date().toISOString()})`, '']
      for (const { tab, notes } of grouped(false)) {
        out.push(`# ${tab.name || '(untitled tab)'}${tab.archived ? ' (archived)' : ''}`, '')
        if (tab.kind === 'draw') {
          out.push('_Sketch tab: see sketch.svg in the export folder._', '')
          continue
        }
        for (const [, n] of notes) {
          out.push(`## ${text(n.get('title')).replace(/\s*\n\s*/g, ' ') || 'Untitled'}`, '')
          out.push(bodyMarkdown(n), '')
        }
      }
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="notes-${datestamp()}.md"`)
      res.send(out.join('\n'))
    })
  )

  router.get(
    '/export.json',
    safe((req, res) => {
      const data = {
        exportedAt: new Date().toISOString(),
        tabs: grouped(req.query.trash === '1').map(({ tab, notes }) => ({
          ...tab,
          notes: notes.map(([id, n]) => noteView(id, n)),
        })),
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="notes-${datestamp()}.json"`)
      res.send(JSON.stringify(data, null, 2))
    })
  )

  router.use((_req, res) => res.status(404).json({ error: 'not found' }))
  // body-parser errors (bad JSON) and anything else that slipped through
  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    const status = err && err.type === 'entity.parse.failed' ? 400 : err.status || 500
    if (status >= 500) console.error('API error:', err.message)
    if (!res.headersSent) res.status(status).json({ error: status === 400 ? 'bad request' : 'internal error' })
  })

  return router
}
