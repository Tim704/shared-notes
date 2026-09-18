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
const INDENT = '  '

// Things that get turned into links while rendering: bare URLs and [[wiki links]]
// to other notes / tabs. Matching happens per delta run, so a URL that changes
// formatting half way through is simply not linked. textContent is unchanged by
// the wrapping, so caret <-> index mapping is unaffected.
const LINK_RE = /(https?:\/\/[^\s<>"']+|\[\[[^\]\n]+\]\])/g

// Typed sequences that become a nicer glyph (checked against the text just
// before the caret plus the character being typed). Longest first.
const ARROWS = [
  ['←>', '↔'],
  ['<->', '↔'],
  ['->', '→'],
  ['<-', '←'],
  ['=>', '⇒'],
  ['--', '—'],
]

export function bindRichText(ytext, el, opts = {}) {
  const onChange = opts.onChange || (() => {})
  const onState = opts.onState || (() => {})
  const onLocal = opts.onLocal || (() => {}) // fires after a local edit lands
  const onLink = opts.onLink || null // (href) => void, for clicks on links
  const linkCandidates = opts.linkCandidates || null // () => [{label, hint}]
  const useArrows = () => (typeof opts.arrows === 'function' ? opts.arrows() : opts.arrows !== false)
  const useSpell = () => (typeof opts.spellcheck === 'function' ? opts.spellcheck() : !!opts.spellcheck)

  el.contentEditable = 'true'
  el.spellcheck = useSpell()
  el.setAttribute('role', 'textbox')
  el.setAttribute('aria-multiline', 'true')
  let lastArrow = null // { at, orig, glyph } so Backspace right after can undo it

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
      let node = linkify(op.insert)
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

  // Wrap URLs and [[links]] in a run of text. Returns a single node.
  function linkify(text) {
    if (!onLink || !/https?:\/\/|\[\[/.test(text)) return document.createTextNode(text)
    const frag = document.createDocumentFragment()
    let last = 0
    text.replace(LINK_RE, (m, _g, idx) => {
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)))
      const a = document.createElement('a')
      a.className = 'rb-link' + (m[0] === '[' ? ' rb-wiki' : '')
      a.dataset.href = m
      a.textContent = m
      frag.appendChild(a)
      last = idx + m.length
      return m
    })
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
    return frag
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
      // smart arrows: "->" becomes "→" etc. (single typed character only)
      if (useArrows() && data.length === 1 && end === start && t === 'insertText') {
        const before = text.slice(Math.max(0, start - 3), start)
        for (const [seq, glyph] of ARROWS) {
          const prefix = seq.slice(0, -1)
          if (seq[seq.length - 1] === data && before.endsWith(prefix)) {
            const from = start - prefix.length
            // keep what the user actually typed so Backspace can restore it
            const orig = (lastArrow && lastArrow.at === start ? lastArrow.orig : prefix) + data
            replaceRange(from, end, glyph, marks)
            lastArrow = { at: from + glyph.length, orig, glyph }
            return
          }
        }
      }
      lastArrow = null
      replaceRange(start, end, data, marks)
      return
    }

    if (t && t.indexOf('delete') === 0) {
      e.preventDefault()
      if (end > start) {
        lastArrow = null
        deleteRange(start, end)
        return
      }
      // Backspace straight after a smart arrow puts the typed characters back.
      if (t === 'deleteContentBackward' && lastArrow && lastArrow.at === start && text[start - 1] === lastArrow.glyph) {
        const la = lastArrow
        lastArrow = null
        replaceRange(start - 1, start, la.orig, charMarks(start - 1))
        return
      }
      lastArrow = null
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
    if (picker && pickerKey(e)) return
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      indent(e.shiftKey ? -1 : 1)
      return
    }
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

  // ---- Tab / Shift+Tab: indent or outdent the caret line (or every selected line) ----
  function indent(dir) {
    const sel = getSel()
    if (!sel) return
    const text = ytext.toString()
    const single = sel.end === sel.start || text.slice(sel.start, sel.end).indexOf('\n') < 0
    if (dir > 0 && single) {
      replaceRange(sel.start, sel.end, INDENT, charMarks(sel.start - 1))
      return
    }
    // line-wise: walk every line start in the selection, from the last one back
    const first = lineBoundaryBack(text, sel.start)
    const starts = [first]
    for (let i = first; i < sel.end; i++) if (text[i] === '\n' && i + 1 < sel.end) starts.push(i + 1)
    const plan = []
    let newStart = sel.start
    let newEnd = sel.end
    for (let k = starts.length - 1; k >= 0; k--) {
      const ls = starts[k]
      if (dir > 0) {
        plan.push({ ls, insert: true })
        if (ls <= newStart) newStart += INDENT.length
        newEnd += INDENT.length
      } else {
        let n = 0
        while (n < INDENT.length && text[ls + n] === ' ') n++
        if (n === 0 && text[ls] === '\t') n = 1
        if (n > 0) {
          plan.push({ ls, n })
          if (ls < newStart) newStart = Math.max(ls, newStart - n)
          newEnd = Math.max(ls, newEnd - n)
        }
      }
    }
    if (!plan.length) return
    // observers fire when the transaction closes, so set the caret target first
    pendingMarks = null
    if (sel.end === sel.start) {
      pendingRange = null
      pendingCaret = newStart
    } else pendingRange = [newStart, newEnd]
    ytext.doc.transact(() => {
      for (const step of plan) {
        if (step.insert) ytext.insert(step.ls, INDENT, charMarks(step.ls))
        else ytext.delete(step.ls, step.n)
      }
    }, LOCAL)
  }

  // ---- [[link]] picker ----------------------------------------------------
  let picker = null // { el, items, index, from } while open

  function closePicker() {
    if (!picker) return
    picker.el.remove()
    picker = null
  }

  // Look for "[[partial" just before the caret and show matching titles.
  function updatePicker() {
    if (!linkCandidates || document.activeElement !== el) return closePicker()
    const sel = getSel()
    if (!sel || sel.end !== sel.start) return closePicker()
    const text = ytext.toString()
    const before = text.slice(Math.max(0, sel.start - 80), sel.start)
    const m = /\[\[([^\]\n]*)$/.exec(before)
    if (!m) return closePicker()
    const q = m[1].toLowerCase()
    const items = linkCandidates()
      .filter((c) => c.label && c.label.toLowerCase().includes(q))
      .slice(0, 8)
    if (!items.length) return closePicker()
    clearTimeout(blurTimer)
    if (!picker) {
      const box = document.createElement('div')
      box.className = 'rb-picker'
      box.addEventListener('mousedown', (e) => e.preventDefault()) // keep the caret
      document.body.appendChild(box)
      picker = { el: box, items: [], index: 0, from: 0 }
    }
    picker.items = items
    picker.index = Math.min(picker.index, items.length - 1)
    picker.from = sel.start - m[0].length
    picker.el.replaceChildren()
    items.forEach((c, i) => {
      const row = document.createElement('div')
      row.className = 'rb-pick' + (i === picker.index ? ' on' : '')
      const l = document.createElement('span')
      l.textContent = c.label
      row.appendChild(l)
      if (c.hint) {
        const hnt = document.createElement('span')
        hnt.className = 'rb-pick-hint'
        hnt.textContent = c.hint
        row.appendChild(hnt)
      }
      row.addEventListener('click', () => choosePick(i))
      picker.el.appendChild(row)
    })
    // anchor under the caret
    const s = window.getSelection()
    let r = null
    if (s && s.rangeCount) {
      const rect = s.getRangeAt(0).getClientRects()[0] || el.getBoundingClientRect()
      r = rect
    } else r = el.getBoundingClientRect()
    const top = Math.min(r.bottom + 4, window.innerHeight - 200)
    const left = Math.min(r.left, window.innerWidth - 260)
    picker.el.style.top = top + window.scrollY + 'px'
    picker.el.style.left = Math.max(4, left) + window.scrollX + 'px'
  }

  function choosePick(i) {
    if (!picker) return
    const c = picker.items[i]
    const sel = getSel()
    if (!c || !sel) return closePicker()
    const from = picker.from
    closePicker()
    replaceRange(from, sel.end, '[[' + c.label + ']]', charMarks(from - 1))
  }

  function pickerKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = picker.items.length
      picker.index = (picker.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
      Array.from(picker.el.children).forEach((row, i) => row.classList.toggle('on', i === picker.index))
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      choosePick(picker.index)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      closePicker()
      return true
    }
    return false
  }

  // ---- links: a click on an unfocused note follows the link; while editing,
  // Ctrl/Cmd+click does. Touch users get the first behaviour naturally. ----
  let hadFocusAtPointerDown = false
  function onPointerDown() {
    hadFocusAtPointerDown = document.activeElement === el
  }
  function onClick(e) {
    if (!onLink) return
    const a = e.target && e.target.closest ? e.target.closest('a.rb-link') : null
    if (!a || !el.contains(a)) return
    if (hadFocusAtPointerDown && !(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    onLink(a.dataset.href)
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
      onLocal()
      onState(activeMarks())
      updatePicker()
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
    updatePicker()
  }

  // ---- wire up ----
  render()
  ytext.observe(observer)
  el.addEventListener('beforeinput', onBeforeInput)
  el.addEventListener('input', onInput)
  el.addEventListener('keydown', onKeyDown)
  el.addEventListener('compositionstart', onCompositionStart)
  el.addEventListener('compositionend', onCompositionEnd)
  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('click', onClick)
  let blurTimer = null
  el.addEventListener('blur', () => {
    clearTimeout(blurTimer)
    blurTimer = setTimeout(closePicker, 120)
  })
  el.addEventListener('focus', () => clearTimeout(blurTimer))
  document.addEventListener('selectionchange', onSelectionChange)

  return {
    toggleMark,
    indent,
    getActiveMarks: activeMarks,
    focus: () => el.focus(),
    setSpellcheck: (on) => {
      el.spellcheck = !!on
    },
    destroy() {
      closePicker()
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('click', onClick)
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
