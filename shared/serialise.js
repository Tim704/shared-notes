// Board → readable files, shared by the server's Markdown mirror and REST
// exports and by the browser's own offline backup. Pure JS: no fs, no DOM.
//
// Mirror layout (also what a browser "auto-save to folder" writes):
//   <tab-slug>/<title-slug>--<id>.md   one file per note (trash excluded)
//   <tab-slug>/sketch.svg               one file per sketch tab
//   index.json                          what is where (+ connector arrows)
//   README.md                           what this folder is

import { linesOf, linesToMarkdown, linesToPlain, isList, MARKS } from './lines.js'

const LW = 1600 // sketch logical width  (must match src/draw.js)
const LH = 1000 // sketch logical height
const LINE_H = 1.25 // sketch text line height (must match src/draw.js)

// ---- small helpers -------------------------------------------------------

/** Tabs live in a Y.Array as either plain objects (legacy) or Y.Maps. Read both. */
export function tabRec(entry) {
  if (!entry) return { id: null, name: '', kind: 'notes', archived: false, view: 'board' }
  const get = typeof entry.get === 'function' ? (k) => entry.get(k) : (k) => entry[k]
  return {
    id: get('id') == null ? null : String(get('id')),
    name: get('name') == null ? '' : String(get('name')),
    kind: get('kind') === 'draw' ? 'draw' : 'notes',
    archived: get('archived') === true,
    view: get('view') === 'canvas' ? 'canvas' : 'board',
  }
}

/** Plain text of a Y.Text (or a plain string / missing value). */
export function text(v) {
  if (v == null) return ''
  return typeof v.toString === 'function' ? v.toString() : String(v)
}

/** Lowercase ascii slug, max 40 chars. Empty input yields the fallback. */
export function slugify(s, fallback = 'untitled') {
  const slug = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || fallback
}

const isoOrNull = (ms) => {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return null
  try {
    return new Date(n).toISOString()
  } catch {
    return null
  }
}

const getter = (o) => (o && typeof o.get === 'function' ? (k) => o.get(k) : (k) => o && o[k])

// ---- bodies ----------------------------------------------------------------

/** A Y.Text delta as Markdown (line-aware: lists, todos, headings, media). */
export function deltaToMarkdown(delta, opts) {
  return linesToMarkdown(linesOf({ toDelta: () => delta || [] }), opts)
}

export function richToMarkdown(v, opts) {
  if (v && typeof v.toDelta === 'function') return linesToMarkdown(linesOf(v), opts)
  return text(v)
}

/** Legacy whole-note checklist items (a Y.Array or a plain array). */
export function itemsOf(items) {
  const arr = items && typeof items.toArray === 'function' ? items.toArray() : items || []
  return arr
    .filter((it) => it && (typeof it.get === 'function' || typeof it === 'object'))
    .map((it) => {
      const get = getter(it)
      return { id: get('id'), text: text(get('text')), done: get('done') === true }
    })
}

function itemsToMarkdown(items) {
  return itemsOf(items)
    .map((it) => `- [${it.done ? 'x' : ' '}] ${it.text.replace(/\n/g, ' ')}`)
    .join('\n')
}

const isLegacyTodo = (get) => get('kind') === 'todo'

/** The body of a note as Markdown (book notes: left page, `---`, right page). */
export function noteBodyMarkdown(note, opts) {
  const get = getter(note)
  if (isLegacyTodo(get)) return itemsToMarkdown(get('items'))
  let md = richToMarkdown(get('body'), opts)
  if (get('layout') === 'book') md += '\n---\n' + richToMarkdown(get('body2'), opts)
  return md
}

/** Lines of a body in API form. */
export function linesView(ytext) {
  return linesOf(ytext).map((L, i) => {
    const a = L.attrs || {}
    return {
      id: a.bid || null,
      index: i,
      type: a.lt === 'li' ? 'li' : a.lt === 'todo' ? 'todo' : a.lt === 'h' ? 'h' : 'p',
      text: L.text,
      done: a.lt === 'todo' ? a.done === true : undefined,
      indent: isList(a) ? a.ind || 0 : 0,
      marker: a.lt === 'li' ? a.mk || 'disc' : undefined,
      align: a.al || 'left',
    }
  })
}

