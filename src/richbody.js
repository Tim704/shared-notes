import * as Y from 'yjs'

// ---------------------------------------------------------------------------
// Rich-text binding: a contentEditable element bound to a Y.Text that carries
// inline formatting *attributes* (bold/italic/underline/strikethrough). This is
// a CRDT, so formatting survives concurrent edits the same way the plain text
// does — attributes move with the characters they decorate.
//
// We drive the editor ourselves: every keystroke is intercepted via `beforeinput`,
// turned into a Yjs operation, and the DOM is re-rendered from the canonical
// document state. Composition (IME) and any stray DOM mutation fall back to a
// plain-text diff so the text can never silently desync.
// ---------------------------------------------------------------------------

const MARKS = ['b', 'i', 'u', 's']
const TAG = { b: 'strong', i: 'em', u: 'u', s: 's' }
const LOCAL = 'richbody-local'

export function bindRichText(ytext, el, opts = {}) {
  const onChange = opts.onChange || (() => {})
  const onState = opts.onState || (() => {})

  el.contentEditable = 'true'
  el.spellcheck = true
  el.setAttribute('role', 'textbox')
  el.setAttribute('aria-multiline', 'true')

  let composing = false
  let dirtyDuringCompose = false
  let pendingMarks = null // marks to apply to the next typed character (collapsed toggles)
  let pendingMarksAt = -1 // caret index where pendingMarks was set
  let pendingCaret = null // restore a collapsed caret after a local edit
  let pendingRange = null // restore a selection range after a local edit

  const undo = new Y.UndoManager(ytext, { trackedOrigins: new Set([LOCAL]), captureTimeout: 350 })

  // ---- delta -> DOM ----
  function render() {
    const delta = ytext.toDelta()
    if (delta.length === 0) {
      el.replaceChildren()
      return
    }
    const frag = document.createDocumentFragment()
    for (const op of delta) {
      if (typeof op.insert !== 'string') continue
      let node = document.createTextNode(op.insert)
      const a = op.attributes || {}
      for (const m of MARKS) {
        if (a[m]) {
          const w = document.createElement(TAG[m])
          w.appendChild(node)
          node = w
        }
      }
      frag.appendChild(node)
    }
    el.replaceChildren(frag)
  }

  // ---- DOM <-> character index ----
  function pointToIndex(container, offset) {
    if (!el.contains(container) && container !== el) return null
    const r = document.createRange()
    try {
      r.setStart(el, 0)
      r.setEnd(container, offset)
    } catch {
      return null
    }
    return r.toString().length
  }

  function indexToPoint(index) {
    let cum = 0
    let last = null
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) {
      const len = n.nodeValue.length
      if (index <= cum + len) return { node: n, offset: index - cum }
      cum += len
      last = n
    }
    if (last) return { node: last, offset: last.nodeValue.length }
    return { node: el, offset: 0 }
  }

  function getSel() {
    const s = window.getSelection()
    if (!s || s.rangeCount === 0) return null
    const r = s.getRangeAt(0)
    if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null
    const a = pointToIndex(r.startContainer, r.startOffset)
    const b = pointToIndex(r.endContainer, r.endOffset)
    if (a == null || b == null) return null
    return a <= b ? { start: a, end: b } : { start: b, end: a }
  }

  function setCaret(index) {
    setSelection(index, index)
  }

  function setSelection(start, end) {
    const sel = window.getSelection()
    if (!sel) return
    const p1 = indexToPoint(start)
    const p2 = indexToPoint(end)
    const r = document.createRange()
    try {
      r.setStart(p1.node, p1.offset)
      r.setEnd(p2.node, p2.offset)
      sel.removeAllRanges()
      sel.addRange(r)
    } catch {
      /* nodes went away mid-update; ignore */
    }
  }

  // Shift a caret position through a Yjs delta (for remote edits).
  function shiftThroughDelta(delta, pos) {
    let index = 0
    let res = pos
    for (const op of delta) {
      if (op.retain != null) {
        index += op.retain
      } else if (op.insert != null) {
        const l = typeof op.insert === 'string' ? op.insert.length : 1
        if (index < res) res += l
        index += l
      } else if (op.delete != null) {
        const l = op.delete
        if (index < res) res -= Math.min(l, res - index)
      }
    }
    return res
  }

  // ---- attribute inspection ----
  function charMarks(i) {
    // attributes of the character covering position i (the run [i, i+1)).
    if (i < 0) return {}
    let pos = 0
    for (const op of ytext.toDelta()) {
      if (typeof op.insert !== 'string') continue
      const len = op.insert.length
      if (i < pos + len) return op.attributes ? { ...op.attributes } : {}
      pos += len
    }
    return {}
  }

  function rangeHasMark(start, end, mark) {
    if (end <= start) return false
    let pos = 0
    let covered = 0
    for (const op of ytext.toDelta()) {
      if (typeof op.insert !== 'string') continue
      const len = op.insert.length
      const runStart = pos
      const runEnd = pos + len
      const lo = Math.max(start, runStart)
      const hi = Math.min(end, runEnd)
      if (hi > lo) {
        if (!(op.attributes && op.attributes[mark])) return false
        covered += hi - lo
      }
      pos = runEnd
    }
    return covered >= end - start
  }

  function activeMarks() {
    const sel = getSel()
    if (!sel) return pendingMarks || {}
    if (sel.end > sel.start) {
      const out = {}
      for (const m of MARKS) if (rangeHasMark(sel.start, sel.end, m)) out[m] = true
      return out
    }
    if (pendingMarks && pendingMarksAt === sel.start) return { ...pendingMarks }
    return charMarks(sel.start - 1)
  }

  // ---- mutation primitives (all go through Yjs, origin = LOCAL) ----
  // NOTE: Yjs fires observers synchronously *inside* transact(), so the caret
  // target must be set BEFORE the transaction, not after.
  function replaceRange(start, end, text, marks) {
    pendingMarks = null
    pendingCaret = start + (text ? text.length : 0)
    ytext.doc.transact(() => {
      if (end > start) ytext.delete(start, end - start)
      if (text) ytext.insert(start, text, marks || {})
    }, LOCAL)
  }

  function deleteRange(start, end) {
    if (end <= start) return
    pendingMarks = null
    pendingCaret = start
    ytext.doc.transact(() => {
      ytext.delete(start, end - start)
    }, LOCAL)
  }

  function toggleMark(mark) {
    if (!MARKS.includes(mark)) return
    const sel = getSel()
    if (!sel) return
    if (sel.end > sel.start) {
      const has = rangeHasMark(sel.start, sel.end, mark)
      pendingRange = [sel.start, sel.end]
      ytext.doc.transact(() => {
        ytext.format(sel.start, sel.end - sel.start, { [mark]: has ? null : true })
      }, LOCAL)
    } else {
      const base = pendingMarks && pendingMarksAt === sel.start ? { ...pendingMarks } : charMarks(sel.start - 1)
      if (base[mark]) delete base[mark]
      else base[mark] = true
      pendingMarks = base
      pendingMarksAt = sel.start
      onState(activeMarks())
    }
  }

  // ---- plain-text diff fallback (composition / unexpected DOM drift) ----
  function reconcilePlain(marks) {
    const next = el.textContent
    const prev = ytext.toString()
    if (next === prev) return
    let start = 0
    const min = Math.min(next.length, prev.length)
    while (start < min && next[start] === prev[start]) start++
    let pEnd = prev.length
    let nEnd = next.length
    while (pEnd > start && nEnd > start && prev[pEnd - 1] === next[nEnd - 1]) {
      pEnd--
      nEnd--
    }
    pendingCaret = nEnd
    ytext.doc.transact(() => {
      if (pEnd > start) ytext.delete(start, pEnd - start)
      if (nEnd > start) ytext.insert(start, next.slice(start, nEnd), marks || {})
    }, LOCAL)
  }

  // ---- word / line boundary helpers for smart deletes ----
  function wordBoundaryBack(s, i) {
    let j = i
    while (j > 0 && /\s/.test(s[j - 1])) j--
    while (j > 0 && !/\s/.test(s[j - 1])) j--
    return j
  }
  function wordBoundaryFwd(s, i) {
    let j = i
    while (j < s.length && /\s/.test(s[j])) j++
    while (j < s.length && !/\s/.test(s[j])) j++
    return j
  }
  function lineBoundaryBack(s, i) {
    const nl = s.lastIndexOf('\n', i - 1)
    return nl < 0 ? 0 : nl + 1
  }
  function lineBoundaryFwd(s, i) {
    const nl = s.indexOf('\n', i)
    return nl < 0 ? s.length : nl
  }

  // ---- the controlled editor ----
  function onBeforeInput(e) {
    if (composing) return
    const sel = getSel()
    if (!sel) return
    const { start, end } = sel
    const t = e.inputType
    const text = ytext.toString()

    if (t && t.indexOf('format') === 0) {
      const m = { formatBold: 'b', formatItalic: 'i', formatUnderline: 'u', formatStrikeThrough: 's' }[t]
      if (m) {
        e.preventDefault()
        toggleMark(m)
      }
      return
    }

    if (t && t.indexOf('history') === 0) {
      e.preventDefault()
      if (t === 'historyUndo') undo.undo()
      else undo.redo()
      return
    }

    if (t && t.indexOf('insert') === 0) {
      e.preventDefault()
      let data
      if (t === 'insertParagraph' || t === 'insertLineBreak') data = '\n'
      else if (t === 'insertFromPaste' || t === 'insertFromDrop' || t === 'insertFromYank')
        data = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || ''
      else data = e.data != null ? e.data : ''
      const marks =
        end > start
          ? charMarks(start)
          : pendingMarks && pendingMarksAt === start
            ? { ...pendingMarks }
            : charMarks(start - 1)
      if (data === '' && end <= start) return
      replaceRange(start, end, data, marks)
      return
    }

    if (t && t.indexOf('delete') === 0) {
      e.preventDefault()
      if (end > start) {
        deleteRange(start, end)
        return
      }
      const fwd = t.indexOf('Forward') >= 0 || t.indexOf('forward') >= 0
      let from = start
      let to = start
      if (t.indexOf('Word') >= 0) {
        if (fwd) to = wordBoundaryFwd(text, start)
        else from = wordBoundaryBack(text, start)
      } else if (t.indexOf('Line') >= 0 || t.indexOf('SoftLine') >= 0 || t.indexOf('HardLine') >= 0) {
        if (fwd) to = lineBoundaryFwd(text, start)
        else from = lineBoundaryBack(text, start)
      } else {
        if (fwd) to = Math.min(text.length, start + 1)
        else from = Math.max(0, start - 1)
      }
      if (to > from) deleteRange(from, to)
      return
    }

    // Anything else (rare): stay controlled.
    e.preventDefault()
  }

  // Belt-and-braces: if some path mutated the DOM without us (autocorrect,
  // spellcheck replacement, drag within the field), fold it back in. The Yjs
  // observer below re-renders and restores the caret once we transact.
  function onInput() {
    if (composing) return
    if (el.textContent === ytext.toString()) return
    reconcilePlain({})
  }

  function onCompositionStart() {
    composing = true
  }
  function onCompositionEnd() {
    composing = false
    reconcilePlain(pendingMarks || {})
    dirtyDuringCompose = false
    onState(activeMarks())
  }

  // Keyboard shortcuts (consistent across browsers; we own these so the
  // browser's native bold/italic never double-fires).
  function onKeyDown(e) {
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return
    const k = e.key.toLowerCase()
    let mark = null
    if (k === 'b') mark = 'b'
    else if (k === 'i') mark = 'i'
    else if (k === 'u') mark = 'u'
    else if ((k === 'x' || k === 's') && e.shiftKey) mark = 's'
    if (mark) {
      e.preventDefault()
      toggleMark(mark)
      return
    }
    if (k === 'z') {
      e.preventDefault()
      if (e.shiftKey) undo.redo()
      else undo.undo()
    } else if (k === 'y') {
      e.preventDefault()
      undo.redo()
    }
  }

  // ---- Yjs observer ----
  function observer(event, transaction) {
    const local = transaction.origin === LOCAL
    if (composing && !local) {
      dirtyDuringCompose = true
      return
    }
    if (local) {
      render()
      if (pendingRange) {
        setSelection(pendingRange[0], pendingRange[1])
        pendingRange = null
      } else if (pendingCaret != null) {
        setCaret(pendingCaret)
        pendingCaret = null
      }
      onChange()
      onState(activeMarks())
      return
    }
    // remote (or undo/redo): keep the caret roughly where it was.
    const focused = document.activeElement === el
    const sel = focused ? getSel() : null
    render()
    if (sel) {
      const s = shiftThroughDelta(event.delta, sel.start)
      const en = shiftThroughDelta(event.delta, sel.end)
      setSelection(s, en)
    }
    onChange()
    if (focused) onState(activeMarks())
  }

  // Track selection movement to keep the toolbar honest and expire pending marks.
  function onSelectionChange() {
    if (document.activeElement !== el) return
    const sel = getSel()
    if (sel && !(pendingMarks && pendingMarksAt === sel.start)) {
      pendingMarks = null
      pendingMarksAt = -1
    }
    onState(activeMarks())
  }

  // ---- wire up ----
  render()
  ytext.observe(observer)
  el.addEventListener('beforeinput', onBeforeInput)
  el.addEventListener('input', onInput)
  el.addEventListener('keydown', onKeyDown)
  el.addEventListener('compositionstart', onCompositionStart)
  el.addEventListener('compositionend', onCompositionEnd)
  document.addEventListener('selectionchange', onSelectionChange)

  return {
    toggleMark,
    getActiveMarks: activeMarks,
    focus: () => el.focus(),
    destroy() {
      ytext.unobserve(observer)
      el.removeEventListener('beforeinput', onBeforeInput)
      el.removeEventListener('input', onInput)
      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('compositionstart', onCompositionStart)
      el.removeEventListener('compositionend', onCompositionEnd)
      document.removeEventListener('selectionchange', onSelectionChange)
      undo.destroy()
    },
  }
}
