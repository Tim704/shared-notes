// A note's bullet points drawn as a mind map. The outline IS the map: the
// title is the root, headings / paragraphs are its branches, list items nest
// under them by indent (see outlineTree in shared/lines.js). Editing the map
// edits those lines, so the text view and the map never disagree.
//
//   click a node        edit its text (Enter: new sibling, Tab: new child,
//                       Backspace on empty: remove, Esc: cancel)
//   drag a node         onto another node to move it (and what hangs off it) there
//   drag the background pan;  Ctrl/⌘ + wheel or pinch: zoom;  ⤢ fit
//
// Layout is a balanced left/right tree with curved branches, one colour per
// top-level branch. Pure SVG, no dependencies.

import { linesOf, outlineTree, isList, genLineId, numericForLevel } from '../shared/lines.js'
import { setLineText, insertLinesAfter, insertLinesAt, deleteLines, moveLines, setLineAttrs, ensureTerminator } from '../shared/lineops.js'
import { rafThrottle } from './util.js'

const NS = 'http://www.w3.org/2000/svg'
const BRANCH = ['#e8590c', '#2f9e44', '#1c7ed6', '#ae3ec9', '#f08c00', '#0c8599', '#d6336c', '#5c940d']
const FONT = '600 13px "Schibsted Grotesk", ui-sans-serif, system-ui, sans-serif'
const ROOT_FONT = '700 16px "Schibsted Grotesk", ui-sans-serif, system-ui, sans-serif'
const PAD_X = 10
const NODE_H = 28
const ROOT_H = 38
const V_GAP = 10
const H_GAP = 46
const MAX_W = 220

let measureCtx = null
function textWidth(s, font) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
  measureCtx.font = font
  return measureCtx.measureText(s).width
}

function clip(s, font, max) {
  if (textWidth(s, font) <= max) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (textWidth(s.slice(0, mid) + '…', font) <= max) lo = mid
    else hi = mid - 1
  }
  return s.slice(0, lo) + '…'
}

const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
  if (parent) parent.appendChild(n)
  return n
}

