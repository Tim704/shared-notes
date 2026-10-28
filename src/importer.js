import * as Y from 'yjs'
import { markdownToLines } from '../shared/lines.js'
import { insertLinesAt } from '../shared/lineops.js'
import { parseNoteMarkdown } from '../shared/serialise.js'

// ---------------------------------------------------------------------------
// Import: Markdown folders (an Obsidian vault, this app's own mirror or backup)
// and Google Keep (Takeout). Folders become NotePad tabs, files become notes.
// Pictures the notes show are uploaded when they are among the chosen files.
//
// importFiles(files, { doc, me, upload(File[]) → urls, genId, makeTabMap, existingTabs })
//   → { notes, tabs: [{ id, name }], skipped }
// ---------------------------------------------------------------------------

const IMG = /\.(png|jpe?g|gif|webp|avif)$/i
const KEEP_COLORS = {
  DEFAULT: '#fff7a8', RED: '#ffadad', ORANGE: '#ffd6a5', YELLOW: '#fdffb6', GREEN: '#caffbf', TEAL: '#9bf6ff',
  BLUE: '#a0c4ff', CERULEAN: '#bde0fe', PURPLE: '#bdb2ff', PINK: '#ffc6ff', BROWN: '#e6ccb2', GRAY: '#e9ecef',
}

const relPath = (f) => String(f.webkitRelativePath || f.name || '').replace(/\\/g, '/')
const base = (p) => p.split('/').pop()
const stem = (p) => base(p).replace(/\.[^.]+$/, '')

/** Is this JSON one Google Keep note (from Takeout)? */
export function isKeepNote(o) {
  return !!o && typeof o === 'object' && ('textContent' in o || 'listContent' in o) && ('isTrashed' in o || 'userEditedTimestampUsec' in o)
}

