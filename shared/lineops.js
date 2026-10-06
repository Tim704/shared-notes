// Structural edits on a note body (a Y.Text in the line model, see lines.js)
// that don't involve a caret: used by the server (migrations, REST API), the
// mind map and the editor itself. Callers wrap these in a transaction.

import { linesOf, fullLine, pickLine, genLineId, isList, subtreeEnds, MAX_IND } from './lines.js'

/** Make sure the body ends with '\n' so its last line can carry attributes. */
export function ensureTerminator(ytext) {
  const s = ytext.toString()
  if (!s.length || s[s.length - 1] !== '\n') ytext.insert(s.length, '\n', {})
}

/** Set/clear line attributes on line `i` (patch values of null clear a key). */
export function setLineAttrs(ytext, i, patch) {
  ensureTerminator(ytext)
  const lines = linesOf(ytext)
  const L = lines[i]
  if (!L) return
  const next = { ...pickLine(L.attrs), ...patch }
  for (const k of Object.keys(next)) if (next[k] == null || next[k] === false) delete next[k]
  ytext.format(L.start + L.len, 1, fullLine(next))
}

/**
 * Insert lines [{ text, attrs }] at character position `pos` (which must be a
 * line start). Each inserted line is terminated with its own '\n'.
 */
export function insertLinesAt(ytext, pos, newLines) {
  let p = pos
  for (const nl of newLines) {
    const attrs = { ...(nl.attrs || {}) }
    if ((attrs.lt === 'todo' || attrs.lt === 'li') && !attrs.bid) attrs.bid = genLineId()
    if (nl.text) {
      ytext.insert(p, nl.text, nl.marks || {})
      p += nl.text.length
    }
    ytext.insert(p, '\n', fullLine(attrs))
    p += 1
  }
  return p
}

/** Insert lines after line `i` (and after everything it owns when `afterSubtree`). */
export function insertLinesAfter(ytext, i, newLines, afterSubtree = false) {
  ensureTerminator(ytext)
  const lines = linesOf(ytext)
  let idx = Math.min(i, lines.length - 1)
  if (afterSubtree && idx >= 0) idx = subtreeEnds(lines)[idx] - 1
  const pos = idx < 0 ? 0 : lines[idx].start + lines[idx].len + 1
  insertLinesAt(ytext, pos, newLines)
  return idx + 1
}

/** Append lines at the very end of the body. */
export function appendLines(ytext, newLines) {
  const s = ytext.toString()
  // a body that is empty (or one blank line): write into it rather than after it
  if (s === '' || s === '\n') return replaceAllLines(ytext, newLines)
  ensureTerminator(ytext)
  insertLinesAt(ytext, ytext.length, newLines)
}

/** Replace the whole body with these lines. */
export function replaceAllLines(ytext, newLines) {
  if (ytext.length) ytext.delete(0, ytext.length)
  insertLinesAt(ytext, 0, newLines.length ? newLines : [{ text: '', attrs: {} }])
}

/** Replace the text of line `i`, keeping its attributes. */
export function setLineText(ytext, i, text) {
  const lines = linesOf(ytext)
  const L = lines[i]
  if (!L) return
  if (L.len) ytext.delete(L.start, L.len)
  if (text) ytext.insert(L.start, text, {})
}

/** Delete lines [from, to) entirely (text and terminators). */
export function deleteLines(ytext, from, to) {
  ensureTerminator(ytext)
  const lines = linesOf(ytext)
  if (from >= lines.length || to <= from) return
  const a = lines[from].start
  const last = lines[Math.min(to, lines.length) - 1]
  const b = last.start + last.len + (last.term ? 1 : 0)
  ytext.delete(a, b - a)
  if (!ytext.length) ytext.insert(0, '\n', {})
}

/**
 * Move lines [from, to) so they follow line `after` (-1 = to the top), shifting
 * the indent of list lines by `indDelta`. Formatting is preserved.
 */
export function moveLines(ytext, from, to, after, indDelta = 0) {
  ensureTerminator(ytext)
  const lines = linesOf(ytext)
  if (after >= from && after < to) return
  const chunk = []
  const delta = ytext.toDelta()
  const a = lines[from].start
  const last = lines[to - 1]
  const b = last.start + last.len + 1
  // slice the delta [a, b) into runs with attributes
  let pos = 0
  for (const op of delta) {
    if (typeof op.insert !== 'string') {
      pos += 1
      continue
    }
    const s = pos
    const e = pos + op.insert.length
    pos = e
    const lo = Math.max(s, a)
    const hi = Math.min(e, b)
    if (hi > lo) chunk.push({ text: op.insert.slice(lo - s, hi - s), attrs: op.attributes || {} })
  }
  const target = after < 0 ? 0 : lines[after].start + lines[after].len + 1
  const insertAt = target > a ? target - (b - a) : target
  ytext.delete(a, b - a)
  let p = insertAt
  for (const c of chunk) {
    // shift list indents on the terminators
    const parts = c.text.split('\n')
    for (let k = 0; k < parts.length; k++) {
      if (parts[k]) {
        const marks = {}
        for (const m of ['b', 'i', 'u', 's']) if (c.attrs[m]) marks[m] = true
        ytext.insert(p, parts[k], marks)
        p += parts[k].length
      }
      if (k < parts.length - 1) {
        const la = pickLine(c.attrs)
        if (indDelta && isList(la)) {
          const ni = Math.max(0, Math.min(MAX_IND, (la.ind || 0) + indDelta))
          if (ni) la.ind = ni
          else delete la.ind
        }
        ytext.insert(p, '\n', fullLine(la))
        p += 1
      }
    }
  }
}

/** Find the line index whose bid is `bid`, or -1. */
export function findLineById(ytext, bid) {
  const lines = linesOf(ytext)
  return lines.findIndex((L) => L.attrs && L.attrs.bid === bid)
}