/** Searchable plain text of a note: title, body (or items), second page. */
export function searchText(note) {
  const get = getter(note)
  const parts = [text(get('title'))]
  if (isLegacyTodo(get)) parts.push(...itemsOf(get('items')).map((it) => it.text))
  else parts.push(text(get('body')), text(get('body2')))
  return parts.join('\n')
}

/** Short one-line preview of a body. */
export function snippetOf(note, max = 90) {
  const get = getter(note)
  let s = ''
  if (isLegacyTodo(get)) s = itemsOf(get('items')).map((it) => (it.done ? '☑ ' : '☐ ') + it.text).join('  ')
  else {
    const lines = linesOf(get('body'))
    s = lines.map((L) => (L.attrs.lt === 'todo' ? (L.attrs.done ? '☑ ' : '☐ ') : '') + L.text).join('  ')
  }
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

// ---- note -> markdown file -----------------------------------------------

/**
 * Render one note (a Y.Map or a {get} view) to the mirror file format.
 *   ---            front matter, `key: value` per line
 *   ---
 *   # <title>
 *   <blank>
 *   <body>         (book layout: body, a line `---`, body2)
 */
export function noteToMarkdown(note, tab, opts) {
  const get = getter(note)
  const t = tab || { id: get('tabId'), name: '' }
  const kind = get('kind') === 'todo' ? 'todo' : 'note'
  const layout = get('layout') === 'book' ? 'book' : 'single'
  const editor = get('lastEditedBy')
  const editorName = editor && typeof editor === 'object' ? editor.name : editor

  const front = [
    ['id', get('id') || ''],
    ['tab', String(t.name || '').replace(/\s*\n\s*/g, ' ')],
    ['tabId', t.id == null ? get('tabId') || '' : t.id],
    ['kind', kind],
    ['layout', layout],
    ['color', get('color') || ''],
    ['created', isoOrNull(get('created')) || ''],
    ['lastEditedAt', isoOrNull(get('lastEditedAt'))],
    ['lastEditedBy', editorName ? String(editorName).replace(/\n/g, ' ') : null],
    ['archived', get('archived') === true ? 'true' : null],
    ['pinned', get('pinned') === true ? 'true' : null],
    ['view', get('view') === 'map' ? 'map' : null],
    ['titleAlign', get('titleAlign') || null],
    ['x', Math.round(Number(get('x')) || 0)],
    ['y', Math.round(Number(get('y')) || 0)],
    ['w', Math.round(Number(get('w')) || 0)],
    ['h', Math.round(Number(get('h')) || 0)],
  ]
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')

  const title = text(get('title')).replace(/\s*\n\s*/g, ' ')
  const body = noteBodyMarkdown(note, opts)
  return `---\n${front}\n---\n# ${title}\n\n${body}\n`
}

/**
 * Inverse of noteToMarkdown. Returns { front, title, body, body2 } where
 * front is the parsed front matter (x/y/w/h as numbers, archived as boolean,
 * everything else a string) and body/body2 keep the markdown in.
 */
export function parseNoteMarkdown(raw) {
  const src = String(raw || '').replace(/\r\n/g, '\n')
  const front = {}
  let rest = src
  if (src.startsWith('---\n')) {
    const end = src.indexOf('\n---', 4)
    if (end !== -1) {
      for (const line of src.slice(4, end).split('\n')) {
        const m = /^([A-Za-z0-9_]+):\s?(.*)$/.exec(line)
        if (!m) continue
        const [, k, v] = m
        if (k === 'x' || k === 'y' || k === 'w' || k === 'h') front[k] = Number(v) || 0
        else if (k === 'archived' || k === 'pinned') front[k] = v.trim() === 'true'
        else front[k] = v
      }
      rest = src.slice(end + 4).replace(/^[^\S\n]*\n/, '')
    }
  }
  let title = ''
  if (rest.startsWith('# ')) {
    const nl = rest.indexOf('\n')
    title = nl === -1 ? rest.slice(2) : rest.slice(2, nl)
    rest = nl === -1 ? '' : rest.slice(nl + 1)
    if (rest.startsWith('\n')) rest = rest.slice(1) // the blank line after the heading
  }
  if (rest.endsWith('\n')) rest = rest.slice(0, -1)
  let body = rest
  let body2 = ''
  if (front.layout === 'book') {
    const lines = rest.split('\n')
    const cut = lines.indexOf('---')
    if (cut !== -1) {
      body = lines.slice(0, cut).join('\n')
      body2 = lines.slice(cut + 1).join('\n')
    }
  }
  return { front, title, body, body2 }
}

// ---- sketch -> svg -------------------------------------------------------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : 0)

/** Strokes and text labels (a Y.Array of Y.Map, or plain arrays/objects) as an SVG document. */
export function sketchToSvg(strokes) {
  const arr = strokes && typeof strokes.toArray === 'function' ? strokes.toArray() : strokes || []
  const lines = []
  const texts = []
  for (const s of arr) {
    const get = getter(s)
    if (get('type') === 'text') {
      const size = num(get('size')) || 24
      const x = num(get('x'))
      const y = num(get('y'))
      const spans = String(get('text') || '')
        .split('\n')
        .map((line, i) => `<tspan x="${x}" y="${num(y + i * size * LINE_H)}">${esc(line)}</tspan>`)
        .join('')
      texts.push(
        `<text fill="${esc(get('color') || '#1f2228')}" font-size="${size}" font-weight="600" ` +
          `font-family="system-ui, sans-serif" dominant-baseline="hanging">${spans}</text>`
      )
      continue
    }
    const raw = get('points')
    const pts = raw && typeof raw.toArray === 'function' ? raw.toArray() : raw || []
    if (pts.length < 2) continue
    const pairs = []
    for (let i = 0; i + 1 < pts.length; i += 2) pairs.push(num(pts[i]) + ',' + num(pts[i + 1]))
    if (pairs.length === 1) pairs.push(pairs[0]) // a dot: zero-length line with round caps
    const color = get('mode') === 'erase' ? '#ffffff' : get('color') || '#1f2228'
    lines.push(
      `<polyline fill="none" stroke="${esc(color)}" stroke-width="${num(get('width')) || 3}" ` +
        `stroke-linecap="round" stroke-linejoin="round" points="${pairs.join(' ')}"/>`
    )
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LW} ${LH}" width="${LW}" height="${LH}">\n` +
    `<rect width="${LW}" height="${LH}" fill="#ffffff"/>\n` +
    lines.join('\n') +
    (lines.length ? '\n' : '') +
    texts.join('\n') +
    (texts.length ? '\n' : '') +
    `</svg>\n`
  )
}

