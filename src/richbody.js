import * as Y from 'yjs'
import {
  MARKS,
  deltaToLines,
  computeMarkers,
  subtreeEnds,
  embedOf,
  pickLine,
  pickMarks,
  fullLine,
  isList,
  numericForLevel,
  NUMERIC,
  MAX_IND,
  parseLinePrefix,
  genLineId,
} from '../shared/lines.js'

// ---------------------------------------------------------------------------
// Rich-text binding: a contentEditable element bound to a Y.Text.
//
// Inline formatting (bold/italic/underline/strikethrough) lives on characters
// as attributes; line structure (lists, checkboxes, headings, indent,
// alignment) lives on the '\n' that ends each line. See shared/lines.js for the
// model. Both are plain CRDT data, so they merge under concurrent edits.
//
// We drive the editor ourselves: every keystroke is intercepted via
// `beforeinput`, turned into a Yjs operation, and the DOM is re-rendered from
// the document (keyed per line, so untouched lines - and a playing video - keep
// their DOM). Composition (IME) and any stray DOM mutation fall back to a
// plain-text diff so the text can never silently desync.
//
// DOM shape, one element per line:
//   <div class="rb-line rb-li" data-i="3">
//     <span class="rb-fold">  (lines that own others)   contenteditable=false
//     <span class="rb-mark">• / 1. / a.  or  <span class="rb-check">
//     <div class="rb-embed">  (a line that is only a picture/video URL)
//     <span class="rb-text">…the characters…</span>
//   </div>
// Character indexes are computed per line, inside .rb-text only, so markers
// and previews never count as text.
// ---------------------------------------------------------------------------

const TAG = { b: 'strong', i: 'em', u: 'u', s: 's' }
const INDENT = '  '

// Things that get turned into links while rendering: bare URLs and [[wiki links]]
// to other notes / tabs. Matching happens per run of text, so a URL that changes
// formatting half way through is simply not linked.
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

// Typed at the start of a paragraph and followed by a space, these turn the
// line into a list item / checkbox / heading (Backspace straight after undoes it).
function shortcutFor(prefix) {
  if (prefix === '-' || prefix === '*' || prefix === '+' || prefix === '•') return { lt: 'li', mk: 'disc' }
  if (prefix === '→' || prefix === '->') return { lt: 'li', mk: 'arrow' }
  if (prefix === '—' || prefix === '–') return { lt: 'li', mk: 'dash' }
  if (prefix === '[]' || prefix === '[ ]') return { lt: 'todo' }
  if (prefix === '[x]' || prefix === '[X]') return { lt: 'todo', done: true }
  if (prefix === '#') return { lt: 'h' }
  if (/^\d{1,3}[.)]$/.test(prefix)) return { lt: 'li', mk: 'decimal' }
  if (/^i[.)]$/.test(prefix)) return { lt: 'li', mk: 'roman' }
  if (/^[a-z][.)]$/.test(prefix)) return { lt: 'li', mk: 'alpha' }
  return null
}