export function createMindMap(host, note, opts = {}) {
  const body = note.get('body')
  const title = note.get('title')
  const editable = opts.editable !== false
  const LOCAL = { binding: 'mindmap' }

  const wrap = document.createElement('div')
  wrap.className = 'mm-wrap'
  const svg = el('svg', { class: 'mm-svg' })
  const scene = el('g', { class: 'mm-scene' }, svg)
  const tools = document.createElement('div')
  tools.className = 'mm-tools'
  const mkTool = (label, title, fn) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'mm-tool'
    b.textContent = label
    b.title = title
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      fn()
    })
    b.addEventListener('pointerdown', (e) => e.stopPropagation())
    tools.appendChild(b)
    return b
  }
  mkTool('−', 'Zoom out', () => zoomBy(1 / 1.2))
  mkTool('+', 'Zoom in', () => zoomBy(1.2))
  mkTool('⤢', 'Fit', () => fit())
  mkTool('⬇', 'Save as picture (PNG)', () => exportPng())
  mkTool('SVG', 'Save as SVG', () => exportSvg())
  wrap.append(svg, tools)
  host.appendChild(wrap)

  let view = { x: 0, y: 0, k: 1 }
  let fitted = true // until the user pans/zooms, keep the whole map in view
  let bounds = { x: 0, y: 0, w: 1, h: 1 }
  let nodes = [] // laid-out nodes: { kind:'root'|'line', index, x, y, w, h, label, depth, color, side }
  let editor = null

  // ---- layout ----------------------------------------------------------------
  function build() {
    const lines = linesOf(body)
    const tree = outlineTree(lines)
    const label = (L) => {
      const a = L.attrs || {}
      const t = L.text.trim() || ' '
      if (a.lt === 'todo') return (a.done ? '☑ ' : '☐ ') + t
      return t
    }
    const rootLabel = clip(title.toString().trim() || 'Untitled', ROOT_FONT, 280)
    const root = {
      kind: 'root',
      index: -1,
      label: rootLabel,
      w: Math.max(80, textWidth(rootLabel, ROOT_FONT) + PAD_X * 2.4),
      h: ROOT_H,
      children: [],
      depth: 0,
    }
    const conv = (t, depth, color, side) => {
      const lab = clip(label(t.line), FONT, MAX_W)
      const n = {
        kind: 'line',
        index: t.index,
        line: t.line,
        label: lab,
        w: textWidth(lab, FONT) + PAD_X * 2,
        h: NODE_H,
        depth,
        color,
        side,
        children: [],
      }
      n.children = t.children.map((c) => conv(c, depth + 1, color, side))
      return n
    }
    // balance the top-level branches between the right and the left
    const weight = (t) => Math.max(1, t.children.reduce((s, c) => s + weight(c), 0))
    const total = tree.reduce((s, t) => s + weight(t), 0)
    let acc = 0
    tree.forEach((t, i) => {
      const side = tree.length > 1 && acc >= total / 2 ? -1 : 1
      acc += weight(t)
      root.children.push(conv(t, 1, BRANCH[i % BRANCH.length], side))
    })
    // a second pass: right-hand branches first (top to bottom), then left
    const right = root.children.filter((c) => c.side === 1)
    const left = root.children.filter((c) => c.side === -1)
    const out = [root]
    root.x = 0
    root.y = 0
    for (const [list, dir] of [
      [right, 1],
      [left, -1],
    ]) {
      // heights of subtrees
      const span = (n) => {
        if (!n.children.length) return (n.span = n.h)
        const s = n.children.reduce((a, c) => a + span(c), 0) + V_GAP * (n.children.length - 1)
        return (n.span = Math.max(n.h, s))
      }
      const totalH = list.reduce((a, c) => a + span(c), 0) + V_GAP * Math.max(0, list.length - 1)
      let y = -totalH / 2
      const place = (n, parentX, parentW) => {
        n.x = parentX + dir * (parentW / 2 + H_GAP + n.w / 2)
        out.push(n)
        if (!n.children.length) {
          n.y = y + n.span / 2
          y += n.span + V_GAP
          return
        }
        const start = y
        const kidsH = n.children.reduce((a, c) => a + c.span, 0) + V_GAP * (n.children.length - 1)
        if (n.span > kidsH) y += (n.span - kidsH) / 2
        n.children.forEach((c) => place(c, n.x, n.w))
        const first = n.children[0]
        const last = n.children[n.children.length - 1]
        n.y = (first.y + last.y) / 2
        y = start + n.span + V_GAP
      }
      list.forEach((c) => place(c, root.x, root.w))
    }
    return out
  }

  // ---- drawing -----------------------------------------------------------------
  function render() {
    if (editor) return // don't yank the input away mid-edit; it re-renders on commit
    nodes = build()
    scene.replaceChildren()
    const links = el('g', { class: 'mm-links' }, scene)
    const boxes = el('g', { class: 'mm-nodes' }, scene)
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const byParent = (n) => {
      for (const c of n.children || []) {
        const dir = c.side
        const x1 = n.x + (dir * n.w) / 2
        const y1 = n.y
        const x2 = c.x - (dir * c.w) / 2
        const y2 = c.y
        const mx = (x1 + x2) / 2
        el(
          'path',
          {
            d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
            stroke: c.color,
            'stroke-width': n.kind === 'root' ? 3 : 2,
            fill: 'none',
            'stroke-linecap': 'round',
            opacity: 0.85,
          },
          links
        )
        byParent(c)
      }
    }
    byParent(nodes[0])
    for (const n of nodes) {
      const g = el('g', { class: 'mm-node' + (n.kind === 'root' ? ' mm-root' : ''), transform: `translate(${n.x},${n.y})` }, boxes)
      g.dataset.index = String(n.index)
      const a = (n.line && n.line.attrs) || {}
      el(
        'rect',
        {
          x: -n.w / 2,
          y: -n.h / 2,
          width: n.w,
          height: n.h,
          rx: n.kind === 'root' ? 12 : 8,
          fill: n.kind === 'root' ? 'var(--mm-root, #1f2228)' : n.depth === 1 ? n.color : 'var(--mm-node, #ffffff)',
          stroke: n.kind === 'root' ? 'none' : n.color,
          'stroke-width': n.depth === 1 ? 0 : 1.6,
        },
        g
      )
      const t = el(
        'text',
        {
          x: 0,
          y: 1,
          'text-anchor': 'middle',
          'dominant-baseline': 'middle',
          fill: n.kind === 'root' ? '#fff' : n.depth === 1 ? '#fff' : '#1f2228',
          style: 'font:' + (n.kind === 'root' ? ROOT_FONT : FONT) + (a.lt === 'todo' && a.done ? ';text-decoration:line-through' : ''),
        },
        g
      )
      t.textContent = n.label
      minX = Math.min(minX, n.x - n.w / 2)
      maxX = Math.max(maxX, n.x + n.w / 2)
      minY = Math.min(minY, n.y - n.h / 2)
      maxY = Math.max(maxY, n.y + n.h / 2)
    }
    if (nodes.length === 1) {
      const hint = el('text', { x: 0, y: 46, 'text-anchor': 'middle', class: 'mm-hint' }, scene)
      hint.textContent = editable ? 'Click the title, then press Tab to add a branch' : 'No bullet points yet'
      maxY += 60
    }
    bounds = { x: minX - 30, y: minY - 30, w: maxX - minX + 60, h: maxY - minY + 60 }
    if (fitted) fit(true)
    else applyView()
  }

  function applyView() {
    scene.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`)
  }

  function fit(keep) {
    const W = wrap.clientWidth || host.clientWidth || 300
    const H = wrap.clientHeight || host.clientHeight || 200
    const k = Math.min(1.6, Math.max(0.15, Math.min(W / bounds.w, H / bounds.h)))
    view = { k, x: W / 2 - (bounds.x + bounds.w / 2) * k, y: H / 2 - (bounds.y + bounds.h / 2) * k }
    if (!keep) fitted = true
    applyView()
  }

  function zoomBy(f, cx, cy) {
    const W = wrap.clientWidth
    const H = wrap.clientHeight
    const px = cx == null ? W / 2 : cx
    const py = cy == null ? H / 2 : cy
    const k = Math.max(0.1, Math.min(4, view.k * f))
    view = { k, x: px - ((px - view.x) / view.k) * k, y: py - ((py - view.y) / view.k) * k }
    fitted = false
    applyView()
  }

  // ---- editing -------------------------------------------------------------------
  function tx(fn) {
    note.doc.transact(fn, LOCAL)
  }

  function lineLevel(a) {
    if (!a) return -1
    if (isList(a)) return a.ind || 0
    return -1
  }

  // attributes for a new child of node n (root: a top-level paragraph)
  function childAttrs(n) {
    if (n.kind === 'root') return {}
    const a = n.line.attrs || {}
    const lvl = lineLevel(a) + 1
    if (a.lt === 'todo') return { lt: 'todo', ind: lvl || undefined }
    const mk = a.lt === 'li' && ['decimal', 'alpha', 'roman'].includes(a.mk) ? numericForLevel(lvl) : a.lt === 'li' ? a.mk || 'disc' : 'disc'
    return lvl ? { lt: 'li', mk, ind: lvl } : { lt: 'li', mk }
  }
  function siblingAttrs(n) {
    const a = { ...(n.line.attrs || {}) }
    delete a.bid
    delete a.done
    delete a.al
    delete a.ew
    return a
  }

  function startEdit(n, opts2 = {}) {
    if (!editable) return
    finishEdit(false)
    const r = wrap.getBoundingClientRect()
    const sx = view.x + n.x * view.k
    const sy = view.y + n.y * view.k
    const inp = document.createElement('input')
    inp.className = 'mm-input'
    inp.value = n.kind === 'root' ? title.toString() : n.line.text
    const w = Math.max(140, n.w * view.k + 30)
    inp.style.width = w + 'px'
    inp.style.left = sx - w / 2 + 'px'
    inp.style.top = sy - 16 + 'px'
    wrap.appendChild(inp)
    editor = { n, inp }
    inp.focus()
    if (opts2.selectAll !== false) inp.select()
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        finishEdit(false)
      } else if (e.key === 'Enter' && n.kind !== 'root') {
        e.preventDefault()
        const at = commit()
        addNode(at, 'sibling')
      } else if (e.key === 'Tab') {
        e.preventDefault()
        const at = commit()
        addNode(at, 'child')
      } else if (e.key === 'Enter') {
        e.preventDefault()
        finishEdit(true)
      } else if (e.key === 'Backspace' && !inp.value && n.kind !== 'root') {
        e.preventDefault()
        const idx = n.index
        editor = null
        inp.remove()
        tx(() => deleteLines(body, idx, idx + 1))
        render()
      }
    })
    inp.addEventListener('blur', () => setTimeout(() => editor && editor.inp === inp && finishEdit(true), 0))
    void r
  }

  // write the edit; returns a description of the node for addNode
  function commit() {
    if (!editor) return null
    const { n, inp } = editor
    editor = null
    inp.remove()
    const v = inp.value.replace(/\s*\n\s*/g, ' ')
    if (n.kind === 'root') {
      if (v !== title.toString())
        tx(() => {
          if (title.length) title.delete(0, title.length)
          if (v) title.insert(0, v)
        })
      return { kind: 'root' }
    }
    if (v !== n.line.text) tx(() => setLineText(body, n.index, v))
    return { kind: 'line', index: n.index, attrs: n.line.attrs }
  }

  function finishEdit(save) {
    if (!editor) return
    if (save) commit()
    else {
      editor.inp.remove()
      editor = null
    }
    render()
  }

  function addNode(at, how) {
    if (!at) return render()
    let newIndex = -1
    tx(() => {
      ensureTerminator(body)
      const lines = linesOf(body)
      if (at.kind === 'root') {
        // a new top-level branch at the end
        const onlyBlank = lines.length === 1 && !lines[0].text && !lines[0].attrs.lt
        if (onlyBlank) newIndex = 0
        else {
          insertLinesAt(body, body.length, [{ text: '', attrs: {} }])
          newIndex = lines.length
        }
        return
      }
      const fake = { kind: 'line', line: { attrs: at.attrs || {} } }
      const attrs = how === 'child' ? childAttrs(fake) : siblingAttrs(fake)
      if (attrs.lt === 'li' || attrs.lt === 'todo') attrs.bid = genLineId()
      newIndex = insertLinesAfter(body, at.index, [{ text: '', attrs }], true)
    })
    render()
    const n = nodes.find((x) => x.index === newIndex)
    if (n) startEdit(n)
    else if (at.kind === 'root') {
      // an empty first line has no node (blank lines are skipped): edit via a stub
      const stub = { kind: 'line', index: newIndex, line: { text: '', attrs: {} }, x: 140, y: 0, w: 120, h: NODE_H }
      startEdit(stub)
    }
  }

  // ---- pointer: pan, select, drag to re-parent ------------------------------------
  let drag = null
  function nodeAt(target) {
    const g = target && target.closest ? target.closest('.mm-node') : null
    if (!g) return null
    const idx = Number(g.dataset.index)
    return nodes.find((n) => n.index === idx) || null
  }
  svg.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button > 0 && e.pointerType === 'mouse') return
    if (!editable) return // a read-only preview (phone grid): let the tap open the note
    e.stopPropagation()
    const n = nodeAt(e.target)
    drag = { n, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false, id: e.pointerId, ghost: null }
    try {
      svg.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  })
  svg.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return
    const dx = e.clientX - drag.sx
    const dy = e.clientY - drag.sy
    if (!drag.moved && Math.hypot(dx, dy) < 5) return
    drag.moved = true
    if (!drag.n || drag.n.kind === 'root' || !editable) {
      view.x = drag.vx + dx
      view.y = drag.vy + dy
      fitted = false
      applyView()
      return
    }
    // dragging a node: show a ghost and highlight the drop target
    if (!drag.ghost) {
      drag.ghost = document.createElement('div')
      drag.ghost.className = 'mm-ghost'
      drag.ghost.textContent = drag.n.label
      wrap.appendChild(drag.ghost)
    }
    const r = wrap.getBoundingClientRect()
    drag.ghost.style.left = e.clientX - r.left + 8 + 'px'
    drag.ghost.style.top = e.clientY - r.top + 8 + 'px'
    const over = nodeAt(document.elementFromPoint(e.clientX, e.clientY))
    scene.querySelectorAll('.mm-drop').forEach((g) => g.classList.remove('mm-drop'))
    if (over && over !== drag.n && !isInside(over, drag.n)) {
      const g = scene.querySelector(`.mm-node[data-index="${over.index}"]`)
      if (g) g.classList.add('mm-drop')
      drag.over = over
    } else drag.over = null
  })
  const up = (e) => {
    if (!drag || e.pointerId !== drag.id) return
    const d = drag
    drag = null
    if (d.ghost) d.ghost.remove()
    scene.querySelectorAll('.mm-drop').forEach((g) => g.classList.remove('mm-drop'))
    if (!d.moved) {
      if (d.n) startEdit(d.n)
      return
    }
    if (d.n && d.over && e.type === 'pointerup') reparent(d.n, d.over)
  }
  svg.addEventListener('pointerup', up)
  svg.addEventListener('pointercancel', up)
  svg.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const r = wrap.getBoundingClientRect()
      zoomBy(Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top)
    },
    { passive: false }
  )

  function isInside(a, b) {
    // is node a inside node b's subtree?
    const walk = (n) => n === a || (n.children || []).some(walk)
    return (b.children || []).some(walk)
  }

  function reparent(n, target) {
    const lines = linesOf(body)
    // n's subtree is the run of lines it owns
    const own = (node) => {
      let last = node.index
      const walk = (x) => {
        for (const c of x.children || []) {
          last = Math.max(last, c.index)
          walk(c)
        }
      }
      walk(node)
      return last + 1
    }
    const from = n.index
    const to = own(n)
    let after
    let newAttrs
    if (target.kind === 'root') {
      after = lines.length - 1
      newAttrs = {}
    } else {
      after = own(target) - 1
      newAttrs = childAttrs(target)
    }
    if (after >= from && after < to) return
    const oldLvl = lineLevel(n.line.attrs)
    const newLvl = newAttrs.lt ? newAttrs.ind || 0 : -1
    tx(() => {
      // levels: a paragraph is -1, list items 0..5, so children keep their depth below it
      moveLines(body, from, to, after, newLvl - oldLvl)
      // the moved line itself takes the shape of a child of its new parent
      const moved = linesOf(body)
      const at = after < from ? after + 1 : after - (to - from) + 1
      if (moved[at]) {
        const keep = moved[at].attrs || {}
        const patch = { lt: newAttrs.lt || null, mk: newAttrs.mk || null, ind: newAttrs.ind || null }
        if (newAttrs.lt === 'todo' || keep.lt === 'todo') {
          patch.lt = keep.lt === 'todo' ? 'todo' : patch.lt
          patch.mk = null
        }
        if (patch.lt && !keep.bid) patch.bid = genLineId()
        setLineAttrs(body, at, patch)
      }
    })
    render()
  }

  // ---- export -----------------------------------------------------------------------
  function svgString() {
    const clone = svg.cloneNode(true)
    clone.setAttribute('xmlns', NS)
    clone.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`)
    clone.setAttribute('width', String(Math.round(bounds.w)))
    clone.setAttribute('height', String(Math.round(bounds.h)))
    clone.querySelector('.mm-scene').removeAttribute('transform')
    const style = document.createElementNS(NS, 'style')
    style.textContent = 'text{font-family:system-ui,sans-serif}'
    clone.insertBefore(style, clone.firstChild)
    const bg = document.createElementNS(NS, 'rect')
    bg.setAttribute('x', bounds.x)
    bg.setAttribute('y', bounds.y)
    bg.setAttribute('width', bounds.w)
    bg.setAttribute('height', bounds.h)
    bg.setAttribute('fill', '#fbfaf5')
    clone.insertBefore(bg, clone.querySelector('.mm-scene'))
    return new XMLSerializer()
      .serializeToString(clone)
      .replace(/var\(--mm-root, ([^)]+)\)/g, '$1')
      .replace(/var\(--mm-node, ([^)]+)\)/g, '$1')
  }
  const fileBase = () => (title.toString().trim() || 'mind-map').replace(/[^\w-]+/g, '-').slice(0, 40)
  function save(blob, name) {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    document.body.appendChild(a)
    a.click()
    setTimeout(() => {
      URL.revokeObjectURL(a.href)
      a.remove()
    }, 1000)
  }
  function exportSvg() {
    save(new Blob([svgString()], { type: 'image/svg+xml' }), fileBase() + '.svg')
  }
  function exportPng() {
    const img = new Image()
    const url = URL.createObjectURL(new Blob([svgString()], { type: 'image/svg+xml' }))
    img.onload = () => {
      const k = 2
      const c = document.createElement('canvas')
      c.width = Math.round(bounds.w * k)
      c.height = Math.round(bounds.h * k)
      const ctx = c.getContext('2d')
      ctx.scale(k, k)
      ctx.drawImage(img, 0, 0, bounds.w, bounds.h)
      URL.revokeObjectURL(url)
      c.toBlob((b) => b && save(b, fileBase() + '.png'), 'image/png')
    }
    img.src = url
  }

  // ---- live ----------------------------------------------------------------------------
  const schedule = rafThrottle(render)
  const obs = () => schedule()
  body.observe(obs)
  title.observe(obs)
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => fitted && fit(true)) : null
  if (ro) ro.observe(wrap)
  render()

  return {
    refresh: render,
    fit,
    exportSvg,
    exportPng,
    destroy() {
      body.unobserve(obs)
      title.unobserve(obs)
      if (ro) ro.disconnect()
      if (editor) editor.inp.remove()
      wrap.remove()
    },
  }
}