// ---- board walking -------------------------------------------------------

export function tabsOf(ydoc) {
  return ydoc
    .getArray('tabs')
    .toArray()
    .map(tabRec)
    .filter((t) => t.id != null)
}

/** Note ids in board order (newest first), then any note missing from `order`. */
export function noteIdsOf(ydoc) {
  const yNotes = ydoc.getMap('notes')
  const seen = new Set()
  const ids = []
  for (const id of ydoc.getArray('order').toArray()) {
    if (yNotes.has(id) && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  for (const id of yNotes.keys()) if (!seen.has(id)) ids.push(id)
  return ids
}

const isNote = (n) => n && typeof n.get === 'function'
const inTrash = (n) => typeof n.get('deleted') === 'number'

/** Tabs with their notes: [{ tab, notes:[[id, Y.Map]] }] (notes with no known tab under a null tab). */
export function groupNotes(ydoc, opts = {}) {
  const exclude = opts.excludeTabs || null
  const groups = tabsOf(ydoc)
    .filter((t) => !(exclude && exclude.has(t.id)))
    .map((tab) => ({ tab, notes: [] }))
  const byId = new Map(groups.map((g) => [g.tab.id, g]))
  const known = new Set(tabsOf(ydoc).map((t) => t.id))
  const yNotes = ydoc.getMap('notes')
  let orphans = null
  for (const id of noteIdsOf(ydoc)) {
    const n = yNotes.get(id)
    if (!isNote(n) || (!opts.includeTrash && inTrash(n))) continue
    const tid = String(n.get('tabId'))
    let g = byId.get(tid)
    if (!g) {
      if (known.has(tid)) continue // an excluded tab
      if (!orphans) {
        orphans = { tab: { id: null, name: '(no tab)', kind: 'notes', archived: false, view: 'board' }, notes: [] }
        groups.push(orphans)
      }
      g = orphans
    }
    g.notes.push([id, n])
  }
  return groups
}

/** Connector arrows between notes, as plain objects. */
export function edgesOf(ydoc) {
  return ydoc
    .getArray('edges')
    .toArray()
    .map((e) => {
      const get = getter(e)
      return {
        id: get('id'),
        from: get('from'),
        to: get('to'),
        label: get('label') || '',
        color: get('color') || null,
        style: get('style') === 'dashed' ? 'dashed' : 'solid',
        head: get('head') || 'arrow',
      }
    })
    .filter((e) => e.id && e.from && e.to)
}

/** The JSON shape of one note, as documented for GET /api/tabs/:id. */
export function noteView(id, n) {
  const editor = n.get('lastEditedBy')
  const legacyTodo = n.get('kind') === 'todo'
  return {
    id,
    title: text(n.get('title')),
    kind: legacyTodo ? 'todo' : 'note',
    body: legacyTodo ? '' : linesToPlain(linesOf(n.get('body'))),
    lines: legacyTodo
      ? itemsOf(n.get('items')).map((it, i) => ({ id: it.id, index: i, type: 'todo', text: it.text, done: it.done, indent: 0, align: 'left' }))
      : linesView(n.get('body')),
    items: legacyTodo ? itemsOf(n.get('items')) : [],
    color: n.get('color') || null,
    created: n.get('created') || null,
    x: n.get('x') ?? null,
    y: n.get('y') ?? null,
    w: n.get('w') ?? null,
    h: n.get('h') ?? null,
    archived: n.get('archived') === true,
    pinned: n.get('pinned') === true,
    layout: n.get('layout') === 'book' ? 'book' : 'single',
    body2: linesToPlain(linesOf(n.get('body2'))),
    deleted: inTrash(n) ? n.get('deleted') : null,
    lastEditedAt: n.get('lastEditedAt') || null,
    lastEditedBy: editor && typeof editor === 'object' ? { id: editor.id, name: editor.name } : null,
  }
}

// ---- whole-board exports ------------------------------------------------

/** One Markdown document with every tab and note. opts: { excludeTabs:Set, mediaPrefix } */
export function exportMarkdown(ydoc, opts = {}) {
  const out = [`# Shared Notes export (${new Date().toISOString()})`, '']
  for (const { tab, notes } of groupNotes(ydoc, opts)) {
    out.push(`# ${tab.name || '(untitled tab)'}${tab.archived ? ' (archived)' : ''}`, '')
    if (tab.kind === 'draw') {
      out.push('_Sketch tab: see sketch.svg in the export folder._', '')
      continue
    }
    for (const [, n] of notes) {
      out.push(`## ${text(n.get('title')).replace(/\s*\n\s*/g, ' ') || 'Untitled'}`, '')
      out.push(noteBodyMarkdown(n, opts), '')
    }
  }
  return out.join('\n')
}

/** The whole board as JSON. opts: { excludeTabs:Set, includeTrash } */
export function exportJson(ydoc, opts = {}) {
  const groups = groupNotes(ydoc, opts)
  const ids = new Set()
  for (const g of groups) for (const [id] of g.notes) ids.add(id)
  return {
    exportedAt: new Date().toISOString(),
    tabs: groups.map(({ tab, notes }) => ({ ...tab, notes: notes.map(([id, n]) => noteView(id, n)) })),
    edges: edgesOf(ydoc).filter((e) => ids.has(e.from) && ids.has(e.to)),
  }
}

// ---- the mirror file set -------------------------------------------------

export const MIRROR_README =
  '# Shared Notes export\n\n' +
  'This folder is a read-only, human-readable mirror of the shared board, regenerated a few ' +
  'seconds after every change: one Markdown file per note (grouped in a folder per tab, trash ' +
  'excluded), an SVG per sketch tab, and `index.json` listing what is where (plus the arrows ' +
  'between notes). Edits made here are overwritten on the next change, so treat it as a backup ' +
  'and a browsable history rather than a place to edit. On the Pi this folder is also a git ' +
  'repo, which is what powers the per-note version history in the app. Pictures live next to ' +
  'it in `media/` and are linked from the notes.\n'

/**
 * Build the whole desired file set from the doc, synchronously, as
 * { relativePath: content }. opts: { excludeTabs:Set, mediaPrefix, onError }
 */
export function buildMirror(ydoc, opts = {}) {
  const files = {}
  const yNotes = ydoc.getMap('notes')
  const yDrawings = ydoc.getMap('drawings')
  const exclude = opts.excludeTabs || null

  // tabs, with unique slugs
  const used = new Set()
  const tabs = []
  const byId = new Map()
  const known = new Set()
  for (const t of tabsOf(ydoc)) {
    known.add(t.id)
    if (exclude && exclude.has(t.id)) continue
    let dir = slugify(t.name, 'tab')
    let n = 1
    while (used.has(dir)) dir = slugify(t.name, 'tab') + '-' + ++n
    used.add(dir)
    const rec = { ...t, dir, notes: [] }
    tabs.push(rec)
    byId.set(t.id, rec)
  }

  let orphans = null
  const written = new Set()
  for (const id of noteIdsOf(ydoc)) {
    const note = yNotes.get(id)
    if (!isNote(note)) continue
    if (inTrash(note)) continue
    const tid = String(note.get('tabId'))
    let tab = byId.get(tid)
    if (!tab) {
      if (known.has(tid)) continue // excluded tab
      if (!orphans) {
        let dir = 'untabbed'
        let n = 1
        while (used.has(dir)) dir = 'untabbed-' + ++n
        used.add(dir)
        orphans = { id: null, name: '(no tab)', kind: 'notes', archived: false, dir, notes: [] }
        tabs.push(orphans)
      }
      tab = orphans
    }
    const title = text(note.get('title')).replace(/\s*\n\s*/g, ' ')
    const file = `${tab.dir}/${slugify(title)}--${id}.md`
    files[file] = noteToMarkdown(withId(note, id), tab, opts)
    tab.notes.push({ id, title, file })
    written.add(id)
  }

  for (const tab of tabs) {
    if (tab.kind !== 'draw') continue
    try {
      files[`${tab.dir}/sketch.svg`] = sketchToSvg(yDrawings.get(tab.id))
    } catch (err) {
      if (opts.onError) opts.onError('sketch export failed for tab ' + tab.id + ': ' + err.message)
    }
  }

  files['index.json'] =
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        tabs: tabs.map((t) => ({
          id: t.id,
          name: t.name,
          kind: t.kind,
          archived: t.archived,
          view: t.view,
          dir: t.dir,
          notes: t.notes,
        })),
        edges: edgesOf(ydoc).filter((e) => written.has(e.from) && written.has(e.to)),
      },
      null,
      2
    ) + '\n'
  files['README.md'] = MIRROR_README
  return files
}

/** A thin view over a note Y.Map that also answers `id` (which lives on the parent map's key). */
function withId(note, id) {
  return { get: (k) => (k === 'id' ? id : note.get(k)) }
}

export { MARKS }
