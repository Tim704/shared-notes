// [[Wiki links]], #tags and @dates across the whole board, shared by the
// browser, the server (REST API, reminders) and the tests. Pure JS: the board
// is one Y.Doc that is already in memory, so every scan here is a plain walk
// with no index.
//
// A link is `[[Title]]`, `[[Title#Heading]]` (a heading in that note) or
// `[[Title^lineId]]` (one line, by its `bid`). Titles match case-insensitively,
// and a note's aliases count as titles. Links are stored as their text, so the
// Markdown mirror and its history stay readable; renaming a note rewrites them
// (rewriteLinks) instead of resolving through ids.

import { linesOf } from './lines.js'
import { tabsOf } from './serialise.js'

export const WIKI_RE = /\[\[([^\]\n]+)\]\]/g
// #tag or #tag/sub, after a space or the start of the text; at least one
// character must not be a digit (so "#1" and "#2024" stay plain text)
export const TAG_RE = /(^|[\s(,;])#((?=[\p{L}\p{N}_/-]*[\p{L}_-])[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/gu
export const DATE_RE = /(^|[\s(])@(\d{4}-\d{2}-\d{2})(?![\w-])/g

const text = (v) => (v == null ? '' : typeof v.toString === 'function' ? v.toString() : String(v))
const isMap = (m) => m && typeof m.get === 'function'

/** Lower-case, trimmed, inner spaces collapsed: how titles are compared. */
export const normTitle = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase()

/** "Title#Heading" / "Title^id" / "Title" → { title, heading, block }. */
export function parseTarget(inner) {
  const s = String(inner || '')
  const m = /^([^#^]*)(?:#([^^]*))?(?:\^([\w-]+))?$/.exec(s)
  if (!m) return { title: s.trim(), heading: null, block: null }
  return { title: m[1].trim(), heading: m[2] != null && m[2].trim() ? m[2].trim() : null, block: m[3] || null }
}

/** Every [[link]] in a string: [{ start, end, inner, title, heading, block }]. */
export function wikiLinks(str) {
  const out = []
  const s = String(str || '')
  WIKI_RE.lastIndex = 0
  let m
  while ((m = WIKI_RE.exec(s))) out.push({ start: m.index, end: m.index + m[0].length, inner: m[1], ...parseTarget(m[1]) })
  return out
}

/** A note's aliases (a plain array of strings on the note, or nothing). */
export function aliasesOf(note) {
  const v = isMap(note) ? note.get('aliases') : note && note.aliases
  const arr = Array.isArray(v) ? v : v && typeof v.toArray === 'function' ? v.toArray() : []
  return arr.map((a) => String(a || '').trim()).filter(Boolean)
}

/** Title then aliases: every name a link can use for this note. */
export function namesOf(note) {
  const t = text(isMap(note) ? note.get('title') : note && note.title).trim()
  return [t, ...aliasesOf(note)].filter(Boolean)
}

const hiddenNote = (n) => typeof n.get('deleted') === 'number' || n.get('archived') === true

/**
 * Every rich-text body on the board: note bodies (and second pages) and
 * document tabs. [{ kind: 'note'|'page', id, tabId, title, ytext, hidden }]
 * Trash and archived notes are included only with { includeHidden: true }.
 */
export function bodiesOf(ydoc, opts = {}) {
  const out = []
  ydoc.getMap('notes').forEach((n, id) => {
    if (!isMap(n) || n.get('kind') === 'todo') return
    const hidden = hiddenNote(n)
    if (hidden && !opts.includeHidden) return
    const base = { kind: 'note', id, tabId: n.get('tabId') == null ? null : String(n.get('tabId')), title: text(n.get('title')).trim(), hidden }
    for (const field of ['body', 'body2']) {
      const yt = n.get(field)
      if (yt && typeof yt.toDelta === 'function' && yt.length) out.push({ ...base, field, ytext: yt })
    }
  })
  const pages = ydoc.getMap('pages')
  for (const t of tabsOf(ydoc)) {
    if (t.kind !== 'doc') continue
    if (t.archived && !opts.includeHidden) continue
    const p = pages.get(t.id)
    const yt = isMap(p) ? p.get('body') : null
    if (yt && typeof yt.toDelta === 'function' && yt.length) out.push({ kind: 'page', id: t.id, tabId: t.id, title: t.name, field: 'body', ytext: yt, hidden: t.archived })
  }
  return out
}

/** Replace [start, start+len) of a Y.Text with `str`, keeping the marks of the first replaced character. */
function replaceKeepingMarks(ytext, start, len, str) {
  let marks = {}
  let pos = 0
  for (const op of ytext.toDelta()) {
    const l = typeof op.insert === 'string' ? op.insert.length : 1
    if (start < pos + l) {
      marks = { ...(op.attributes || {}) }
      break
    }
    pos += l
  }
  // line attributes live on '\n' only; never copy them onto text
  for (const k of ['lt', 'mk', 'ind', 'done', 'ts', 'co', 'al', 'bid', 'ew']) delete marks[k]
  ytext.delete(start, len)
  if (str) ytext.insert(start, str, marks)
}

/**
 * A note (or tab) called `from` is now called `to`: rewrite every [[from]],
 * [[from#…]] and [[from^…]] on the board, trash and archive included (so
 * restoring a note never brings back a dead link). Run inside a transaction by
 * the caller, or pass `origin` to get one. Returns how many links changed.
 */
export function rewriteLinks(ydoc, from, to, origin = 'links') {
  const want = normTitle(from)
  const next = String(to || '').trim()
  if (!want || !next || normTitle(next) === want) return 0
  let count = 0
  ydoc.transact(() => {
    for (const b of bodiesOf(ydoc, { includeHidden: true })) {
      const hits = wikiLinks(b.ytext.toString()).filter((l) => normTitle(l.title) === want)
      // back to front, so earlier offsets stay valid
      for (let k = hits.length - 1; k >= 0; k--) {
        const l = hits[k]
        const at = l.start + 2 + (l.inner.length - l.inner.trimStart().length)
        replaceKeepingMarks(b.ytext, at, l.title.length, next)
        count++
      }
    }
  }, origin)
  return count
}

/** Is `name` still the title (or alias) of a live note other than `exceptId`? */
export function nameTaken(ydoc, name, exceptId) {
  const want = normTitle(name)
  if (!want) return false
  let taken = false
  ydoc.getMap('notes').forEach((n, id) => {
    if (taken || id === exceptId || !isMap(n) || typeof n.get('deleted') === 'number') return
    if (namesOf(n).some((x) => normTitle(x) === want)) taken = true
  })
  return taken
}

/**
 * A note was renamed from `from` to `to`: rewrite the links that pointed at it,
 * unless another live note still answers to `from` (those links may mean it).
 */
export function followRename(ydoc, noteId, from, to, origin) {
  if (!normTitle(from) || !normTitle(to) || normTitle(from) === normTitle(to)) return 0
  if (nameTaken(ydoc, from, noteId)) return 0
  return rewriteLinks(ydoc, from, to, origin)
}

/**
 * Where a note is linked from. `names` are the note's title and aliases.
 * [{ kind, id, tabId, title, line, index }] one per linking line, in board order.
 */
export function backlinks(ydoc, names, opts = {}) {
  const want = new Set(names.map(normTitle).filter(Boolean))
  if (!want.size) return []
  const out = []
  for (const b of bodiesOf(ydoc)) {
    if (opts.excludeId && b.id === opts.excludeId) continue
    const lines = linesOf(b.ytext)
    lines.forEach((L, index) => {
      if (L.text.indexOf('[[') < 0) return
      if (wikiLinks(L.text).some((l) => want.has(normTitle(l.title)))) out.push({ kind: b.kind, id: b.id, tabId: b.tabId, title: b.title, field: b.field, line: L.text, index })
    })
  }
  return out
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Places where a note's name appears as plain text (a whole word, any case),
 * outside [[links]] and web addresses. Names shorter than 3 characters are
 * ignored: they match too much. [{ kind, id, tabId, title, line, index, start, len, name }]
 * where start/len are offsets in that body's Y.Text.
 */
export function unlinkedMentions(ydoc, names, opts = {}) {
  const list = names.map((n) => String(n || '').trim()).filter((n) => n.length >= 3)
  if (!list.length) return []
  // longest first, so "New York trip" wins over "New York"
  list.sort((a, b) => b.length - a.length)
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(${list.map(escapeRe).join('|')})(?![\\p{L}\\p{N}_])`, 'giu')
  const out = []
  for (const b of bodiesOf(ydoc)) {
    if (opts.excludeId && b.id === opts.excludeId) continue
    const lines = linesOf(b.ytext)
    lines.forEach((L, index) => {
      const blocked = []
      for (const l of wikiLinks(L.text)) blocked.push([l.start, l.end])
      const url = /https?:\/\/\S+/g
      let u
      while ((u = url.exec(L.text))) blocked.push([u.index, u.index + u[0].length])
      // labelled links are links already
      let pos = 0
      for (const r of L.runs) {
        if (r.marks && r.marks.href) blocked.push([pos, pos + r.text.length])
        pos += r.text.length
      }
      re.lastIndex = 0
      let m
      while ((m = re.exec(L.text))) {
        const s = m.index + m[1].length
        const e = s + m[2].length
        if (blocked.some(([a, z]) => s < z && e > a)) continue
        out.push({ kind: b.kind, id: b.id, tabId: b.tabId, title: b.title, field: b.field, line: L.text, index, start: L.start + s, len: m[2].length, name: m[2] })
      }
    })
  }
  return out
}

/** Turn the plain text at [start, start+len) into [[title]] (one transaction). */
export function linkMention(ytext, start, len, title, origin = 'links') {
  ytext.doc.transact(() => replaceKeepingMarks(ytext, start, len, '[[' + title + ']]'), origin)
}

// ---- tags --------------------------------------------------------------------

/** The #tags in a string, as written (without the #). */
export function tagsIn(str) {
  const out = []
  TAG_RE.lastIndex = 0
  let m
  while ((m = TAG_RE.exec(String(str || '')))) out.push(m[2])
  return out
}

/** Does a tag list contain `want` or one of its children (#a matches #a and #a/b)? */
export function hasTag(tags, want) {
  const w = String(want || '').replace(/^#/, '').toLowerCase()
  if (!w) return false
  return tags.some((t) => {
    const l = t.toLowerCase()
    return l === w || l.startsWith(w + '/')
  })
}

/** Every tag on live notes with how many notes carry it; parents count their children. */
export function tagCounts(ydoc) {
  const counts = new Map() // lower → { name, count }
  ydoc.getMap('notes').forEach((n) => {
    if (!isMap(n) || hiddenNote(n)) return
    const seen = new Set()
    for (const t of tagsIn(text(n.get('title')) + '\n' + text(n.get('body')) + '\n' + text(n.get('body2')))) {
      const parts = t.split('/')
      for (let i = 1; i <= parts.length; i++) {
        const name = parts.slice(0, i).join('/')
        const key = name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        const c = counts.get(key) || { name, count: 0 }
        c.count++
        counts.set(key, c)
      }
    }
  })
  return Array.from(counts.values()).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
}

/**
 * Rename #from to #to everywhere (titles and bodies, trash included), children
 * too: #from/x becomes #to/x. Renaming onto an existing tag merges them.
 */
export function renameTag(ydoc, from, to, origin = 'tags') {
  const f = String(from || '').replace(/^#/, '')
  const t = String(to || '').replace(/^#/, '').trim()
  if (!f || !t || !/^[\p{L}\p{N}_-]+(\/[\p{L}\p{N}_-]+)*$/u.test(t)) return 0
  const re = new RegExp(`(^|[\\s(,;])#(${escapeRe(f)})(?=$|[^\\p{L}\\p{N}_-])`, 'giu')
  let count = 0
  const fix = (yt) => {
    if (!yt || typeof yt.toString !== 'function' || typeof yt.delete !== 'function') return
    const s = yt.toString()
    const hits = []
    re.lastIndex = 0
    let m
    while ((m = re.exec(s))) hits.push(m.index + m[1].length + 1) // just after '#'
    for (let k = hits.length - 1; k >= 0; k--) {
      replaceKeepingMarks(yt, hits[k], f.length, t)
      count++
    }
  }
  ydoc.transact(() => {
    ydoc.getMap('notes').forEach((n) => {
      if (!isMap(n)) return
      fix(n.get('title'))
      fix(n.get('body'))
      fix(n.get('body2'))
    })
    for (const b of bodiesOf(ydoc, { includeHidden: true })) if (b.kind === 'page') fix(b.ytext)
  }, origin)
  return count
}

// ---- checkboxes with dates ------------------------------------------------------

/** The first @YYYY-MM-DD in a line's text, or null. */
export function dueOf(str) {
  DATE_RE.lastIndex = 0
  const m = DATE_RE.exec(String(str || ''))
  return m ? m[2] : null
}

/**
 * Checkbox lines from every live note (and document tab), for the To-do tab and
 * reminders: [{ kind, id, tabId, title, field, bid, index, text, done, state, due }]
 */
export function noteTodos(ydoc) {
  const out = []
  for (const b of bodiesOf(ydoc)) {
    linesOf(b.ytext).forEach((L, index) => {
      if (L.attrs.lt !== 'todo') return
      out.push({
        kind: b.kind,
        id: b.id,
        tabId: b.tabId,
        title: b.title,
        field: b.field,
        bid: L.attrs.bid || null,
        index,
        text: L.text,
        done: L.attrs.done === true,
        state: L.attrs.done ? 'x' : L.attrs.ts || ' ',
        due: dueOf(L.text),
      })
    })
  }
  return out
}
