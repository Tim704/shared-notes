// JSON REST API over the live board, for scripts, the Android widget and the
// client's history/export features. Mounted at /api by server.js. Every
// handler is wrapped so a bug answers 500 { error } instead of taking the
// server down. GETs that a widget polls send an ETag and honour
// If-None-Match, so an unchanged tab costs a 304 and no body.

import crypto from 'crypto'
import express from 'express'
import * as Y from 'yjs'
import {
  tabRec,
  text,
  noteView,
  searchText,
  snippetOf,
  edgesOf,
  exportMarkdown,
  exportJson,
  noteIdsOf,
} from '../shared/serialise.js'
import { linesOf, markdownToLines } from '../shared/lines.js'
import { insertLinesAt, appendLines, replaceAllLines, setLineAttrs, findLineById } from '../shared/lineops.js'
import { historyAvailable, listVersions, readVersion } from './history.js'

const NOTE_ID_RE = /^[A-Za-z0-9_-]+$/
const COMMIT_RE = /^[0-9a-f]{7,40}$/
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/
const API_EDITOR = { id: 'api', name: 'API' }

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

/** Send JSON with a weak ETag; answer 304 when the client already has it. */
function sendCached(req, res, data) {
  const body = JSON.stringify(data)
  const tag = 'W/"' + crypto.createHash('sha1').update(body).digest('base64url').slice(0, 20) + '"'
  res.setHeader('ETag', tag)
  res.setHeader('Cache-Control', 'no-cache')
  const inm = String(req.headers['if-none-match'] || '')
  if (inm && inm.split(',').some((t) => t.trim() === tag)) return res.status(304).end()
  res.type('application/json').send(body)
}