/** A Keep note → { title, lines, color, pinned, archived, images: [paths], created } */
export function keepToNote(o) {
  const lines = []
  if (o.textContent) lines.push(...markdownToLines(String(o.textContent)))
  for (const it of o.listContent || []) lines.push({ text: String(it.text || '').replace(/\n/g, ' '), attrs: it.isChecked ? { lt: 'todo', done: true } : { lt: 'todo' } })
  const images = (o.attachments || []).filter((a) => /^image\//.test(a.mimetype || '') || IMG.test(a.filePath || '')).map((a) => a.filePath)
  const labels = (o.labels || []).map((l) => String(l.name || '').trim().replace(/\s+/g, '-')).filter(Boolean)
  if (labels.length) lines.push({ text: '', attrs: {} }, { text: labels.map((l) => '#' + l).join(' '), attrs: {} })
  return {
    title: String(o.title || '').trim(),
    lines,
    color: KEEP_COLORS[o.color] || KEEP_COLORS.DEFAULT,
    pinned: o.isPinned === true,
    archived: o.isArchived === true,
    images,
    created: o.createdTimestampUsec ? Math.round(Number(o.createdTimestampUsec) / 1000) : Date.now(),
  }
}

/** Split YAML front matter off an Obsidian note: { meta: { aliases, tags }, body } */
export function splitFrontMatter(src) {
  const s = String(src || '').replace(/\r\n/g, '\n')
  if (!s.startsWith('---\n')) return { meta: {}, body: s }
  const end = s.indexOf('\n---', 4)
  if (end < 0) return { meta: {}, body: s }
  const yaml = s.slice(4, end)
  const body = s.slice(end + 4).replace(/^[^\S\n]*\n/, '')
  const meta = {}
  // just what matters here: aliases and tags, as [a, b] or a "- a" list
  let key = null
  for (const line of yaml.split('\n')) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line)
    if (kv) {
      key = kv[1].toLowerCase()
      const v = kv[2].trim()
      if (v.startsWith('[')) meta[key] = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      else if (v) meta[key] = [v.replace(/^["']|["']$/g, '')]
      else meta[key] = []
      continue
    }
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && key && Array.isArray(meta[key])) meta[key].push(item[1].trim().replace(/^["']|["']$/g, ''))
  }
  return { meta, body }
}

export async function importFiles(files, ctx) {
  const { doc, me, upload, genId, makeTabMap } = ctx
  const list = Array.from(files)
  const images = new Map() // basename (lower) -> File
  for (const f of list) if (IMG.test(f.name)) images.set(f.name.toLowerCase(), f)
  const uploaded = new Map() // File -> url
  const imageUrl = async (ref) => {
    let name = base(String(ref).split(/[?#|]/)[0])
    try {
      name = decodeURIComponent(name)
    } catch {
      /* a stray % : use it as written */
    }
    name = name.toLowerCase()
    const f = images.get(name)
    if (!f) return null
    if (!uploaded.has(f)) {
      const [url] = await upload([f])
      uploaded.set(f, url || null)
    }
    return uploaded.get(f)
  }
  // pictures in Markdown: ![[x.png]] (Obsidian), ![](media/x.png) → /media/… if we have the file
  const fixImages = async (md) => {
    let out = String(md).replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (_m, p) => `![](${p.trim().replace(/ /g, '%20')})`)
    const refs = Array.from(out.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)).map((m) => m[1])
    for (const ref of new Set(refs)) {
      if (/^https?:/i.test(ref)) continue
      const url = await imageUrl(ref)
      if (url) out = out.split(`](${ref})`).join(`](${url})`)
    }
    return out
  }

  // ---- read everything into { tab, title, lines, … } first ----
  const notes = [] // { tab, title, lines, body2, color, x, y, w, h, pinned, archived, aliases, created, layout }
  const docs = [] // { tab, lines }
  let skipped = 0
  // a picked folder: every path starts with its name
  const roots = new Set(list.filter((f) => relPath(f).includes('/')).map((f) => relPath(f).split('/')[0]))
  for (const f of list) {
    const p = relPath(f)
    const parts = p.split('/')
    if (parts.some((x) => x.startsWith('.') || x === '__MACOSX')) continue // .obsidian, .trash, …
    const lower = f.name.toLowerCase()
    if (lower.endsWith('.json')) {
      let o = null
      try {
        o = JSON.parse(await f.text())
      } catch {
        skipped++
        continue
      }
      if (!isKeepNote(o)) {
        if (lower !== 'index.json') skipped++
        continue
      }
      if (o.isTrashed) continue
      const k = keepToNote(o)
      for (const pth of k.images) {
        const url = await imageUrl(pth)
        if (url) k.lines.push({ text: url, attrs: {} })
      }
      if (!k.title && !k.lines.length) continue
      notes.push({ tab: 'Google Keep', ...k })
      continue
    }
    if (!/\.(md|markdown|txt)$/.test(lower)) {
      if (!IMG.test(lower) && !lower.endsWith('.svg')) skipped++
      continue
    }
    // which tab: the folder under the chosen one (or the chosen folder for files at its top)
    const dirs = parts.slice(0, -1)
    const inRoot = roots.size === 1 && dirs.length ? dirs.slice(1) : dirs
    const tab = inRoot.length ? inRoot.join(' / ').slice(0, 28) : dirs.length ? dirs[0].slice(0, 28) : 'Imported'
    const raw = await f.text()
    if (lower === 'readme.md' && raw.startsWith('# Shared Notes export')) continue // our mirror's own README
    if (/^document--[\w-]+\.md$/.test(lower)) {
      // each document gets its own tab (two in one folder must not land on one page)
      const name = docs.some((d) => d.tab === tab) ? (tab + ' ' + (docs.filter((d) => d.tab.startsWith(tab)).length + 1)).slice(0, 28) : tab
      docs.push({ tab: name, lines: markdownToLines(await fixImages(raw)) })
      continue
    }
    if (raw.startsWith('---\n') && /\ntabId:/.test(raw.slice(0, 600))) {
      // this app's mirror file: front matter, "# title", body (and a second page for books)
      const v = parseNoteMarkdown(raw)
      const fr = v.front || {}
      notes.push({
        tab: fr.tab ? String(fr.tab).slice(0, 28) : tab,
        title: v.title,
        lines: markdownToLines(await fixImages(v.body)),
        body2: fr.layout === 'book' ? markdownToLines(await fixImages(v.body2)) : null,
        layout: fr.layout === 'book' ? 'book' : null,
        color: /^#[0-9a-f]{3,8}$/i.test(fr.color || '') ? fr.color : null,
        x: fr.x, y: fr.y, w: fr.w || null, h: fr.h || null,
        pinned: fr.pinned === true,
        archived: fr.archived === true,
        aliases: fr.aliases ? String(fr.aliases).split(',').map((a) => a.trim()).filter(Boolean) : [],
        created: Date.parse(fr.created) || Date.now(),
      })
      continue
    }
    const { meta, body } = splitFrontMatter(raw)
    const lines = markdownToLines(await fixImages(body))
    if (meta.tags && meta.tags.length) lines.push({ text: '', attrs: {} }, { text: meta.tags.map((t) => '#' + t.replace(/^#/, '').replace(/\s+/g, '-')).join(' '), attrs: {} })
    notes.push({ tab, title: stem(p), lines, aliases: (meta.aliases || []).slice(0, 10), created: f.lastModified || Date.now() })
  }

  // ---- then write it, one transaction per tab ----
  const tabsArr = doc.getArray('tabs')
  const yNotes = doc.getMap('notes')
  const yOrder = doc.getArray('order')
  const tabIdFor = new Map()
  const touched = []
  const findTab = (name, kind) => {
    for (const t of tabsArr.toArray()) {
      const get = typeof t.get === 'function' ? (k) => t.get(k) : (k) => t[k]
      if (String(get('name') || '').trim().toLowerCase() === name.trim().toLowerCase() && (get('kind') || 'notes') === kind && !get('archived')) return get('id')
    }
    return null
  }
  const tabFor = (name, kind = 'notes') => {
    const key = kind + ':' + name.toLowerCase()
    if (tabIdFor.has(key)) return tabIdFor.get(key)
    let id = kind === 'notes' ? findTab(name, kind) : null
    if (!id) {
      id = genId()
      tabsArr.push([makeTabMap({ id, name, kind })])
    }
    tabIdFor.set(key, id)
    touched.push({ id, name })
    return id
  }
  let z = 0
  yNotes.forEach((n) => (z = Math.max(z, Number(n?.get?.('z')) || 0)))
  const slots = new Map() // tab id -> next grid slot
  doc.transact(() => {
    for (const d of docs) {
      const id = tabFor(d.tab, 'doc')
      const page = new Y.Map()
      const title = new Y.Text()
      title.insert(0, d.tab)
      const body = new Y.Text()
      insertLinesAt(body, 0, d.lines.length ? d.lines : [{ text: '', attrs: {} }])
      page.set('title', title)
      page.set('body', body)
      doc.getMap('pages').set(id, page)
    }
    for (const n of notes) {
      const tabId = tabFor(n.tab)
      const slot = slots.get(tabId) || 0
      slots.set(tabId, slot + 1)
      const id = genId()
      const m = new Y.Map()
      const title = new Y.Text()
      if (n.title) title.insert(0, n.title.slice(0, 120))
      const body = new Y.Text()
      if (n.lines.length) insertLinesAt(body, 0, n.lines)
      m.set('title', title)
      m.set('body', body)
      if (n.layout === 'book') {
        const b2 = new Y.Text()
        if (n.body2 && n.body2.length) insertLinesAt(b2, 0, n.body2)
        m.set('body2', b2)
        m.set('layout', 'book')
      }
      m.set('kind', 'note')
      m.set('color', n.color || '#fff7a8')
      m.set('created', n.created || Date.now())
      m.set('tabId', tabId)
      m.set('fontSize', 14)
      m.set('size', 'm')
      const placed = Number.isFinite(n.x) && Number.isFinite(n.y) && (n.x || n.y)
      m.set('x', placed ? n.x : 16 + (slot % 4) * 260)
      m.set('y', placed ? n.y : 16 + Math.floor(slot / 4) * 220)
      m.set('w', n.w || (n.layout === 'book' ? 480 : 250))
      m.set('h', n.h || 200)
      m.set('z', ++z)
      if (n.pinned) m.set('pinned', true)
      if (n.archived) m.set('archived', true)
      if (n.aliases && n.aliases.length) m.set('aliases', n.aliases)
      m.set('lastEditedAt', Date.now())
      m.set('lastEditedBy', { id: me.id, name: me.name })
      yNotes.set(id, m)
      yOrder.unshift([id])
    }
  }, 'import')
  const uniq = []
  for (const t of touched) if (!uniq.some((u) => u.id === t.id)) uniq.push(t)
  return { notes: notes.length, docs: docs.length, tabs: uniq, skipped }
}
