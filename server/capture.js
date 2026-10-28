// Quick capture: add lines to a note from anywhere (POST /api/capture, the
// Android share sheet's POST /share, an iOS Shortcut). The text goes to the end
// of a note called "Inbox" unless another note is named, or under a heading in
// it. A missing note is made in the first NotePad tab (or the one named).

import * as Y from 'yjs'
import { linesOf, markdownToLines } from '../shared/lines.js'
import { insertLinesAt, appendLines } from '../shared/lineops.js'
import { tabsOf } from '../shared/serialise.js'
import { normTitle, namesOf } from '../shared/links.js'

const EDITOR = { id: 'api', name: 'Capture' }
const genId = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36)

/** Lines for captured text: Markdown prefixes are honoured; `as` forces a type for plain lines. */
export function captureLines(text, as) {
  const lines = markdownToLines(String(text || '').replace(/\r\n?/g, '\n').trim())
  if (as !== 'todo' && as !== 'li') return lines
  return lines.map((l) => (l.attrs.lt || !l.text.trim() ? l : { ...l, attrs: as === 'todo' ? { lt: 'todo' } : { lt: 'li', mk: 'disc' } }))
}

/**
 * capture(ydoc, { text, note, heading, tab, as }) → { id, title, created }
 *   note     a note id, or a title (default "Inbox"; matches aliases too)
 *   heading  put the lines at the end of this heading's section (made if missing)
 *   tab      a tab id or name, for a note that has to be made
 *   as       'todo' | 'li': plain lines become checkboxes / bullets
 * Throws { status, message } for bad input.
 */
export function capture(ydoc, input = {}) {
  const lines = captureLines(input.text, input.as)
  if (!lines.some((l) => l.text.trim())) throw { status: 400, message: 'text is required' }
  const yNotes = ydoc.getMap('notes')
  const want = input.note == null || String(input.note).trim() === '' ? 'Inbox' : String(input.note).trim()

  let id = null
  const byId = yNotes.get(want)
  if (byId && typeof byId.get === 'function' && typeof byId.get('deleted') !== 'number') id = want
  if (!id) {
    // by name: a live note first (not archived first)
    let best = null
    yNotes.forEach((n, nid) => {
      if (!n || typeof n.get !== 'function' || typeof n.get('deleted') === 'number' || n.get('kind') === 'todo') return
      if (!namesOf(n).some((x) => normTitle(x) === normTitle(want))) return
      const score = n.get('archived') ? 0 : 1
      if (!best || score > best.score) best = { nid, score }
    })
    if (best) id = best.nid
  }

  let created = false
  const tabs = tabsOf(ydoc).filter((t) => t.kind === 'notes')
  let tab = null
  if (!id) {
    if (input.tab != null) {
      const tq = String(input.tab)
      tab = tabs.find((t) => t.id === tq) || tabs.find((t) => normTitle(t.name) === normTitle(tq)) || null
      if (!tab) throw { status: 404, message: 'unknown tab' }
    } else tab = tabs.find((t) => !t.archived) || tabs[0] || null
    if (!tab) throw { status: 409, message: 'no NotePad tab to put the note in' }
  }

  ydoc.transact(() => {
    if (!id) {
      id = genId()
      created = true
      const n = new Y.Map()
      const title = new Y.Text()
      title.insert(0, want)
      n.set('title', title)
      n.set('body', new Y.Text())
      n.set('kind', 'note')
      n.set('color', '#fff7a8')
      n.set('created', Date.now())
      n.set('tabId', tab.id)
      n.set('fontSize', 14)
      n.set('size', 'm')
      let z = 0
      let count = 0
      yNotes.forEach((m) => {
        if (!m || typeof m.get !== 'function') return
        z = Math.max(z, Number(m.get('z')) || 0)
        if (m.get('tabId') === tab.id && typeof m.get('deleted') !== 'number') count++
      })
      n.set('x', 24 + (count % 7) * 28)
      n.set('y', 24 + (count % 7) * 28)
      n.set('w', 250)
      n.set('h', 200)
      n.set('z', z + 1)
      yNotes.set(id, n)
      ydoc.getArray('order').unshift([id])
    }
    const n = yNotes.get(id)
    if (n.get('archived') === true) n.delete('archived')
    const body = n.get('body')
    if (input.heading != null && String(input.heading).trim()) {
      const h = String(input.heading).trim()
      const ls = linesOf(body)
      const at = ls.findIndex((L) => L.attrs.lt === 'h' && normTitle(L.text) === normTitle(h))
      if (at < 0) appendLines(body, [{ text: h, attrs: { lt: 'h' } }, ...lines])
      else {
        // the end of that heading's section: the next heading, minus trailing blank lines
        let end = ls.findIndex((L, i) => i > at && L.attrs.lt === 'h')
        if (end < 0) end = ls.length
        while (end - 1 > at && !ls[end - 1].text.trim() && !ls[end - 1].attrs.lt) end--
        const prev = ls[end - 1]
        if (!prev.term) appendLines(body, lines)
        else insertLinesAt(body, prev.start + prev.len + 1, lines)
      }
    } else appendLines(body, lines)
    n.set('lastEditedAt', Date.now())
    n.set('lastEditedBy', EDITOR)
  }, 'api')
  return { id, title: yNotes.get(id).get('title').toString(), created }
}