export function createApi({ ydoc }) {
  const yNotes = ydoc.getMap('notes')
  const yOrder = ydoc.getArray('order')
  const yTabs = ydoc.getArray('tabs')

  // ---- read helpers ------------------------------------------------------

  const tabs = () => yTabs.toArray().map(tabRec).filter((t) => t.id != null)
  const findTab = (id) => tabs().find((t) => t.id === String(id)) || null
  const isNote = (n) => n && typeof n.get === 'function'
  const inTrash = (n) => typeof n.get('deleted') === 'number'

  /** Non-deleted notes (or all with includeTrash) as [id, Y.Map] pairs. */
  const listNotes = (includeTrash) =>
    noteIdsOf(ydoc)
      .map((id) => [id, yNotes.get(id)])
      .filter(([, n]) => isNote(n) && (includeTrash || !inTrash(n)))

  /** The light shape a widget wants: title, a few lines, the todos, colour. */
  function noteSummary(id, n) {
    const lines = n.get('kind') === 'todo' ? [] : linesOf(n.get('body'))
    return {
      id,
      title: text(n.get('title')),
      color: n.get('color') || null,
      pinned: n.get('pinned') === true,
      archived: n.get('archived') === true,
      snippet: snippetOf(n, 140),
      todos: lines
        .map((L, index) => ({ L, index }))
        .filter(({ L }) => L.attrs.lt === 'todo')
        .map(({ L, index }) => ({ id: L.attrs.bid || null, index, text: L.text, done: L.attrs.done === true })),
      updatedAt: n.get('lastEditedAt') || n.get('created') || null,
    }
  }

  const touch = (n) => {
    n.set('lastEditedAt', Date.now())
    n.set('lastEditedBy', API_EDITOR)
  }

  /** Body input from the API: a string (Markdown-ish, `- [ ] ` makes todos) or [{ text, type, done, indent }]. */
  function toLines(input) {
    if (Array.isArray(input)) {
      return input.map((l) => {
        const o = l && typeof l === 'object' ? l : { text: String(l) }
        const attrs = {}
        if (o.type === 'todo') attrs.lt = 'todo'
        else if (o.type === 'li') attrs.lt = 'li'
        else if (o.type === 'h') attrs.lt = 'h'
        if (attrs.lt === 'todo' && o.done) attrs.done = true
        if (attrs.lt === 'li' && typeof o.marker === 'string') attrs.mk = o.marker
        const ind = Math.max(0, Math.min(5, Number(o.indent) || 0))
        if (ind && (attrs.lt === 'li' || attrs.lt === 'todo')) attrs.ind = ind
        return { text: String(o.text == null ? '' : o.text).replace(/\n/g, ' '), attrs }
      })
    }
    return markdownToLines(String(input))
  }

  // ---- router -----------------------------------------------------------

  const router = express.Router()
  router.use(express.json({ limit: '1mb' }))
  // clients that can't send PATCH (Android's HttpURLConnection) POST with an override header
  router.use((req, _res, next) => {
    const o = String(req.headers['x-http-method-override'] || '').toUpperCase()
    if (req.method === 'POST' && o === 'PATCH') req.method = 'PATCH'
    next()
  })

  router.get(
    '/tabs',
    safe((req, res) => {
      const includeTrash = req.query.trash === '1'
      const counts = new Map()
      for (const [, n] of listNotes(includeTrash)) {
        const t = String(n.get('tabId'))
        counts.set(t, (counts.get(t) || 0) + 1)
      }
      sendCached(req, res, tabs().map((t) => ({ ...t, count: counts.get(t.id) || 0 })))
    })
  )

  router.get(
    '/tabs/:id',
    safe((req, res) => {
      const tab = findTab(req.params.id)
      if (!tab) return res.status(404).json({ error: 'unknown tab' })
      const includeTrash = req.query.trash === '1'
      const pairs = listNotes(includeTrash).filter(([, n]) => String(n.get('tabId')) === tab.id)
      if (req.query.summary === '1') {
        const notes = pairs
          .filter(([, n]) => n.get('archived') !== true)
          .map(([id, n]) => noteSummary(id, n))
          .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
        return sendCached(req, res, { tab, notes })
      }
      const ids = new Set(pairs.map(([id]) => id))
      sendCached(req, res, {
        tab,
        notes: pairs.map(([id, n]) => noteView(id, n)),
        edges: edgesOf(ydoc).filter((e) => ids.has(e.from) && ids.has(e.to)),
      })
    })
  )

  router.post(
    '/tabs/:id/notes',
    safe((req, res) => {
      const tab = findTab(req.params.id)
      if (!tab) return res.status(404).json({ error: 'unknown tab' })
      if (tab.kind !== 'notes') return res.status(400).json({ error: 'not a notes tab' })
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const title = body.title == null ? '' : String(body.title).replace(/\s*\n\s*/g, ' ')
      const lines = body.lines != null ? toLines(body.lines) : body.body == null ? [] : toLines(body.body)
      const color = typeof body.color === 'string' && COLOR_RE.test(body.color) ? body.color : '#fff7a8'

      const id = genId()
      const now = Date.now()
      // stagger new notes so several API-created notes do not stack exactly on top of each other
      const count = listNotes(false).filter(([, n]) => String(n.get('tabId')) === tab.id).length
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
        n.set('lastEditedBy', API_EDITOR)
        yNotes.set(id, n)
        if (title) t.insert(0, title)
        if (lines.length) insertLinesAt(b, 0, lines)
        yOrder.unshift([id])
      }, 'api')
      res.status(201).json({ id })
    })
  )

  router.get(
    '/notes/:id',
    safe((req, res) => {
      const id = String(req.params.id)
      const n = yNotes.get(id)
      if (!isNote(n)) return res.status(404).json({ error: 'unknown note' })
      sendCached(req, res, { ...noteView(id, n), tabId: n.get('tabId') == null ? null : String(n.get('tabId')) })
    })
  )

  // PATCH /api/notes/:id  { title?, body? (replace), append? (add lines), color?, archived?, pinned? }
  router.patch(
    '/notes/:id',
    safe((req, res) => {
      const id = String(req.params.id)
      const n = yNotes.get(id)
      if (!isNote(n)) return res.status(404).json({ error: 'unknown note' })
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      if (body.color != null && !(typeof body.color === 'string' && COLOR_RE.test(body.color)))
        return res.status(400).json({ error: 'bad color' })
      if (n.get('kind') === 'todo' && (body.body != null || body.append != null))
        return res.status(409).json({ error: 'note is being migrated, try again' })
      ydoc.transact(() => {
        if (body.title != null) {
          const t = n.get('title')
          if (t.length) t.delete(0, t.length)
          const v = String(body.title).replace(/\s*\n\s*/g, ' ')
          if (v) t.insert(0, v)
        }
        if (body.body != null) replaceAllLines(n.get('body'), toLines(body.body))
        if (body.append != null) {
          const add = toLines(body.append)
          if (add.length) appendLines(n.get('body'), add)
        }
        if (body.color != null) n.set('color', body.color)
        if (body.archived != null) {
          if (body.archived) n.set('archived', true)
          else n.delete('archived')
        }
        if (body.pinned != null) {
          if (body.pinned) n.set('pinned', true)
          else n.delete('pinned')
        }
        touch(n)
      }, 'api')
      res.json(noteView(id, n))
    })
  )

  // PATCH /api/notes/:id/check  { lineId | itemId | index, done }
  router.patch(
    '/notes/:id/check',
    safe((req, res) => {
      const id = String(req.params.id)
      const n = yNotes.get(id)
      if (!isNote(n)) return res.status(404).json({ error: 'unknown note' })
      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const done = body.done === true || body.done === 'true' || body.done === 1
      const want = body.lineId != null ? String(body.lineId) : body.itemId != null ? String(body.itemId) : null

      // a checklist note that has not been migrated yet (the migration runs moments later)
      if (n.get('kind') === 'todo') {
        const items = n.get('items')
        const list = items && typeof items.toArray === 'function' ? items.toArray() : []
        const item = list.find((it) => it && typeof it.get === 'function' && it.get('id') === want)
        if (!item) return res.status(404).json({ error: 'unknown item' })
        ydoc.transact(() => {
          item.set('done', done)
          touch(n)
        }, 'api')
        return res.json({ id, lineId: want, itemId: want, done })
      }

      const ytext = n.get('body')
      let index = want != null ? findLineById(ytext, want) : -1
      if (want == null && Number.isInteger(Number(body.index))) index = Number(body.index)
      const L = index >= 0 ? linesOf(ytext)[index] : null
      if (!L || L.attrs.lt !== 'todo') return res.status(404).json({ error: 'unknown item' })
      ydoc.transact(() => {
        setLineAttrs(ytext, index, { done: done || null })
        touch(n)
      }, 'api')
      res.json({ id, lineId: L.attrs.bid || null, itemId: L.attrs.bid || null, index, done })
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
      const md = exportMarkdown(ydoc, { mediaPrefix: absoluteMedia(req) })
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="notes-${datestamp()}.md"`)
      res.send(md)
    })
  )

  router.get(
    '/export.json',
    safe((req, res) => {
      const data = exportJson(ydoc, { includeTrash: req.query.trash === '1' })
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

/** https://host/media/ for links in a downloaded export (so pictures resolve). */
function absoluteMedia(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0]
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost'
  return `${proto}://${host}/media/`
}

