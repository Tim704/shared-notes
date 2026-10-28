// Search with operators, shared by the board's search box, Home and
// GET /api/search. Pure JS.
//
//   milk bread        every word must appear (any order)
//   "oat milk"        an exact phrase
//   -milk             must NOT appear (works with any operator: -tag:work)
//   tag:work          has #work (or #work/…)
//   tab:shopping      on a tab whose name contains "shopping"
//   is:todo           has an unticked checkbox      is:done   every checkbox ticked
//   is:pinned  is:archived
//   has:image         has a picture                 has:link  has a link
//   by:sam            last edited by someone called Sam
//
// A plain word of five letters or more also matches a word one typo away
// ("recieve" finds "receive"), so long as nothing matches it exactly.

import { linesOf, embedOf } from './lines.js'
import { tagsIn, hasTag } from './links.js'

const text = (v) => (v == null ? '' : typeof v.toString === 'function' ? v.toString() : String(v))

/** Split a query into terms: [{ neg, op, value }] (op null for plain words and phrases). */
export function parseQuery(q) {
  const out = []
  const re = /(-)?(?:(\w+):)?(?:"([^"]*)"?|(\S+))/g
  let m
  const s = String(q || '')
  while ((m = re.exec(s))) {
    if (!m[0].trim()) {
      re.lastIndex++
      continue
    }
    const neg = !!m[1]
    let op = m[2] ? m[2].toLowerCase() : null
    let value = (m[3] != null ? m[3] : m[4] || '').toLowerCase()
    const phrase = m[3] != null
    if (op && !OPS.has(op)) {
      // "word:thing" that isn't an operator is just text
      value = op + ':' + value
      op = null
    }
    if (!value && !op) continue
    out.push({ neg, op, value, phrase })
  }
  return out
}
const OPS = new Set(['tag', 'tab', 'is', 'has', 'by'])

/** Edit distance of at most one (insert, delete, substitute or swap two letters)? */
function oneEdit(a, b) {
  if (a === b) return true
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > 1) return false
  let i = 0
  while (i < la && i < lb && a[i] === b[i]) i++
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2) // swap
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

/**
 * Facts about a note that the operators need, computed once per search.
 * `note` is a Y.Map; `tabName` the name of its tab.
 */
export function noteFacts(note, tabName = '') {
  const get = (k) => note.get(k)
  const title = text(get('title'))
  const legacy = get('kind') === 'todo'
  const bodies = legacy ? [] : [get('body'), get('body2')].filter(Boolean)
  const lines = bodies.flatMap((b) => linesOf(b))
  let items = []
  if (legacy) {
    const it = get('items')
    items = (it && typeof it.toArray === 'function' ? it.toArray() : []).map((m) => ({ text: text(m.get('text')), done: m.get('done') === true }))
  }
  const hay = [title, ...bodies.map(text), ...items.map((i) => i.text)].join('\n')
  const todos = lines.filter((L) => L.attrs.lt === 'todo').map((L) => ({ done: L.attrs.done === true || L.attrs.ts === '-' })).concat(items)
  const editor = get('lastEditedBy')
  return {
    hay: hay.toLowerCase(),
    words: null, // filled lazily for typo matching
    tags: tagsIn(hay),
    tab: String(tabName || '').toLowerCase(),
    todo: todos.some((t) => !t.done),
    done: todos.length > 0 && todos.every((t) => t.done),
    image: get('kind') === 'image' || lines.some((L) => (embedOf(L.text) || {}).kind === 'image'),
    link: /\[\[[^\]]+\]\]|https?:\/\//.test(hay) || lines.some((L) => L.runs.some((r) => r.marks && r.marks.href)),
    pinned: get('pinned') === true,
    archived: get('archived') === true,
    by: editor && typeof editor === 'object' ? String(editor.name || '').toLowerCase() : String(editor || '').toLowerCase(),
  }
}

function termMatches(t, f, typos) {
  switch (t.op) {
    case 'tag':
      return hasTag(f.tags, t.value)
    case 'tab':
      return f.tab.includes(t.value)
    case 'by':
      return f.by.includes(t.value)
    case 'is':
      if (t.value === 'todo' || t.value === 'open') return f.todo
      if (t.value === 'done') return f.done
      if (t.value === 'pinned') return f.pinned
      if (t.value === 'archived') return f.archived
      return false
    case 'has':
      if (t.value === 'image' || t.value === 'picture') return f.image
      if (t.value === 'link') return f.link
      if (t.value === 'todo' || t.value === 'checkbox') return f.todo || f.done
      return false
    default: {
      if (f.hay.includes(t.value)) return true
      if (!typos || t.neg || t.phrase || t.value.length < 5 || /\s/.test(t.value)) return false
      if (!f.words) f.words = new Set(f.hay.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4))
      for (const w of f.words) if (oneEdit(t.value, w)) return true
      return false
    }
  }
}

/** Does a note (its facts) match every term? { typos: true } allows one-typo words. */
export function matchFacts(terms, facts, opts = {}) {
  for (const t of terms) {
    const hit = termMatches(t, facts, opts.typos !== false)
    if (hit === t.neg) return false
  }
  return true
}

/** Convenience: match a Y.Map note against a query string. */
export function matchNote(query, note, tabName, opts) {
  const terms = typeof query === 'string' ? parseQuery(query) : query
  if (!terms.length) return true
  return matchFacts(terms, noteFacts(note, tabName), opts)
}

/** Does the query use is:archived (so archived notes must be searched too)? */
export const wantsArchived = (terms) => terms.some((t) => t.op === 'is' && t.value === 'archived' && !t.neg)

/** The plain words of a query (for highlighting snippets). */
export const plainWords = (terms) => terms.filter((t) => !t.op && !t.neg).map((t) => t.value)