export function bindRichText(ytext, el, opts = {}) {
  const onChange = opts.onChange || (() => {})
  const onState = opts.onState || (() => {})
  const onLocal = opts.onLocal || (() => {}) // fires after a local edit lands
  const onLink = opts.onLink || null // (href) => void, for clicks on links
  const linkCandidates = opts.linkCandidates || null // () => [{label, hint}]
  const folds = opts.folds || null // per-device folded line ids: { has, set, subscribe }
  const reveal = opts.reveal || (() => false) // true while searching: show folded lines
  const onEmbedClick = opts.onEmbedClick || null // (embed) => void (picture lightbox)
  const onFiles = opts.onFiles || null // (File[]) => void (pasted / dropped pictures)
  const useArrows = () => (typeof opts.arrows === 'function' ? opts.arrows() : opts.arrows !== false)
  const useSpell = () => (typeof opts.spellcheck === 'function' ? opts.spellcheck() : !!opts.spellcheck)

  // Each binding has its own origins, so two editors on the same text (a card
  // and its full-screen view) each undo only their own edits and see the other's
  // edits as remote.
  const LOCAL = { binding: 'richbody' }
  const META = { binding: 'richbody-meta' } // bookkeeping writes that should not be undoable

  let editable = opts.editable !== false
  el.contentEditable = editable ? 'true' : 'false'
  el.spellcheck = useSpell()
  el.setAttribute('role', 'textbox')
  el.setAttribute('aria-multiline', 'true')
  el.classList.add('rb')
  let lastArrow = null // { at, orig, glyph } so Backspace right after can undo it
  let lastShortcut = null // { at, orig } so Backspace right after can undo a list shortcut

  let composing = false
  let pendingMarks = null // marks to apply to the next typed character (collapsed toggles)
  let pendingMarksAt = -1 // caret index where pendingMarks was set
  let pendingCaret = null // restore a collapsed caret after a local edit
  let pendingRange = null // restore a selection range after a local edit
  let lastSel = null // last known selection (for inserting pictures after a blur)

  const undo = new Y.UndoManager(ytext, { trackedOrigins: new Set([LOCAL]), captureTimeout: 350 })

  // rendered state
  let lines = [] // [{ start, len, text, attrs, term, el, textEl, hidden, kids, end }]
  let total = 0 // ytext length at the last render

  // ---- document helpers ----------------------------------------------------
  function docLines() {
    return deltaToLines(ytext.toDelta())
  }

  function charAttrs(i) {
    if (i < 0) return {}
    let pos = 0
    for (const op of ytext.toDelta()) {
      if (typeof op.insert !== 'string') {
        pos += 1
        continue
      }
      const len = op.insert.length
      if (i < pos + len) return op.attributes ? { ...op.attributes } : {}
      pos += len
    }
    return {}
  }
  // inline marks of the character covering position i (the run [i, i+1))
  const charMarks = (i) => pickMarks(charAttrs(i))

  function lineIndexAt(index) {
    let lo = 0
    let hi = lines.length - 1
    let ans = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (lines[mid].start <= index) {
        ans = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return ans
  }

  // ---- render (doc → DOM), keyed per line ---------------------------------
  function render() {
    const ls = deltaToLines(ytext.toDelta())
    total = ytext.length
    const markers = computeMarkers(ls)
    const ends = subtreeEnds(ls)
    const showAll = !!reveal()
    const hidden = new Array(ls.length).fill(false)
    let anyKids = false
    for (let i = 0; i < ls.length; i++) {
      if (ends[i] > i + 1) {
        anyKids = true
        const bid = ls[i].attrs.bid
        if (!showAll && folds && bid && folds.has(bid) && !hidden[i]) for (let j = i + 1; j < ends[i]; j++) hidden[j] = true
      }
    }
    const emptyDoc = ls.length === 1 && !ls[0].len && !ls[0].attrs.lt

    // reuse existing line elements whose rendering would be identical
    const pool = new Map()
    for (const L of lines) {
      if (!L.el || L.el.parentNode !== el) continue
      if (!pool.has(L.key)) pool.set(L.key, [])
      pool.get(L.key).push(L.el)
    }
    const rec = []
    const used = new Set()
    for (let i = 0; i < ls.length; i++) {
      const L = ls[i]
      const kids = ends[i] > i + 1
      const folded = kids && !!(folds && L.attrs.bid && folds.has(L.attrs.bid)) && !showAll
      const emb = opts.embeds === false ? null : embedOf(L.text)
      const key = JSON.stringify([
        L.runs,
        L.attrs,
        markers[i],
        hidden[i],
        kids,
        folded,
        folded ? ends[i] - i - 1 : 0,
        emptyDoc ? el.dataset.ph || '' : null,
        !!emb,
      ])
      let lineEl = null
      const cands = pool.get(key)
      while (cands && cands.length && !lineEl) {
        const c = cands.shift()
        if (!used.has(c)) lineEl = c
      }
      if (!lineEl) lineEl = buildLine(L, markers[i], kids, folded, ends[i] - i - 1, hidden[i], emb, emptyDoc)
      used.add(lineEl)
      lineEl.dataset.i = String(i)
      rec.push({ ...L, el: lineEl, textEl: lineEl.querySelector('.rb-text'), hidden: hidden[i], kids, end: ends[i], key })
    }
    // drop what is no longer wanted first, then insert/move into order
    for (const child of Array.from(el.childNodes)) if (!used.has(child)) child.remove()
    for (let i = 0; i < rec.length; i++) {
      const want = rec[i].el
      const at = el.childNodes[i] || null
      if (at !== want) el.insertBefore(want, at)
    }
    while (el.childNodes.length > rec.length) el.lastChild.remove()
    lines = rec
    el.classList.toggle('rb-has-folds', anyKids)
    el.classList.toggle('rb-empty', emptyDoc)
  }

  function buildLine(L, marker, kids, folded, nKids, hidden, emb, emptyDoc) {
    const a = L.attrs
    const line = document.createElement('div')
    line.className =
      'rb-line rb-' +
      (a.lt === 'li' ? 'li' : a.lt === 'todo' ? 'todo' : a.lt === 'h' ? 'h' : 'p') +
      (a.done ? ' done' : '') +
      (a.al ? ' al-' + a.al : '') +
      (hidden ? ' rb-hidden' : '') +
      (folded ? ' folded' : '') +
      (emb ? ' has-embed embed-' + emb.kind : '')
    if (isList(a) && a.ind) line.style.setProperty('--ind', a.ind)
    if (kids) {
      const f = document.createElement('span')
      f.className = 'rb-fold'
      f.contentEditable = 'false'
      f.textContent = '▸'
      f.title = folded ? 'Show what is folded here (Ctrl+.)' : 'Fold (Ctrl+.)'
      line.appendChild(f)
    }
    if (a.lt === 'li') {
      const m = document.createElement('span')
      m.className = 'rb-mark mk-' + (a.mk || 'disc')
      m.contentEditable = 'false'
      m.textContent = marker
      line.appendChild(m)
    } else if (a.lt === 'todo') {
      const c = document.createElement('span')
      c.className = 'rb-check'
      c.contentEditable = 'false'
      c.setAttribute('role', 'checkbox')
      c.setAttribute('aria-checked', a.done ? 'true' : 'false')
      c.title = a.done ? 'Done' : 'Tick'
      line.appendChild(c)
    }
    const body = document.createElement('span')
    body.className = 'rb-text'
    if (emptyDoc && el.dataset.ph) body.setAttribute('data-ph', el.dataset.ph)
    if (emb) line.appendChild(buildEmbed(emb, a))
    for (const r of L.runs) {
      let node = linkify(r.text)
      for (const m of MARKS) {
        if (r.marks[m]) {
          const w = document.createElement(TAG[m])
          w.appendChild(node)
          node = w
        }
      }
      body.appendChild(node)
    }
    if (!L.len) body.appendChild(document.createElement('br'))
    line.appendChild(body)
    if (folded) {
      const more = document.createElement('span')
      more.className = 'rb-more'
      more.contentEditable = 'false'
      more.textContent = '… ' + nKids
      more.title = nKids + ' folded line' + (nKids === 1 ? '' : 's')
      line.appendChild(more)
    }
    return line
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

  // ---- picture / video previews --------------------------------------------
  function buildEmbed(emb, a) {
    const box = document.createElement('div')
    box.className = 'rb-embed rb-embed-' + emb.kind
    box.contentEditable = 'false'
    if (a.ew) box.style.width = Math.max(10, Math.min(100, a.ew)) + '%'
    if (emb.kind === 'image') {
      const img = document.createElement('img')
      img.src = emb.src
      img.alt = ''
      img.loading = 'lazy'
      img.draggable = false
      img.addEventListener('click', (e) => {
        e.preventDefault()
        if (onEmbedClick) onEmbedClick(emb)
      })
      box.appendChild(img)
    } else if (emb.kind === 'youtube') {
      const thumb = document.createElement('button')
      thumb.className = 'rb-play'
      thumb.type = 'button'
      thumb.title = 'Play (loads YouTube)'
      thumb.style.backgroundImage = `url("https://i.ytimg.com/vi/${emb.id}/hqdefault.jpg")`
      thumb.innerHTML = '<span class="rb-play-btn">▶</span>'
      thumb.addEventListener('click', (e) => {
        e.preventDefault()
        const f = document.createElement('iframe')
        f.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(emb.id)}?autoplay=1&rel=0`
        f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'
        f.allowFullscreen = true
        f.referrerPolicy = 'strict-origin-when-cross-origin'
        f.className = 'rb-frame rb-frame-yt'
        thumb.replaceWith(f)
      })
      box.appendChild(thumb)
    } else if (emb.kind === 'instagram') {
      const ph = document.createElement('button')
      ph.className = 'rb-insta'
      ph.type = 'button'
      ph.innerHTML = '<span class="rb-insta-logo">◎</span><span>Instagram post · tap to load</span>'
      ph.addEventListener('click', (e) => {
        e.preventDefault()
        const f = document.createElement('iframe')
        f.src = `https://www.instagram.com/p/${encodeURIComponent(emb.id)}/embed`
        f.className = 'rb-frame rb-frame-ig'
        f.referrerPolicy = 'strict-origin-when-cross-origin'
        f.setAttribute('scrolling', 'no')
        ph.replaceWith(f)
      })
      box.appendChild(ph)
    }
    // width handle (pictures and videos): drag to resize inside the note
    const grip = document.createElement('span')
    grip.className = 'rb-embed-grip'
    grip.title = 'Drag to resize'
    grip.addEventListener('pointerdown', (e) => startEmbedResize(e, box))
    box.appendChild(grip)
    return box
  }

  function startEmbedResize(e, box) {
    if (!editable) return
    e.preventDefault()
    e.stopPropagation()
    const lineEl = box.closest('.rb-line')
    const i = lineEl ? Number(lineEl.dataset.i) : -1
    if (!(i >= 0 && lines[i])) return
    const full = Math.max(1, el.clientWidth)
    const startW = box.getBoundingClientRect().width
    const sx = e.clientX
    let pct = null
    const move = (ev) => {
      pct = Math.round(Math.max(10, Math.min(100, ((startW + ev.clientX - sx) / full) * 100)))
      box.style.width = pct + '%'
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (pct == null) return
      const L = lines[i]
      ytext.doc.transact(() => {
        ensureTerm()
        ytext.format(L.start + L.len, 1, { ew: pct >= 100 ? null : pct })
      }, LOCAL)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---- DOM <-> character index ----------------------------------------------
  function pointToIndex(container, offset) {
    if (container !== el && !el.contains(container)) return null
    if (!lines.length) return 0
    if (container === el) {
      if (offset >= lines.length) {
        const L = lines[lines.length - 1]
        return L.start + L.len
      }
      return lines[offset].start
    }
    let node = container.nodeType === 1 ? container : container.parentNode
    const lineEl = node && node.closest ? node.closest('.rb-line') : null
    const L = lineEl ? lines[Number(lineEl.dataset.i)] : null
    if (!L || L.el !== lineEl) return null
    const t = L.textEl
    if (t && (container === t || t.contains(container))) {
      const r = document.createRange()
      try {
        r.setStart(t, 0)
        r.setEnd(container, offset)
      } catch {
        return null
      }
      return L.start + Math.min(L.len, r.toString().length)
    }
    // somewhere else in the line (marker, checkbox, preview, fold): before or after the text?
    let probe = container
    if (container === lineEl) probe = lineEl.childNodes[Math.min(offset, lineEl.childNodes.length - 1)] || t
    if (!t || !probe) return L.start
    if (probe === t) return offset > Array.prototype.indexOf.call(lineEl.childNodes, t) ? L.start + L.len : L.start
    const pos = t.compareDocumentPosition(probe)
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? L.start + L.len : L.start
  }

  function indexToPoint(index) {
    if (!lines.length) return { node: el, offset: 0 }
    let i = lineIndexAt(index)
    // a caret can't live in a folded line: walk back to a visible one
    while (i > 0 && lines[i].hidden) i--
    const L = lines[i]
    let off = Math.max(0, Math.min(L.len, index - L.start))
    if (lines[lineIndexAt(index)].hidden) off = L.len
    const t = L.textEl
    if (!t) return { node: L.el, offset: 0 }
    const w = document.createTreeWalker(t, NodeFilter.SHOW_TEXT)
    let n
    let last = null
    while ((n = w.nextNode())) {
      const len = n.nodeValue.length
      if (off <= len) return { node: n, offset: off }
      off -= len
      last = n
    }
    if (last) return { node: last, offset: last.nodeValue.length }
    return { node: t, offset: 0 }
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
  function rangeHasMark(start, end, mark) {
    if (end <= start) return false
    let pos = 0
    let covered = 0
    let need = 0
    const s = ytext.toString()
    for (const op of ytext.toDelta()) {
      if (typeof op.insert !== 'string') {
        pos += 1
        continue
      }
      const len = op.insert.length
      const lo = Math.max(start, pos)
      const hi = Math.min(end, pos + len)
      if (hi > lo) {
        // newlines don't count: a selection across lines is "bold" if its text is
        for (let k = lo; k < hi; k++) {
          if (s[k] === '\n') continue
          need++
          if (op.attributes && op.attributes[mark]) covered++
          else return false
        }
      }
      pos += len
    }
    return need > 0 && covered >= need
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
    const L = lines[lineIndexAt(sel.start)]
    if (L && sel.start === L.start) return charMarks(sel.start) // start of a line: look forward
    return charMarks(sel.start - 1)
  }

  function lineState() {
    const sel = getSel() || lastSel
    if (!sel || !lines.length) return {}
    const L = lines[lineIndexAt(sel.start)]
    return L ? { ...L.attrs, kids: L.kids } : {}
  }

  function emitState() {
    onState(activeMarks(), lineState())
  }

  // ---- mutation primitives (all go through Yjs, origin = LOCAL) ----
  // NOTE: Yjs fires observers synchronously *inside* transact(), so the caret
  // target must be set BEFORE the transaction, not after.
  function tx(fn) {
    ytext.doc.transact(fn, LOCAL)
  }

  // The last line must end with '\n' before anything gives it line attributes
  // or splits it (bodies from before the line model may not).
  function ensureTerm() {
    const s = ytext.toString()
    if (!s.length || s[s.length - 1] !== '\n') ytext.insert(s.length, '\n', {})
  }

  // attributes a new line gets when it is split off / continued from this one
  function continuation(attrs) {
    const a = pickLine(attrs)
    if (a.lt === 'h') return a.al ? { al: a.al } : {}
    const out = {}
    if (a.lt) out.lt = a.lt
    if (a.lt === 'li') out.mk = a.mk || 'disc'
    if (isList(a) && a.ind) out.ind = a.ind
    if (a.al) out.al = a.al
    if (isList(a)) out.bid = genLineId()
    return out
  }

  // insert text that may contain newlines; each '\n' continues the line it splits
  function insertTextAt(pos, str, marks) {
    const m = pickMarks(marks)
    const parts = str.split('\n')
    let p = pos
    for (let k = 0; k < parts.length; k++) {
      if (parts[k]) {
        ytext.insert(p, parts[k], m)
        p += parts[k].length
      }
      if (k < parts.length - 1) {
        const s = ytext.toString()
        const term = s.indexOf('\n', p)
        const attrs = term >= 0 ? charAttrs(term) : {}
        ytext.insert(p, '\n', fullLine({ ...continuation(attrs), done: null }))
        p += 1
      }
    }
    return p
  }

  // delete [start, end); if that swallows line breaks the merged line keeps the
  // attributes of the line the range started in (as every editor does)
  function deleteSpan(start, end) {
    if (end <= start) return
    const s = ytext.toString()
    // whole lines (from a line start to just after a line break): the line
    // after them keeps its own attributes
    if (start === lineBoundaryBack(s, start) && s[end - 1] === '\n') {
      ytext.delete(start, end - start)
      return
    }
    const firstTerm = s.indexOf('\n', start)
    if (firstTerm >= 0 && firstTerm < end) {
      const keep = fullLine(pickLine(charAttrs(firstTerm)))
      const lastTerm = s.indexOf('\n', end)
      ytext.delete(start, end - start)
      if (lastTerm >= 0) ytext.format(lastTerm - (end - start), 1, keep)
    } else ytext.delete(start, end - start)
  }

  function replaceRange(start, end, text, marks) {
    pendingMarks = null
    pendingCaret = start + (text ? text.length : 0)
    tx(() => {
      ensureTerm()
      deleteSpan(start, end)
      if (text) insertTextAt(start, text, marks)
    })
  }

  function deleteRange(start, end) {
    if (end <= start) return
    pendingMarks = null
    pendingCaret = start
    tx(() => {
      ensureTerm()
      deleteSpan(start, end)
    })
  }

  // set line attributes on lines [from, to] (patch: null clears a key)
  function patchLines(from, to, patchFn) {
    tx(() => {
      ensureTerm()
      const ls = docLines()
      for (let i = from; i <= to && i < ls.length; i++) {
        const L = ls[i]
        const cur = pickLine(L.attrs)
        const patch = patchFn(cur, L, i)
        if (!patch) continue
        const next = { ...cur, ...patch }
        for (const k of Object.keys(next)) if (next[k] == null || next[k] === false) delete next[k]
        ytext.format(L.start + L.len, 1, fullLine(next))
      }
    })
  }

  function selectedLineRange() {
    const sel = getSel() || lastSel
    if (!sel || !lines.length) return null
    let a = lineIndexAt(sel.start)
    let b = lineIndexAt(sel.end)
    // a selection that ends right at the start of a line doesn't include it
    if (b > a && sel.end === lines[b].start) b--
    return { a, b, sel }
  }

  function keepSelection(sel) {
    if (!sel) return
    if (sel.end > sel.start) pendingRange = [sel.start, sel.end]
    else pendingCaret = sel.start
  }

  // ---- block commands (toolbar / shortcuts) ---------------------------------
  function toggleList(mk) {
    const r = selectedLineRange()
    if (!r) return
    const want = mk || 'disc'
    const all = lines.slice(r.a, r.b + 1).every((L) => L.attrs.lt === 'li' && (L.attrs.mk || 'disc') === want)
    keepSelection(r.sel)
    patchLines(r.a, r.b, (cur) =>
      all
        ? { lt: null, mk: null, ind: null }
        : { lt: 'li', mk: want, done: null, bid: cur.bid || genLineId() }
    )
  }

  function toggleTodo() {
    const r = selectedLineRange()
    if (!r) return
    const all = lines.slice(r.a, r.b + 1).every((L) => L.attrs.lt === 'todo')
    keepSelection(r.sel)
    patchLines(r.a, r.b, (cur) =>
      all ? { lt: null, done: null, ind: null } : { lt: 'todo', mk: null, done: cur.lt === 'todo' ? cur.done : null, bid: cur.bid || genLineId() }
    )
  }

  function toggleHeading() {
    const r = selectedLineRange()
    if (!r) return
    const all = lines.slice(r.a, r.b + 1).every((L) => L.attrs.lt === 'h')
    keepSelection(r.sel)
    patchLines(r.a, r.b, () => (all ? { lt: null } : { lt: 'h', mk: null, ind: null, done: null }))
  }

  function setAlign(al) {
    const r = selectedLineRange()
    if (!r) return
    keepSelection(r.sel)
    patchLines(r.a, r.b, () => ({ al: al === 'left' ? null : al }))
  }

  function toggleDone(i) {
    const L = lines[i]
    if (!L || L.attrs.lt !== 'todo') return
    const sel = document.activeElement === el ? getSel() : null
    if (sel) keepSelection(sel)
    patchLines(i, i, (cur) => ({ done: cur.done ? null : true }))
  }

  // Tab / Shift+Tab: list lines change level; plain text gets two spaces
  function indent(dir) {
    const r = selectedLineRange()
    if (!r) return
    const range = lines.slice(r.a, r.b + 1)
    if (range.some((L) => isList(L.attrs))) {
      keepSelection(r.sel)
      patchLines(r.a, r.b, (cur) => {
        if (!isList(cur)) return null
        const old = cur.ind || 0
        const ni = Math.max(0, Math.min(MAX_IND, old + dir))
        if (ni === old) return null
        const patch = { ind: ni || null }
        if (cur.lt === 'li' && NUMERIC.has(cur.mk) && cur.mk === numericForLevel(old)) patch.mk = numericForLevel(ni)
        return patch
      })
      return
    }
    indentSpaces(dir, r.sel)
  }

  function indentSpaces(dir, sel) {
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
    pendingMarks = null
    if (sel.end === sel.start) {
      pendingRange = null
      pendingCaret = newStart
    } else pendingRange = [newStart, newEnd]
    tx(() => {
      for (const step of plan) {
        if (step.insert) ytext.insert(step.ls, INDENT, charMarks(step.ls))
        else ytext.delete(step.ls, step.n)
      }
    })
  }

  // ---- folding (per device) -------------------------------------------------
  function toggleFold(i, force) {
    const L = lines[i]
    if (!L || !L.kids || !folds) return
    let bid = L.attrs.bid
    if (!bid) {
      bid = genLineId()
      ytext.doc.transact(() => {
        ensureTerm()
        const ls = docLines()
        const D = ls[i]
        if (D) ytext.format(D.start + D.len, 1, { bid })
      }, META)
    }
    const on = force != null ? force : !folds.has(bid)
    folds.set(bid, on)
    render()
    if (on && document.activeElement === el) {
      // keep the caret out of what just disappeared
      const sel = getSel()
      if (sel && sel.start > L.start + L.len && sel.start < (lines[L.end] ? lines[L.end].start : total)) setCaret(L.start + L.len)
    }
  }

  // unfold whatever hides line i
  function revealLine(i) {
    let changed = false
    for (let k = i - 1; k >= 0; k--) {
      const L = lines[k]
      if (L.kids && L.end > i && L.attrs.bid && folds && folds.has(L.attrs.bid)) {
        folds.set(L.attrs.bid, false)
        changed = true
      }
    }
    if (changed) render()
    return changed
  }

  function toggleFoldAtCaret() {
    const sel = getSel()
    if (!sel) return
    let i = lineIndexAt(sel.start)
    if (!lines[i].kids) i = findOwner(i) // on a child line? fold its owner instead
    if (i >= 0) toggleFold(i)
  }

  function findOwner(i) {
    for (let k = i - 1; k >= 0; k--) if (lines[k].kids && lines[k].end > i) return k
    return -1
  }

  // ---- plain-text diff fallback (composition / unexpected DOM drift) ----
  function domText() {
    const parts = []
    for (const lineEl of el.querySelectorAll(':scope > .rb-line')) {
      const t = lineEl.querySelector('.rb-text')
      parts.push(t ? t.textContent : '')
    }
    const s = ytext.toString()
    const term = s.length > 0 && s[s.length - 1] === '\n'
    return parts.join('\n') + (term ? '\n' : '')
  }

  function reconcilePlain(marks) {
    const next = domText()
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
    tx(() => {
      if (pEnd > start) deleteSpan(start, pEnd)
      if (nEnd > start) insertTextAt(start, next.slice(start, nEnd), marks || {})
    })
  }

  // ---- word / line boundary helpers for smart deletes ----
  function wordBoundaryBack(s, i) {
    let j = i
    if (j > 0 && s[j - 1] === '\n') return j - 1
    while (j > 0 && /[^\S\n]/.test(s[j - 1])) j--
    while (j > 0 && !/\s/.test(s[j - 1])) j--
    return j
  }
  function wordBoundaryFwd(s, i) {
    let j = i
    if (s[j] === '\n') return j + 1
    while (j < s.length && /[^\S\n]/.test(s[j])) j++
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

  // ---- Enter ------------------------------------------------------------------
  function enter(sel) {
    lastArrow = null
    lastShortcut = null
    let { start, end } = sel
    const i0 = lineIndexAt(start)
    const L = lines[i0]
    if (!L) return
    // an empty list line: Enter leaves the list (outdent first)
    if (end === start && isList(L.attrs) && L.len === 0) {
      pendingCaret = start
      patchLines(i0, i0, (cur) => {
        if (!cur.ind) return { lt: null, mk: null, done: null, ind: null }
        const patch = { ind: cur.ind - 1 || null }
        if (cur.lt === 'li' && NUMERIC.has(cur.mk) && cur.mk === numericForLevel(cur.ind)) patch.mk = numericForLevel(cur.ind - 1)
        return patch
      })
      return
    }
    const marks = pendingMarks && pendingMarksAt === start ? { ...pendingMarks } : charMarks(start - 1)
    // at the end of a line: open a new line after it (after its folded children
    // too), so the line - and its id, tick and fold - stays put
    if (end === start && start === L.start + L.len) {
      const folded = L.end > i0 + 1 && L.attrs.bid && folds && folds.has(L.attrs.bid) && !reveal()
      const T = lines[folded ? L.end - 1 : i0]
      const pos = T.start + T.len + 1 // (a missing final '\n' is added first, which doesn't move this)
      const cont = continuation(L.attrs)
      pendingMarks = Object.keys(marks).length ? marks : null
      pendingMarksAt = pendingMarks ? pos : -1
      pendingCaret = pos
      tx(() => {
        ensureTerm()
        ytext.insert(pos, '\n', fullLine(cont))
      })
      return
    }
    pendingMarks = null
    pendingCaret = start + 1
    tx(() => {
      ensureTerm()
      deleteSpan(start, end)
      const s = ytext.toString()
      const term = s.indexOf('\n', start)
      const attrs = term >= 0 ? charAttrs(term) : {}
      ytext.insert(start, '\n', fullLine(continuation(attrs)))
    })
  }

  // ---- the controlled editor ----
  function targetRange(e) {
    try {
      const rs = e.getTargetRanges ? e.getTargetRanges() : []
      if (rs && rs.length) {
        const a = pointToIndex(rs[0].startContainer, rs[0].startOffset)
        const b = pointToIndex(rs[0].endContainer, rs[0].endOffset)
        if (a != null && b != null) return a <= b ? { start: a, end: b } : { start: b, end: a }
      }
    } catch {
      /* fall back to the selection */
    }
    return null
  }

  function onBeforeInput(e) {
    if (composing) return
    if (!editable) {
      e.preventDefault()
      return
    }
    let sel = getSel()
    const t = e.inputType
    if (t === 'insertReplacementText' || t === 'insertFromDrop') sel = targetRange(e) || sel
    if (!sel) return
    const { start, end } = sel
    const text = ytext.toString()

    if (t && t.indexOf('format') === 0) {
      const m = { formatBold: 'b', formatItalic: 'i', formatUnderline: 'u', formatStrikeThrough: 's' }[t]
      e.preventDefault()
      if (m) toggleMark(m)
      return
    }

    if (t && t.indexOf('history') === 0) {
      e.preventDefault()
      if (t === 'historyUndo') undo.undo()
      else undo.redo()
      return
    }

    if (t === 'insertParagraph' || t === 'insertLineBreak') {
      e.preventDefault()
      enter(sel)
      return
    }

    if (t && t.indexOf('insert') === 0) {
      e.preventDefault()
      let data
      if (t === 'insertFromPaste' || t === 'insertFromDrop' || t === 'insertFromYank' || t === 'insertReplacementText')
        data = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || e.data || ''
      else data = e.data != null ? e.data : ''
      const L = lines[lineIndexAt(start)]
      const marks =
        end > start
          ? charMarks(start)
          : pendingMarks && pendingMarksAt === start
            ? { ...pendingMarks }
            : L && start === L.start
              ? charMarks(start)
              : charMarks(start - 1)
      if (data === '' && end <= start) return
      if (t === 'insertFromPaste' || t === 'insertFromDrop') {
        pasteText(sel, data, marks)
        return
      }
      // list shortcuts: "- ", "1. ", "[] ", "# " … at the start of a paragraph
      // (also when a keyboard commits "1. " in one go, as phone keyboards do)
      if (data.endsWith(' ') && data.length <= 5 && end === start && t === 'insertText' && L && !L.attrs.lt) {
        const typedBefore = text.slice(L.start, start)
        const prefix = typedBefore + data.slice(0, -1)
        const sc = prefix.length <= 4 ? shortcutFor(prefix) : null
        if (sc) {
          const at = L.start
          pendingCaret = at
          lastArrow = null
          tx(() => {
            ensureTerm()
            if (typedBefore.length) ytext.delete(at, typedBefore.length)
            const ls = docLines()
            const D = ls[lineIndexAt(at)] || ls.find((x) => x.start === at)
            const cur = pickLine(D.attrs)
            const next = { ...cur, ...sc }
            if (sc.lt !== 'h') next.bid = cur.bid || genLineId()
            ytext.format(D.start + D.len, 1, fullLine(next))
          })
          lastShortcut = { at, orig: prefix + ' ' }
          return
        }
      }
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
      lastShortcut = null
      replaceRange(start, end, data, marks)
      return
    }

    if (t && t.indexOf('delete') === 0) {
      e.preventDefault()
      if (end > start) {
        lastArrow = null
        lastShortcut = null
        deleteRange(start, end)
        return
      }
      const iL = lineIndexAt(start)
      const L = lines[iL]
      // Backspace straight after a smart arrow puts the typed characters back.
      if (t === 'deleteContentBackward' && lastArrow && lastArrow.at === start && text[start - 1] === lastArrow.glyph) {
        const la = lastArrow
        lastArrow = null
        replaceRange(start - 1, start, la.orig, charMarks(start - 1))
        return
      }
      lastArrow = null
      const fwd = t.indexOf('Forward') >= 0 || t.indexOf('forward') >= 0
      if (!fwd && L && start === L.start) {
        // Backspace right after a list shortcut: back to the typed text
        if (lastShortcut && lastShortcut.at === L.start && L.attrs.lt) {
          const orig = lastShortcut.orig
          lastShortcut = null
          pendingCaret = L.start + orig.length
          tx(() => {
            ensureTerm()
            const ls = docLines()
            const D = ls[iL]
            ytext.format(D.start + D.len, 1, { lt: null, mk: null, done: null, ind: null })
            ytext.insert(D.start, orig, {})
          })
          return
        }
        lastShortcut = null
        // at the start of a list item / checkbox / heading: drop the type first
        if (L.attrs.lt) {
          pendingCaret = start
          patchLines(iL, iL, () => ({ lt: null, mk: null, done: null, ind: null }))
          return
        }
        if (iL > 0 && lines[iL - 1].hidden) {
          revealLine(iL - 1)
          setCaret(start)
          return
        }
        if (iL > 0 && L.len > 0 && embedOf(lines[iL - 1].text)) {
          // after a picture: select it rather than glue text onto its address
          const P = lines[iL - 1]
          setSelection(P.start, P.start + P.len)
          return
        }
      }
      lastShortcut = null
      if (fwd && L && start === L.start + L.len) {
        if (iL + 1 >= lines.length) return // never eat the final line break
        if (lines[iL + 1].hidden) {
          revealLine(iL + 1)
          setCaret(start)
          return
        }
      }
      let from = start
      let to = start
      if (t.indexOf('Word') >= 0) {
        if (fwd) to = wordBoundaryFwd(text, start)
        else from = wordBoundaryBack(text, start)
      } else if (t.indexOf('Line') >= 0 || t.indexOf('SoftLine') >= 0 || t.indexOf('HardLine') >= 0) {
        if (fwd) to = lineBoundaryFwd(text, start)
        else from = lineBoundaryBack(text, start)
        if (to === from && fwd) to = Math.min(text.length, from + 1)
        if (to === from && !fwd) from = Math.max(0, to - 1)
      } else {
        if (fwd) to = Math.min(text.length, start + 1)
        else from = Math.max(0, start - 1)
      }
      // the final '\n' of the body is structural
      if (text.length && text[text.length - 1] === '\n') to = Math.min(to, text.length - 1)
      if (to > from) deleteRange(from, to)
      return
    }

    // Anything else (rare): stay controlled.
    e.preventDefault()
  }

  // Pasting several lines: list prefixes ("- ", "1. ", "- [ ] ") become real
  // list lines, which is also how copy → paste between notes keeps structure.
  function pasteText(sel, data, marks) {
    const text = String(data || '').replace(/\r\n?/g, '\n')
    const rows = text.split('\n')
    const parsed = rows.map((r) => parseLinePrefix(r))
    if (rows.length < 2 || !parsed.some(Boolean)) {
      replaceRange(sel.start, sel.end, text, marks)
      return
    }
    lastArrow = null
    lastShortcut = null
    pendingMarks = null
    tx(() => {
      ensureTerm()
      deleteSpan(sel.start, sel.end)
      let p = sel.start
      const s0 = ytext.toString()
      const term0 = s0.indexOf('\n', p)
      const curAttrs = pickLine(charAttrs(term0))
      const lineStart = lineBoundaryBack(s0, p)
      const emptyHere = term0 === lineStart && !curAttrs.lt
      for (let k = 0; k < rows.length; k++) {
        const pr = parsed[k]
        const body = pr ? pr.rest : rows[k]
        const attrs = pr ? { ...pr.attrs } : {}
        if (isList(attrs)) attrs.bid = genLineId()
        if (body) {
          ytext.insert(p, body, {})
          p += body.length
        }
        if (k < rows.length - 1) {
          const lineAttrs = k === 0 && !emptyHere ? continuation(curAttrs) : attrs
          ytext.insert(p, '\n', fullLine(lineAttrs))
          p += 1
        } else if (pr) {
          // the last pasted line ends with the existing line break: give it its type
          const s = ytext.toString()
          const term = s.indexOf('\n', p)
          if (term >= 0) ytext.format(term, 1, fullLine({ ...pickLine(charAttrs(term)), ...attrs }))
        }
      }
      pendingCaret = p
    })
  }

  // Copy / cut as text with list prefixes, so structure survives a paste.
  function selectionPlain(sel) {
    const s = ytext.toString().slice(sel.start, sel.end)
    if (s.indexOf('\n') < 0) return s
    const a = lineIndexAt(sel.start)
    const out = []
    let pos = sel.start
    for (let i = a; i < lines.length && pos < sel.end; i++) {
      const L = lines[i]
      const from = Math.max(L.start, sel.start)
      const to = Math.min(L.start + L.len, sel.end)
      let line = ytext.toString().slice(from, to)
      if (from === L.start) {
        const at = L.attrs
        const pad = '  '.repeat(isList(at) ? at.ind || 0 : 0)
        if (at.lt === 'todo') line = pad + (at.done ? '- [x] ' : '- [ ] ') + line
        else if (at.lt === 'li') {
          const mk = at.mk || 'disc'
          line = pad + (NUMERIC.has(mk) ? (L.el.querySelector('.rb-mark') || {}).textContent + ' ' : mk === 'arrow' ? '→ ' : '- ') + line
        } else if (at.lt === 'h') line = '# ' + line
      }
      out.push(line)
      pos = L.start + L.len + 1
    }
    return out.join('\n')
  }

  function onCopy(e) {
    const sel = getSel()
    if (!sel || sel.end <= sel.start || !e.clipboardData) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', selectionPlain(sel))
  }
  function onCut(e) {
    const sel = getSel()
    if (!sel || sel.end <= sel.start || !e.clipboardData) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', selectionPlain(sel))
    if (editable) deleteRange(sel.start, sel.end)
  }

  // pictures pasted or dropped: hand them to the app to upload
  function imageFiles(dt) {
    if (!dt) return []
    const out = []
    for (const f of Array.from(dt.files || [])) if (/^image\//.test(f.type)) out.push(f)
    if (!out.length && dt.items) {
      for (const it of Array.from(dt.items)) {
        if (it.kind === 'file' && /^image\//.test(it.type)) {
          const f = it.getAsFile()
          if (f) out.push(f)
        }
      }
    }
    return out
  }
  function onPaste(e) {
    if (!editable || !onFiles) return
    const files = imageFiles(e.clipboardData)
    if (!files.length) return
    e.preventDefault()
    lastSel = getSel() || lastSel
    onFiles(files)
  }
  function onDrop(e) {
    if (!editable || !onFiles) return
    const files = imageFiles(e.dataTransfer)
    if (!files.length) return
    e.preventDefault()
    let idx = null
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(e.clientX, e.clientY)
      if (r && el.contains(r.startContainer)) idx = pointToIndex(r.startContainer, r.startOffset)
    }
    if (idx != null) lastSel = { start: idx, end: idx }
    onFiles(files)
  }

  // Put picture/video URLs on lines of their own at the caret (or the end).
  function insertMedia(urls) {
    const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean)
    if (!list.length) return
    const sel = (document.activeElement === el && getSel()) || lastSel
    tx(() => {
      ensureTerm()
      const ls = docLines()
      let i = sel ? Math.min(ls.length - 1, lineIndexAt(Math.min(sel.start, total))) : ls.length - 1
      if (i < 0) i = 0
      const L = ls[i]
      let p
      if (!L.len && !L.attrs.lt) {
        // an empty line: the first picture goes right here
        ytext.insert(L.start, list[0], {})
        p = L.start + list[0].length + 1
        list.shift()
      } else p = L.start + L.len + 1
      for (const u of list) {
        ytext.insert(p, u, {})
        p += u.length
        ytext.insert(p, '\n', fullLine({}))
        p += 1
      }
      pendingCaret = Math.max(0, p - 1)
    })
  }

  function onInput() {
    if (composing) return
    if (domText() === ytext.toString()) return
    reconcilePlain({})
  }

  function onCompositionStart() {
    composing = true
  }
  function onCompositionEnd() {
    composing = false
    reconcilePlain(pendingMarks || {})
    emitState()
  }

  // Keyboard shortcuts (consistent across browsers; we own these so the
  // browser's native bold/italic never double-fires).
  function onKeyDown(e) {
    if (picker && pickerKey(e)) return
    if (!editable) return
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      indent(e.shiftKey ? -1 : 1)
      return
    }
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return
    const k = e.key.toLowerCase()
    if (e.shiftKey && !e.altKey) {
      if (k === 'l') return prevent(e, () => setAlign('left'))
      if (k === 'e') return prevent(e, () => setAlign('center'))
      if (k === 'r') return prevent(e, () => setAlign('right'))
      if (e.code === 'Digit7') return prevent(e, () => toggleList('decimal'))
      if (e.code === 'Digit8') return prevent(e, () => toggleList('disc'))
      if (e.code === 'Digit9') return prevent(e, () => toggleTodo())
    }
    if (k === '.' && !e.shiftKey) return prevent(e, toggleFoldAtCaret)
    if (k === 'enter') {
      const sel = getSel()
      const i = sel ? lineIndexAt(sel.start) : -1
      if (i >= 0 && lines[i].attrs.lt === 'todo') return prevent(e, () => toggleDone(i))
    }
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
  function prevent(e, fn) {
    e.preventDefault()
    fn()
  }

  function toggleMark(mark) {
    if (!MARKS.includes(mark)) return
    const sel = getSel()
    if (!sel) return
    if (sel.end > sel.start) {
      const has = rangeHasMark(sel.start, sel.end, mark)
      pendingRange = [sel.start, sel.end]
      // format only the characters, never the line breaks (they hold line attributes)
      const s = ytext.toString()
      tx(() => {
        let a = sel.start
        while (a < sel.end) {
          let b = s.indexOf('\n', a)
          if (b < 0 || b > sel.end) b = sel.end
          if (b > a) ytext.format(a, b - a, { [mark]: has ? null : true })
          a = b + 1
        }
      })
    } else {
      const base = pendingMarks && pendingMarksAt === sel.start ? { ...pendingMarks } : charMarks(sel.start - 1)
      if (base[mark]) delete base[mark]
      else base[mark] = true
      pendingMarks = base
      pendingMarksAt = sel.start
      emitState()
    }
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

  // ---- clicks: links, checkboxes, fold arrows -------------------------------
  // A click on an unfocused note follows a link; while editing, Ctrl/Cmd+click does.
  let hadFocusAtPointerDown = false
  function onPointerDown(e) {
    hadFocusAtPointerDown = document.activeElement === el
    const hit = e.target && e.target.closest ? e.target.closest('.rb-check, .rb-fold, .rb-more') : null
    if (hit && el.contains(hit)) e.preventDefault() // don't move the caret / steal focus
  }
  function onClick(e) {
    const tgt = e.target && e.target.closest ? e.target : null
    if (!tgt) return
    const ctl = tgt.closest('.rb-check, .rb-fold, .rb-more')
    if (ctl && el.contains(ctl)) {
      e.preventDefault()
      e.stopPropagation()
      const lineEl = ctl.closest('.rb-line')
      const i = lineEl ? Number(lineEl.dataset.i) : -1
      if (i < 0 || !lines[i]) return
      if (ctl.classList.contains('rb-check')) toggleDone(i)
      else toggleFold(i)
      return
    }
    if (!onLink) return
    const a = tgt.closest('a.rb-link')
    if (!a || !el.contains(a)) return
    if (hadFocusAtPointerDown && editable && !(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    onLink(a.dataset.href)
  }

  // ---- Yjs observer ----
  function observer(event, transaction) {
    const local = transaction.origin === LOCAL
    if (composing && !local) return // folded in by reconcilePlain on compositionend
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
      emitState()
      updatePicker()
      return
    }
    // remote (or undo/redo, or the other editor of this note): keep the caret roughly where it was.
    const focused = document.activeElement === el
    const sel = focused ? getSel() : null
    render()
    if (sel) {
      const s = shiftThroughDelta(event.delta, sel.start)
      const en = shiftThroughDelta(event.delta, sel.end)
      setSelection(s, en)
    }
    onChange()
    if (focused) emitState()
  }

  // Track selection movement to keep the toolbar honest and expire pending marks.
  function onSelectionChange() {
    if (document.activeElement !== el) return
    const sel = getSel()
    if (sel) lastSel = sel
    if (sel && !(pendingMarks && pendingMarksAt === sel.start)) {
      pendingMarks = null
      pendingMarksAt = -1
    }
    emitState()
    updatePicker()
  }

  // ---- wire up ----
  render()
  ytext.observe(observer)
  const unsubFolds = folds && folds.subscribe ? folds.subscribe(() => render()) : null
  el.addEventListener('beforeinput', onBeforeInput)
  el.addEventListener('input', onInput)
  el.addEventListener('keydown', onKeyDown)
  el.addEventListener('compositionstart', onCompositionStart)
  el.addEventListener('compositionend', onCompositionEnd)
  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('click', onClick)
  el.addEventListener('copy', onCopy)
  el.addEventListener('cut', onCut)
  el.addEventListener('paste', onPaste)
  el.addEventListener('drop', onDrop)
  let blurTimer = null
  const onBlur = () => {
    clearTimeout(blurTimer)
    blurTimer = setTimeout(closePicker, 120)
  }
  const onFocus = () => clearTimeout(blurTimer)
  el.addEventListener('blur', onBlur)
  el.addEventListener('focus', onFocus)
  document.addEventListener('selectionchange', onSelectionChange)

  return {
    toggleMark,
    indent,
    toggleList,
    toggleTodo,
    toggleHeading,
    setAlign,
    toggleFoldAtCaret,
    insertMedia,
    getActiveMarks: activeMarks,
    lineState,
    refresh: () => render(),
    focus: () => el.focus(),
    focusEnd: () => {
      el.focus()
      const L = lines[lines.length - 1]
      if (L) setCaret(L.start + L.len)
    },
    setSpellcheck: (on) => {
      el.spellcheck = !!on
    },
    setEditable: (on) => {
      editable = !!on
      el.contentEditable = editable ? 'true' : 'false'
    },
    undo: () => undo.undo(),
    redo: () => undo.redo(),
    destroy() {
      closePicker()
      if (unsubFolds) unsubFolds()
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('click', onClick)
      ytext.unobserve(observer)
      el.removeEventListener('beforeinput', onBeforeInput)
      el.removeEventListener('input', onInput)
      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('compositionstart', onCompositionStart)
      el.removeEventListener('compositionend', onCompositionEnd)
      el.removeEventListener('copy', onCopy)
      el.removeEventListener('cut', onCut)
      el.removeEventListener('paste', onPaste)
      el.removeEventListener('drop', onDrop)
      el.removeEventListener('blur', onBlur)
      el.removeEventListener('focus', onFocus)
      document.removeEventListener('selectionchange', onSelectionChange)
      undo.destroy()
    },
  }
}
