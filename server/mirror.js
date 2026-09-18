// Markdown mirror: keeps a human-readable copy of the board on disk.
//
// After the board changes we wait a bit (debounced) and then regenerate
// <exportDir>/ from scratch:
//   <tab-slug>/<title-slug>--<id>.md   one file per note (trash excluded)
//   <tab-slug>/sketch.svg               one file per sketch tab
//   index.json                          what is where
//   README.md                           what this folder is
// Anything else in the folder (except .git, which server/history.js owns) is
// removed, so the folder always reflects the live board.
//
// The note file format is deliberately simple (front matter + heading + body)
// so the client can parse old versions back out of git history, see
// parseNoteMarkdown() below.

import fs from 'fs'
import path from 'path'

const LW = 1600 // sketch logical width  (must match src/draw.js)
const LH = 1000 // sketch logical height
const LINE_H = 1.25 // sketch text line height (must match src/draw.js)

// ---- small helpers -------------------------------------------------------

/** Tabs live in a Y.Array as either plain objects (legacy) or Y.Maps. Read both. */
export function tabRec(entry) {
  if (!entry) return { id: null, name: '', kind: 'notes', archived: false }
  const get = typeof entry.get === 'function' ? (k) => entry.get(k) : (k) => entry[k]
  return {
    id: get('id') == null ? null : String(get('id')),
    name: get('name') == null ? '' : String(get('name')),
    kind: get('kind') === 'draw' ? 'draw' : 'notes',
    archived: get('archived') === true,
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

// ---- delta -> markdown ---------------------------------------------------

// Y.Text.toDelta() gives [{ insert: 'text', attributes: { b, i, u, s } }, ...].
// Marks are applied per line inside a run so a formatted run that spans a
// newline still produces valid-looking markdown. Nothing is escaped: the
// client shows this raw, and escaping would make the text worse to read.
export function deltaToMarkdown(delta) {
  let out = ''
  for (const op of delta || []) {
    if (typeof op.insert !== 'string') continue
    const a = op.attributes || {}
    const open = (a.b ? '**' : '') + (a.i ? '*' : '') + (a.u ? '<u>' : '') + (a.s ? '~~' : '')
    const close = (a.s ? '~~' : '') + (a.u ? '</u>' : '') + (a.i ? '*' : '') + (a.b ? '**' : '')
    if (!open) {
      out += op.insert
      continue
    }
    out += op.insert
      .split('\n')
      .map((line) => (line.trim() ? open + line + close : line))
      .join('\n')
  }
  return out
}

const richToMarkdown = (v) => {
  if (v && typeof v.toDelta === 'function') return deltaToMarkdown(v.toDelta())
  return text(v)
}

/** Checklist items as `- [ ] text` lines. Accepts a Y.Array or a plain array. */
function itemsToMarkdown(items) {
  const arr = items && typeof items.toArray === 'function' ? items.toArray() : items || []
  return arr
    .map((it) => {
      const get = it && typeof it.get === 'function' ? (k) => it.get(k) : (k) => it && it[k]
      return `- [${get('done') === true ? 'x' : ' '}] ${text(get('text')).replace(/\n/g, ' ')}`
    })
    .join('\n')
}

// ---- note -> markdown file -----------------------------------------------

/**
 * Render one note (a Y.Map) to the mirror file format. `tab` is a tabRec().
 * Format (the client parses this back with parseNoteMarkdown):
 *   ---            front matter, `key: value` per line
 *   ---
 *   # <title>
 *   <blank>
 *   <body>         (book layout: body, a line `---`, body2)
 */
export function noteToMarkdown(note, tab) {
  const get = (k) => (note && typeof note.get === 'function' ? note.get(k) : note && note[k])
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
    ['x', Math.round(Number(get('x')) || 0)],
    ['y', Math.round(Number(get('y')) || 0)],
    ['w', Math.round(Number(get('w')) || 0)],
    ['h', Math.round(Number(get('h')) || 0)],
  ]
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')

  const title = text(get('title')).replace(/\s*\n\s*/g, ' ')
  let body
  if (kind === 'todo') body = itemsToMarkdown(get('items'))
  else body = richToMarkdown(get('body'))
  if (layout === 'book') body += '\n---\n' + richToMarkdown(get('body2'))

  return `---\n${front}\n---\n# ${title}\n\n${body}\n`
}

/**
 * Inverse of noteToMarkdown. Returns { front, title, body, body2 } where
 * front is the parsed front matter (x/y/w/h as numbers, archived as boolean,
 * everything else a string) and body/body2 keep the markdown marks in.
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
        else if (k === 'archived') front[k] = v.trim() === 'true'
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
    const get = s && typeof s.get === 'function' ? (k) => s.get(k) : (k) => s && s[k]
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

// ---- the mirror itself ---------------------------------------------------

const README =
  '# Shared Notes export\n\n' +
  'This folder is a read-only, human-readable mirror of the shared board, regenerated by the ' +
  'server a few seconds after every change: one Markdown file per note (grouped in a folder per ' +
  'tab, trash excluded), an SVG per sketch tab, and `index.json` listing what is where. Edits made ' +
  'here are overwritten on the next change, so treat it as a backup and a browsable history rather ' +
  'than a place to edit. When git is available the server also commits this folder after each ' +
  'batch of changes, which is what powers the per-note version history in the app.\n'

/**
 * Build the whole desired file set from the live doc, synchronously, as
 * { relativePath: content }. Kept separate from the disk I/O so the doc is
 * read at one consistent instant.
 */
export function buildMirror(ydoc) {
  const files = {}
  const yNotes = ydoc.getMap('notes')
  const yTabs = ydoc.getArray('tabs')
  const yDrawings = ydoc.getMap('drawings')

  // tabs, with unique slugs
  const used = new Set()
  const tabs = []
  const byId = new Map()
  for (const entry of yTabs.toArray()) {
    const t = tabRec(entry)
    if (t.id == null) continue
    let dir = slugify(t.name, 'tab')
    let n = 1
    while (used.has(dir)) dir = slugify(t.name, 'tab') + '-' + ++n
    used.add(dir)
    const rec = { ...t, dir, notes: [] }
    tabs.push(rec)
    byId.set(t.id, rec)
  }

  // notes (newest first, following `order`, then anything not in order)
  const order = ydoc.getArray('order').toArray()
  const seen = new Set()
  const ids = []
  for (const id of order) {
    if (yNotes.has(id) && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  for (const id of yNotes.keys()) if (!seen.has(id)) ids.push(id)

  let orphans = null
  for (const id of ids) {
    const note = yNotes.get(id)
    if (!note || typeof note.get !== 'function') continue
    if (typeof note.get('deleted') === 'number') continue // in the trash
    let tab = byId.get(String(note.get('tabId')))
    if (!tab) {
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
    // noteToMarkdown reads `id` from the map; notes store it only as the key
    files[file] = noteToMarkdown(withId(note, id), tab)
    tab.notes.push({ id, title, file })
  }

  for (const tab of tabs) {
    if (tab.kind !== 'draw') continue
    try {
      files[`${tab.dir}/sketch.svg`] = sketchToSvg(yDrawings.get(tab.id))
    } catch (err) {
      console.error('Mirror: sketch export failed for tab', tab.id, err.message)
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
          dir: t.dir,
          notes: t.notes,
        })),
      },
      null,
      2
    ) + '\n'
  files['README.md'] = README
  return files
}

/** A thin view over a note Y.Map that also answers `id` (which lives on the parent map's key). */
function withId(note, id) {
  return { get: (k) => (k === 'id' ? id : note.get(k)) }
}

/**
 * Write the file set to exportDir and remove anything else (never `.git`).
 * Files whose content is unchanged are left alone (kinder to SD cards, and
 * keeps git diffs honest). Returns the number of files written.
 */
export async function writeMirror(exportDir, files) {
  const fsp = fs.promises
  await fsp.mkdir(exportDir, { recursive: true })
  const wanted = new Set(Object.keys(files))
  const wantedDirs = new Set()
  for (const rel of wanted) {
    for (let d = path.dirname(rel); d && d !== '.'; d = path.dirname(d)) wantedDirs.add(d)
  }

  let written = 0
  for (const rel of wanted) {
    const abs = path.join(exportDir, rel)
    let current = null
    try {
      current = await fsp.readFile(abs, 'utf8')
    } catch {
      /* new file */
    }
    if (current === files[rel]) continue
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, files[rel])
    written++
  }

  // sweep: delete anything we did not just want
  const sweep = async (relDir) => {
    const abs = path.join(exportDir, relDir)
    let entries
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const rel = relDir ? relDir + '/' + e.name : e.name
      if (rel === '.git') continue
      if (e.isDirectory()) {
        if (wantedDirs.has(rel)) await sweep(rel)
        else await fsp.rm(abs + '/' + e.name, { recursive: true, force: true })
      } else if (!wanted.has(rel)) {
        await fsp.rm(abs + '/' + e.name, { force: true })
      }
    }
  }
  await sweep('')
  return written
}

/**
 * Wire the mirror to a doc. Returns { schedule, flush, stop }.
 *   schedule(): call on every doc change; regenerates `debounceMs` after the last call
 *   flush():    regenerate now (returns a promise)
 *   onWritten(): called after each successful write (history hooks its commit here)
 */
export function createMirror({ ydoc, exportDir, debounceMs = 3000, onWritten = null }) {
  let timer = null
  let running = false
  let dirty = false

  async function run() {
    if (running) {
      dirty = true
      return
    }
    running = true
    try {
      const files = buildMirror(ydoc) // sync snapshot of the doc
      const n = await writeMirror(exportDir, files)
      if (n > 0 && onWritten) onWritten(n)
    } catch (err) {
      console.error('Mirror write failed:', err.message)
    } finally {
      running = false
      if (dirty) {
        dirty = false
        schedule()
      }
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      run()
    }, debounceMs)
  }

  return {
    schedule,
    flush: run,
    stop: () => {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
