import * as Y from 'yjs'
import { icon, iconLabel } from './icons.js'
import * as ui from './ui.js'
import { genId } from './util.js'
import { uploadImages, openLightbox, pickImages } from './media.js'
import { linesOf, outlineTree } from '../shared/lines.js'
import { ROOT, BRANCH, mapTree, layoutMap, fromOutline, branchIds, branchToTasks } from '../shared/mindmap.js'

// A mind map tab: ideas around a centre. Bubbles grow from the centre with
// Enter / Tab and lay themselves out as a tidy left/right tree, but any bubble
// can be dragged anywhere (it stays pinned there), dropped onto another bubble
// to move it under that one, and linked to any other bubble. Double-clicking
// empty space drops a loose idea. Bubbles can have a colour, a shape, a note
// and a picture, and a branch can be sent to a To-do tab as a task with parts.
//
// Data and layout live in shared/mindmap.js. Pure SVG, no dependencies.
//
//   click: select          double-click / Enter / F2 / typing: edit
//   Tab: new child         Enter after editing: new sibling
//   Delete: remove branch  arrows: move around   Space: fold
//   drag bubble: onto another to re-parent, onto empty space to pin
//   Alt-drag bubble to bubble: link     drag background: pan
//   Ctrl/⌘+wheel or pinch: zoom         Ctrl/⌘+Z: undo
//
// createMindMap(host, page, opts) → { destroy, fit, addChild, exportPng, exportSvg }
// opts: { todoTabs(): [{id,name}], sendToTodo(tabId|null, tree) }

const NS = 'http://www.w3.org/2000/svg'
const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Inter var", "Segoe UI", system-ui, sans-serif'
const FONT = '500 14px ' + FONT_FAMILY
const FONT_1 = '600 15px ' + FONT_FAMILY
const ROOT_FONT = '700 18px ' + FONT_FAMILY
const LINE_H = 19
const MAX_TEXT_W = 200
const MAX_LINES = 3
const PAD_X = 14
const PAD_Y = 9
const IMG_W = 160
const IMG_H = 100
const LOCAL = { mindmap: 'local' }
const SETUP = { mindmap: 'setup' }

let measureCtx = null
function textWidth(s, font) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
  measureCtx.font = font
  return measureCtx.measureText(s).width
}
// word-wrap into at most MAX_LINES lines (the last one cut with …)
function wrapText(s, font, max) {
  const words = String(s || '').replace(/\s+/g, ' ').trim().split(' ')
  const lines = []
  let cur = ''
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w
    if (textWidth(next, font) <= max || !cur) cur = next
    else {
      lines.push(cur)
      cur = w
    }
  }
  if (cur) lines.push(cur)
  const out = lines.slice(0, MAX_LINES).map((l) => clip(l, font, max))
  if (lines.length > MAX_LINES) out[MAX_LINES - 1] = clip(out[MAX_LINES - 1] + '…', font, max)
  return out.length ? out : ['']
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
// mix two #rrggbb colours (t = share of b)
function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [x, y] = [p(a), p(b)]
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')
}
const isHex = (c) => /^#[0-9a-f]{6}$/i.test(c || '')

const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
  if (parent) parent.appendChild(n)
  return n
}
const phone = () => matchMedia('(max-width: 600px)').matches

export function createMindMap(host, page, opts = {}) {
  const doc = page.doc
  const title = page.get('title')

  // ---- a map from before bubbles had their own data: convert it once ----
  if (!(page.get('nodes') instanceof Y.Map)) {
    doc.transact(() => {
      const nodes = new Y.Map()
      const body = page.get('body')
      const rows = body ? fromOutline(outlineTree(linesOf(body)), genId) : []
      for (const r of rows) {
        const m = new Y.Map()
        m.set('text', r.text)
        m.set('parent', r.parent)
        m.set('order', r.order)
        nodes.set(r.id, m)
      }
      page.set('nodes', nodes)
      page.set('links', new Y.Map())
      page.set('v', 2)
    }, SETUP)
  }
  if (!(page.get('links') instanceof Y.Map)) doc.transact(() => page.set('links', new Y.Map()), SETUP)
  const nodes = page.get('nodes')
  const links = page.get('links')
  const undo = new Y.UndoManager([nodes, links, title], { trackedOrigins: new Set([LOCAL]), captureTimeout: 300 })
  const tx = (fn) => doc.transact(fn, LOCAL)

  // ---- frame ----
  const wrap = document.createElement('div')
  wrap.className = 'mm-wrap'
  wrap.tabIndex = 0
  wrap.setAttribute('role', 'application')
  wrap.setAttribute('aria-label', 'Mind map')
  const svg = el('svg', { class: 'mm-svg' })
  const defs = el('defs', {}, svg)
  const arrow = el('marker', { id: 'mm-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs)
  el('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'context-stroke', class: 'mm-arrow' }, arrow)
  const scene = el('g', { class: 'mm-scene' }, svg)
  const gTree = el('g', { class: 'mm-branches' }, scene)
  const gLinks = el('g', { class: 'mm-links' }, scene)
  const gNodes = el('g', { class: 'mm-nodes' }, scene)
  const gTemp = el('g', { class: 'mm-temp' }, scene)

  const tools = document.createElement('div')
  tools.className = 'mm-tools'
  const mkTool = (label, tip, fn, iconName) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'mm-tool'
    if (iconName) b.appendChild(icon(iconName))
    else iconLabel(b, label)
    if (iconName && label) b.appendChild(document.createTextNode(label))
    b.title = tip
    b.setAttribute('aria-label', tip)
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      fn(b)
    })
    b.addEventListener('pointerdown', (e) => e.stopPropagation())
    tools.appendChild(b)
    return b
  }
  mkTool('−', 'Zoom out', () => zoomBy(1 / 1.2))
  mkTool('+', 'Zoom in', () => zoomBy(1.2))
  mkTool('⤢', 'Fit the whole map', () => fit())
  mkTool('Tidy', 'Tidy up: put every dragged bubble back in the tree', () => tidy(), 'grid')
  mkTool('', 'Save as picture or SVG', (b) =>
    ui.menu(b, [
      { label: 'Save as picture (PNG)', icon: 'download', onClick: exportPng },
      { label: 'Save as SVG', icon: 'download', onClick: exportSvg },
    ]),
    'download'
  )
  const hint = document.createElement('div')
  hint.className = 'mm-hint'
  hint.textContent = 'Tab: add an idea · Enter: next idea · double-click empty space: loose idea · drag: move · Alt-drag: link'
  const bar = document.createElement('div')
  bar.className = 'mm-bar'
  bar.hidden = true
  bar.addEventListener('pointerdown', (e) => e.stopPropagation())
  bar.addEventListener('click', (e) => e.stopPropagation())
  wrap.append(svg, tools, hint, bar)
  host.appendChild(wrap)

  // ---- state ----
  let view = { x: 0, y: 0, k: 1 }
  let fitted = true // until the user pans or zooms, keep the whole map in view
  let bounds = { x: -100, y: -50, w: 200, h: 100 }
  let tree = null
  let laid = []
  let sel = ROOT // selected bubble id (or null)
  let selLink = null // selected link id
  let editor = null // { id, inp }
  let afterEnter = false // Enter just finished an edit: the next Enter adds a sibling
  let linkFrom = null // the toolbar's Link: the next bubble clicked gets a link from this one
  let colors = {}

  function readColors() {
    const cs = getComputedStyle(wrap)
    const v = (n, f) => {
      const c = cs.getPropertyValue(n).trim()
      return isHex(c) ? c : f
    }
    colors = {
      paper: v('--mm-paper', '#ffffff'),
      ink: v('--mm-ink', '#1c1c1e'),
      dim: v('--mm-dim', '#8e8e93'),
      root: v('--mm-root', '#1c1c1e'),
      rootInk: v('--mm-root-ink', '#ffffff'),
      focus: v('--mm-focus', '#2f80ed'),
    }
  }

  // ---- sizes ----
  const fontOf = (n) => (n.isRoot ? ROOT_FONT : n.depth === 1 ? FONT_1 : FONT)
  function size(n) {
    const font = fontOf(n)
    n.lines = wrapText(n.text || (n.isRoot ? 'Untitled' : ' '), font, n.isRoot ? 260 : MAX_TEXT_W)
    const tw = Math.max(...n.lines.map((l) => textWidth(l, font)))
    let w = Math.max(n.isRoot ? 110 : 44, tw + PAD_X * 2)
    let h = n.lines.length * LINE_H + PAD_Y * 2 + (n.isRoot ? 8 : 0)
    if (n.image) {
      w = Math.max(w, IMG_W + 12)
      h += IMG_H + 6
    }
    return { w: Math.ceil(w), h: Math.ceil(h) }
  }

  // ---- drawing ----
  function render() {
    if (editor) return // keep the field under the caret; redraws when the edit ends
    readColors()
    tree = mapTree(nodes, title.toString())
    laid = layoutMap(tree, size)
    if (sel && !tree.byId.get(sel)) sel = null
    if (selLink && !links.get(selLink)) selLink = null
    gTree.replaceChildren()
    gLinks.replaceChildren()
    gNodes.replaceChildren()
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of laid) {
      minX = Math.min(minX, n.x - n.w / 2)
      maxX = Math.max(maxX, n.x + n.w / 2)
      minY = Math.min(minY, n.y - n.h / 2)
      maxY = Math.max(maxY, n.y + n.h / 2)
    }
    // branches: smooth curves from parent to child, thicker near the centre
    for (const n of laid) {
      if (n.isRoot || !n.parent || n.hidden) continue
      const p = tree.byId.get(n.parent)
      if (!p || p.hidden || p.x == null) continue
      const dir = n.x >= p.x ? 1 : -1
      const x1 = p.x + (dir * p.w) / 2
      const x2 = n.x - (dir * n.w) / 2
      const y1 = p.y
      const y2 = n.y + (n.shape === 'line' ? n.h / 2 - 1 : 0)
      const mx = (x1 + x2) / 2
      const wdt = p.isRoot ? 4 : n.depth === 2 ? 2.6 : 1.8
      el('path', {
        d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
        stroke: n.color,
        'stroke-width': wdt,
        fill: 'none',
        'stroke-linecap': 'round',
        class: 'mm-branch',
      }, gTree)
    }
    // cross-links
    links.forEach((m, id) => {
      const a = tree.byId.get(m.get('from'))
      const b = tree.byId.get(m.get('to'))
      if (!a || !b || a.x == null || b.x == null || a.hidden || b.hidden) return
      const d = linkPath(a, b)
      const g = el('g', { class: 'mm-link' + (id === selLink ? ' sel' : ''), 'data-link': id }, gLinks)
      el('path', { d: d.path, class: 'mm-link-hit' }, g)
      el('path', { d: d.path, class: 'mm-link-line', stroke: colors.dim, 'marker-end': 'url(#mm-arrow)' }, g)
      const label = m.get('label')
      if (label) {
        const tw = textWidth(label, FONT) + 12
        el('rect', { x: d.mx - tw / 2, y: d.my - 11, width: tw, height: 22, rx: 11, fill: colors.paper, stroke: colors.dim, 'stroke-width': 1 }, g)
        const t = el('text', { x: d.mx, y: d.my + 1, 'text-anchor': 'middle', 'dominant-baseline': 'middle', fill: colors.ink, style: 'font:' + FONT }, g)
        t.textContent = label
      }
    })
    for (const n of laid) drawNode(n)
    if (!tree.root.children.length && !tree.loose.length) {
      const t = el('text', { x: 0, y: tree.root.h / 2 + 34, 'text-anchor': 'middle', class: 'mm-empty' }, gNodes)
      t.textContent = phone() ? 'Tap + to add your first idea' : 'Press Tab to add your first idea'
      maxY += 50
    }
    bounds = { x: minX - 40, y: minY - 40, w: maxX - minX + 80, h: maxY - minY + 80 }
    if (fitted) fit(true)
    else applyView()
    positionBar()
  }

  function linkPath(a, b) {
    // from edge to edge, bowed to one side so it doesn't sit on the branches
    const ang = Math.atan2(b.y - a.y, b.x - a.x)
    const edge = (n, t) => {
      const dx = Math.cos(t), dy = Math.sin(t)
      const s = Math.min(n.w / 2 / Math.abs(dx || 1e-6), n.h / 2 / Math.abs(dy || 1e-6))
      return [n.x + dx * s, n.y + dy * s]
    }
    const [x1, y1] = edge(a, ang)
    const [x2, y2] = edge(b, ang + Math.PI)
    const len = Math.hypot(x2 - x1, y2 - y1)
    const bow = Math.min(80, len * 0.25)
    const cx = (x1 + x2) / 2 - Math.sin(ang) * bow
    const cy = (y1 + y2) / 2 + Math.cos(ang) * bow
    return { path: `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`, mx: (x1 + 2 * cx + x2) / 4, my: (y1 + 2 * cy + y2) / 4 }
  }

  function drawNode(n) {
    const g = el('g', {
      class: 'mm-node' + (n.isRoot ? ' mm-root' : '') + (n.id === sel ? ' sel' : '') + (n.pinned ? ' pinned' : '') + (n.folded ? ' folded' : ''),
      transform: `translate(${n.x},${n.y})`,
      'data-id': n.id,
    }, gNodes)
    const { w, h } = n
    const color = isHex(n.color) ? n.color : '#8e8e93'
    let fill, ink, stroke, sw
    if (n.isRoot) {
      fill = isHex(n.color) && n.color !== '#8e8e93' && n.color ? n.color : colors.root
      ink = colors.rootInk
      stroke = 'none'
      sw = 0
    } else if (n.depth === 1 && n.parent) {
      fill = color
      ink = '#ffffff'
      stroke = 'none'
      sw = 0
    } else {
      fill = mix(colors.paper, color, 0.12)
      ink = colors.ink
      stroke = color
      sw = 1.5
    }
    const rx = n.isRoot || n.shape === 'pill' ? h / 2 : n.shape === 'box' ? 3 : 10
    if (n.id === sel) el('rect', { x: -w / 2 - 4, y: -h / 2 - 4, width: w + 8, height: h + 8, rx: rx + 4, class: 'mm-ring', stroke: colors.focus }, g)
    if (n.shape === 'line' && !n.isRoot) {
      el('rect', { x: -w / 2, y: -h / 2, width: w, height: h, fill: 'transparent' }, g)
      el('path', { d: `M${-w / 2},${h / 2 - 1} H${w / 2}`, stroke: color, 'stroke-width': 2.5, 'stroke-linecap': 'round' }, g)
      ink = colors.ink
    } else {
      el('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx, fill, stroke, 'stroke-width': sw, class: 'mm-box' }, g)
    }
    let top = -h / 2 + PAD_Y + (n.isRoot ? 4 : 0)
    if (n.image) {
      const img = el('image', { href: n.image, x: -IMG_W / 2, y: -h / 2 + 6, width: IMG_W, height: IMG_H, preserveAspectRatio: 'xMidYMid meet', class: 'mm-img' }, g)
      img.dataset.src = n.image
      top += IMG_H + 6
    }
    const t = el('text', { 'text-anchor': 'middle', fill: ink, style: 'font:' + fontOf(n) }, g)
    n.lines.forEach((line, i) => {
      const s = el('tspan', { x: 0, y: top + i * LINE_H + LINE_H * 0.72 }, t)
      s.textContent = line
    })
    if (n.note) {
      const m = el('g', { class: 'mm-mark', transform: `translate(${w / 2 - 2},${-h / 2 + 2})` }, g)
      el('circle', { r: 7, fill: colors.paper, stroke: color, 'stroke-width': 1.5 }, m)
      el('path', { d: 'M-3,-2 H3 M-3,1 H3 M-3,4 H1', stroke: color, 'stroke-width': 1.2, 'stroke-linecap': 'round' }, m)
      const tip = el('title', {}, m)
      tip.textContent = n.note
    }
    if (n.folded && n.children.length) {
      const side = n.side || 1
      const count = branchIds(n).length - 1
      const b = el('g', { class: 'mm-fold', transform: `translate(${side * (w / 2 + 14)},0)` }, g)
      el('circle', { r: 11, fill: colors.paper, stroke: color, 'stroke-width': 1.5 }, b)
      const bt = el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'middle', y: 1, fill: color, style: 'font:600 10px ' + FONT_FAMILY }, b)
      bt.textContent = '+' + count
    }
  }

  function applyView() {
    scene.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`)
    // the dotted paper moves with the map
    const s = 22 * view.k
    wrap.style.backgroundSize = `${s}px ${s}px`
    wrap.style.backgroundPosition = `${view.x}px ${view.y}px`
    positionBar()
  }
  function fit(keep) {
    const W = wrap.clientWidth || host.clientWidth || 300
    const H = wrap.clientHeight || host.clientHeight || 200
    const k = Math.min(1.4, Math.max(0.15, Math.min(W / bounds.w, H / bounds.h)))
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
  const toMap = (cx, cy) => {
    const r = wrap.getBoundingClientRect()
    return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k }
  }
  const toScreen = (x, y) => ({ x: view.x + x * view.k, y: view.y + y * view.k })
  // keep a bubble in view (after adding one off-screen)
  function reveal(id) {
    const n = tree?.byId.get(id)
    if (!n || n.x == null) return
    const s = toScreen(n.x, n.y)
    const W = wrap.clientWidth, H = wrap.clientHeight
    const m = 60
    let dx = 0, dy = 0
    if (s.x < m) dx = m - s.x
    if (s.x > W - m) dx = W - m - s.x
    if (s.y < m) dy = m - s.y
    if (s.y > H - m - 50) dy = H - m - 50 - s.y
    if (dx || dy) {
      view.x += dx
      view.y += dy
      fitted = false
      applyView()
    }
  }

  // ---- data helpers ----
  const nodeMap = (id) => nodes.get(id)
  function childOrders(parent) {
    const out = []
    nodes.forEach((m) => {
      if ((m.get('parent') || null) === parent) out.push(Number(m.get('order')) || 0)
    })
    return out.sort((a, b) => a - b)
  }
  function addNode(parent, { after, x, y, text = '' } = {}) {
    const id = genId()
    let order
    const os = childOrders(parent)
    if (after) {
      const a = Number(nodeMap(after)?.get('order')) || 0
      const next = os.find((o) => o > a)
      order = next == null ? a + 1 : (a + next) / 2
    } else order = os.length ? os[os.length - 1] + 1 : 1
    tx(() => {
      const m = new Y.Map()
      m.set('text', text)
      m.set('order', order)
      if (parent) m.set('parent', parent)
      if (x != null) {
        m.set('x', Math.round(x))
        m.set('y', Math.round(y))
      }
      nodes.set(id, m)
      if (parent && parent !== ROOT && nodeMap(parent)?.get('folded')) nodeMap(parent).delete('folded')
    })
    return id
  }
  function addAndEdit(parent, extra) {
    const id = addNode(parent, extra)
    select(id)
    reveal(id)
    startEdit(id)
  }
  function removeBranch(id) {
    if (!id || id === ROOT) return
    const n = tree.byId.get(id)
    if (!n) return
    const ids = branchIds(n)
    const snap = ids.filter((i) => nodes.get(i)).map((i) => [i, nodes.get(i).toJSON()])
    const linkSnap = []
    links.forEach((m, lid) => {
      if (ids.includes(m.get('from')) || ids.includes(m.get('to'))) linkSnap.push([lid, m.toJSON()])
    })
    const parent = n.parent
    tx(() => {
      ids.forEach((i) => nodes.delete(i))
      linkSnap.forEach(([lid]) => links.delete(lid))
    })
    sel = parent && tree.byId.get(parent) ? parent : ROOT
    render()
    const label = n.text || 'Idea'
    ui.toast(`"${label.slice(0, 30)}" deleted` + (ids.length > 1 ? ` with ${ids.length - 1} more` : ''), {
      action: 'Undo',
      ms: 7000,
      onAction: () =>
        tx(() => {
          const put = (map, [k, data]) => {
            if (map.get(k)) return
            const m = new Y.Map()
            for (const [a, v] of Object.entries(data)) m.set(a, v)
            map.set(k, m)
          }
          snap.forEach((e) => put(nodes, e))
          linkSnap.forEach((e) => put(links, e))
        }),
    })
  }
  function setField(id, k, v) {
    if (id === ROOT) return
    const m = nodeMap(id)
    if (!m) return
    tx(() => (v == null || v === '' || v === false ? m.delete(k) : m.set(k, v)))
  }
  function reparent(id, target) {
    const m = nodeMap(id)
    if (!m || id === target) return
    const os = childOrders(target)
    tx(() => {
      m.set('parent', target)
      m.set('order', os.length ? os[os.length - 1] + 1 : 1)
      m.delete('x')
      m.delete('y')
      if (target !== ROOT && nodeMap(target)?.get('folded')) nodeMap(target).delete('folded')
    })
  }
  function addLink(from, to) {
    if (!from || !to || from === to) return
    let exists = false
    links.forEach((m) => {
      if ((m.get('from') === from && m.get('to') === to) || (m.get('from') === to && m.get('to') === from)) exists = true
    })
    if (exists) return
    const id = genId()
    tx(() => {
      const m = new Y.Map()
      m.set('from', from)
      m.set('to', to)
      links.set(id, m)
    })
    selLink = id
    sel = null
    render()
  }
  function tidy() {
    const pinned = []
    nodes.forEach((m, id) => m.get('x') != null && pinned.push(id))
    if (!pinned.length) return ui.toast('Already tidy')
    tx(() =>
      pinned.forEach((id) => {
        nodeMap(id).delete('x')
        nodeMap(id).delete('y')
      })
    )
    fitted = true
    ui.toast(pinned.length + (pinned.length === 1 ? ' bubble' : ' bubbles') + ' put back in the tree', { action: 'Undo', onAction: () => undo.undo() })
  }

  // ---- selection and the bubble toolbar ----
  function select(id) {
    sel = id
    selLink = null
    render()
  }

  function positionBar() {
    if (editor || drag?.moved || (!sel && !selLink)) {
      bar.hidden = true
      return
    }
    buildBar()
    bar.hidden = false
    if (phone()) return // docked at the bottom by CSS
    let x, y
    if (sel) {
      const n = tree?.byId.get(sel)
      if (!n || n.x == null) return (bar.hidden = true)
      const s = toScreen(n.x, n.y - n.h / 2)
      x = s.x
      y = s.y - 12
    } else {
      const m = links.get(selLink)
      const a = tree?.byId.get(m?.get('from'))
      const b = tree?.byId.get(m?.get('to'))
      if (!a || !b) return (bar.hidden = true)
      const d = linkPath(a, b)
      const s = toScreen(d.mx, d.my)
      x = s.x
      y = s.y - 14
    }
    const bw = bar.offsetWidth
    x = Math.max(bw / 2 + 6, Math.min(wrap.clientWidth - bw / 2 - 6, x))
    bar.style.left = x + 'px'
    bar.style.top = Math.max(bar.offsetHeight + 6, y) + 'px'
  }

  let barFor = null
  function buildBar() {
    const key = (sel || 'L:' + selLink) + '|' + (sel ? JSON.stringify(nodeMap(sel)?.toJSON() || {}) : JSON.stringify(links.get(selLink)?.toJSON() || {})) + '|' + (linkFrom || '')
    if (barFor === key) return
    barFor = key
    bar.replaceChildren()
    const btn = (iconName, tip, fn, cls) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'mm-bar-btn' + (cls ? ' ' + cls : '')
      if (iconName.length <= 2 && !/^[a-z]/.test(iconName)) b.textContent = iconName
      else b.appendChild(icon(iconName))
      b.title = tip
      b.setAttribute('aria-label', tip)
      b.addEventListener('click', () => fn(b))
      bar.appendChild(b)
      return b
    }
    if (selLink) {
      btn('pencil', 'Label this link', async () => {
        const m = links.get(selLink)
        const v = await ui.prompt('Link label:', m?.get('label') || '', { title: 'Link', maxLength: 40 })
        if (v == null || !links.get(selLink)) return
        tx(() => (v.trim() ? m.set('label', v.trim()) : m.delete('label')))
      })
      btn('trash', 'Delete this link', () => {
        const id = selLink
        tx(() => links.delete(id))
        selLink = null
        render()
      }, 'danger')
      return
    }
    const n = tree?.byId.get(sel)
    if (!n) return
    if (!n.isRoot) {
      const sw = btn('palette', 'Colour', (b) => colourMenu(b, n))
      sw.style.color = isHex(n.color) ? n.color : ''
      btn('square', 'Shape', (b) =>
        ui.menu(b, [
          { label: 'Rounded', on: n.shape === 'rounded', onClick: () => setField(n.id, 'shape', null) },
          { label: 'Pill', on: n.shape === 'pill', onClick: () => setField(n.id, 'shape', 'pill') },
          { label: 'Box', on: n.shape === 'box', onClick: () => setField(n.id, 'shape', 'box') },
          { label: 'Underlined text', on: n.shape === 'line', onClick: () => setField(n.id, 'shape', 'line') },
        ])
      )
      btn('note', n.note ? 'Edit note' : 'Add a note', (b) => noteEditor(b, n), n.note ? 'on' : '')
    }
    btn('image', n.image ? 'Change or remove picture' : 'Add a picture (or paste one)', (b) => {
      if (n.image && !n.isRoot)
        ui.menu(b, [
          { label: 'Replace picture…', icon: 'image', onClick: () => pickPicture(n.id) },
          { label: 'Remove picture', icon: 'trash', onClick: () => setField(n.id, 'image', null) },
        ])
      else if (!n.isRoot) pickPicture(n.id)
      else ui.toast('Pictures go on the ideas around the centre')
    })
    btn('arrow', linkFrom ? 'Click a bubble to link to… (Esc cancels)' : 'Link to another bubble', () => {
      linkFrom = linkFrom ? null : n.id
      wrap.classList.toggle('linking', !!linkFrom)
      barFor = null
      positionBar()
    }, linkFrom ? 'on' : '')
    if (opts.sendToTodo) btn('todo', 'Send to a To-do tab', (b) => sendMenu(b, n))
    if (!n.isRoot && n.children.length) btn(n.folded ? 'down' : 'right', n.folded ? 'Unfold branch (Space)' : 'Fold branch (Space)', () => setField(n.id, 'folded', !n.folded))
    if (n.pinned) btn('pin', 'Unpin: put it back in the tree', () => tx(() => {
      const m = nodeMap(n.id)
      m.delete('x')
      m.delete('y')
    }))
    if (!n.isRoot) btn('trash', 'Delete (Delete key)', () => removeBranch(n.id), 'danger')
  }

  function colourMenu(anchor, n) {
    const m = document.createElement('div')
    m.className = 'menu mm-swatches'
    m.addEventListener('click', (e) => e.stopPropagation())
    const add = (c, label) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'mm-swatch' + (c ? '' : ' auto')
      if (c) b.style.background = c
      b.title = label
      b.setAttribute('aria-label', label)
      b.setAttribute('aria-pressed', String((nodeMap(n.id)?.get('color') || null) === c))
      b.addEventListener('click', () => {
        setField(n.id, 'color', c)
        dismiss()
      })
      m.appendChild(b)
    }
    add(null, 'Automatic (branch colour)')
    BRANCH.forEach((c, i) => add(c, 'Colour ' + (i + 1)))
    document.body.appendChild(m)
    const dismiss = closeOutside(m, ui.popover(m, anchor, { label: 'Bubble colour' }))
  }
  // our popovers also close on a press anywhere outside them
  function closeOutside(box, close) {
    const away = (e) => {
      if (!box.contains(e.target)) done()
    }
    const done = () => {
      document.removeEventListener('pointerdown', away, true)
      close()
    }
    setTimeout(() => document.addEventListener('pointerdown', away, true), 0)
    return done
  }

  function noteEditor(anchor, n) {
    const box = document.createElement('div')
    box.className = 'menu mm-note'
    box.addEventListener('click', (e) => e.stopPropagation())
    const ta = document.createElement('textarea')
    ta.className = 'mm-note-text'
    ta.placeholder = 'A note on "' + (n.text || 'this idea') + '"…'
    ta.value = nodeMap(n.id)?.get('note') || ''
    ta.rows = 5
    ta.maxLength = 2000
    box.appendChild(ta)
    document.body.appendChild(box)
    // saved as you type (one undo step per pause)
    ta.addEventListener('input', () => setField(n.id, 'note', ta.value.trim() || null))
    const close = closeOutside(box, ui.popover(box, anchor, { label: 'Note', onClose: () => wrap.focus({ preventScroll: true }) }))
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) close()
    })
    setTimeout(() => ta.focus(), 0)
  }

  async function pickPicture(id, files) {
    const list = files || (await pickImages())
    if (!list.length) return
    const urls = await uploadImages(list.slice(0, 1))
    if (urls[0]) setField(id, 'image', urls[0])
  }

  function sendMenu(anchor, n) {
    const tabs = (opts.todoTabs && opts.todoTabs()) || []
    const tasks = branchToTasks(n)
    const items = tabs.map((t) => ({ label: t.name, icon: 'todo', onClick: () => opts.sendToTodo(t.id, tasks) }))
    if (items.length) items.push('sep')
    items.push({ label: 'New To-do tab…', icon: 'plus', onClick: () => opts.sendToTodo(null, tasks) })
    ui.menu(anchor, [{ head: 'Send "' + (n.text || 'idea').slice(0, 24) + '" to' }, ...items])
  }

  // ---- editing text ----
  function startEdit(id, { replaceWith } = {}) {
    finishEdit(true)
    const n = tree?.byId.get(id)
    if (!n || n.x == null) return
    sel = id
    bar.hidden = true
    const s = toScreen(n.x, n.y)
    const inp = document.createElement('textarea')
    inp.className = 'mm-input'
    inp.rows = 1
    inp.value = replaceWith != null ? replaceWith : n.isRoot ? title.toString() : n.text
    inp.maxLength = 300
    inp.setAttribute('aria-label', n.isRoot ? 'Centre idea' : 'Idea')
    const w = Math.max(160, Math.min(320, n.w * view.k + 40))
    inp.style.width = w + 'px'
    inp.style.left = s.x - w / 2 + 'px'
    inp.style.top = s.y - 18 + 'px'
    inp.style.font = fontOf(n)
    wrap.appendChild(inp)
    editor = { id, inp }
    inp.focus()
    // the caret goes at the end (selecting it all made a stray key wipe the idea)
    inp.setSelectionRange(inp.value.length, inp.value.length)
    const grow = () => {
      inp.style.height = 'auto'
      inp.style.height = inp.scrollHeight + 'px'
    }
    grow()
    inp.addEventListener('input', grow)
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        finishEdit(false)
        wrap.focus()
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        finishEdit(true)
        afterEnter = true
        wrap.focus()
      } else if (e.key === 'Tab') {
        e.preventDefault()
        finishEdit(true)
        wrap.focus()
        if (e.shiftKey) {
          const p = tree.byId.get(id)?.parent
          if (p) addAndEdit(tree.byId.get(p)?.parent || ROOT, { after: p })
        } else addAndEdit(id)
      }
    })
    inp.addEventListener('blur', () => setTimeout(() => editor && editor.inp === inp && finishEdit(true), 0))
  }
  function finishEdit(save) {
    if (!editor) return
    const { id, inp } = editor
    editor = null
    inp.remove()
    if (save) {
      const v = inp.value.replace(/\s*\n\s*/g, ' ').trim()
      if (id === ROOT) {
        if (v !== title.toString())
          tx(() => {
            if (title.length) title.delete(0, title.length)
            if (v) title.insert(0, v)
          })
      } else {
        const m = nodeMap(id)
        // a brand-new bubble left empty just goes away
        if (m && !v && !m.get('text') && !m.get('image') && !m.get('note')) {
          tx(() => nodes.delete(id))
          sel = tree.byId.get(id)?.parent || ROOT
        } else if (m && v !== m.get('text')) tx(() => m.set('text', v))
      }
    }
    render()
  }

  // ---- keyboard ----
  function neighbour(dir) {
    const n = tree.byId.get(sel)
    if (!n) return ROOT
    if (dir === 'left' || dir === 'right') {
      const want = dir === 'right' ? 1 : -1
      if (n.isRoot) {
        const kids = n.children.filter((c) => c.side === want && !c.hidden)
        return kids.length ? kids[Math.floor(kids.length / 2)].id : sel
      }
      if ((n.side || 1) === want) {
        const kids = n.folded ? [] : n.children
        return kids.length ? kids[Math.floor(kids.length / 2)].id : sel
      }
      return n.parent || sel
    }
    // up / down: the closest visible bubble above / below on the same side
    const cands = laid.filter((m) => m !== n && (dir === 'up' ? m.y < n.y - 1 : m.y > n.y + 1))
    let best = null, bd = Infinity
    for (const m of cands) {
      const d = Math.abs(m.y - n.y) + Math.abs(m.x - n.x) * 0.6 + (m.depth !== n.depth ? 40 : 0)
      if (d < bd) {
        bd = d
        best = m
      }
    }
    return best ? best.id : sel
  }

  wrap.addEventListener('keydown', (e) => {
    if (editor || e.target !== wrap) return
    const mod = e.metaKey || e.ctrlKey
    const enterAgain = afterEnter
    afterEnter = false
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) undo.redo()
      else undo.undo()
      return
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      undo.redo()
      return
    }
    if (e.key === 'Escape') {
      if (linkFrom) {
        linkFrom = null
        wrap.classList.remove('linking')
      } else {
        sel = null
        selLink = null
      }
      barFor = null
      render()
      return
    }
    if (selLink && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault()
      const id = selLink
      tx(() => links.delete(id))
      selLink = null
      render()
      return
    }
    if (!sel) {
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        sel = ROOT
        render()
      }
      return
    }
    const n = tree.byId.get(sel)
    if (e.key === 'Tab') {
      e.preventDefault()
      addAndEdit(sel)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (enterAgain && !n.isRoot) addAndEdit(n.parent || null, { after: sel, ...(n.parent ? {} : { x: n.x, y: n.y + n.h + 24 }) })
      else if (enterAgain && n.isRoot) addAndEdit(ROOT)
      else startEdit(sel)
    } else if (e.key === 'F2') {
      e.preventDefault()
      startEdit(sel)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      removeBranch(sel)
    } else if (e.key === ' ') {
      e.preventDefault()
      if (!n.isRoot && n.children.length) setField(sel, 'folded', !n.folded)
    } else if (e.key.startsWith('Arrow')) {
      e.preventDefault()
      sel = neighbour(e.key.slice(5).toLowerCase())
      render()
      reveal(sel)
    } else if (e.key.length === 1 && !mod && !e.altKey) {
      e.preventDefault()
      startEdit(sel, { replaceWith: e.key })
    }
  })

  // pictures pasted while a bubble is selected
  const onPaste = (e) => {
    if (editor || !sel || sel === ROOT || !wrap.contains(document.activeElement)) return
    const files = Array.from(e.clipboardData?.files || []).filter((f) => /^image\//.test(f.type))
    if (!files.length) return
    e.preventDefault()
    pickPicture(sel, files)
  }
  document.addEventListener('paste', onPaste)

  // ---- pointer: select, drag, link, pan, pinch ----
  let drag = null
  const pointers = new Map()
  let pinch = null
  const nodeIdAt = (target) => target?.closest?.('.mm-node')?.dataset.id || null
  const linkIdAt = (target) => target?.closest?.('.mm-link')?.dataset.link || null

  svg.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button > 0 && e.pointerType === 'mouse') return
    wrap.focus({ preventScroll: true })
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.size === 2) {
      // two fingers: pinch to zoom
      const [a, b] = [...pointers.values()]
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k }
      if (drag?.timer) clearTimeout(drag.timer)
      drag = null
      return
    }
    const img = e.target.closest?.('.mm-img')
    const id = nodeIdAt(e.target)
    const lid = id ? null : linkIdAt(e.target)
    drag = { id, lid, img, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false, pid: e.pointerId, mode: null, alt: e.altKey, touch: e.pointerType === 'touch' }
    // on touch, a bubble drags after a short hold (a quick swipe pans)
    if (id && drag.touch) drag.timer = setTimeout(() => drag && !drag.moved && (drag.held = true, navigator.vibrate?.(10)), 350)
    try {
      svg.setPointerCapture(e.pointerId)
    } catch {
      /* not capturable */
    }
  })
  svg.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const r = wrap.getBoundingClientRect()
      zoomBy((pinch.k * d) / pinch.d / view.k, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top)
      return
    }
    if (!drag || e.pointerId !== drag.pid) return
    const dx = e.clientX - drag.sx
    const dy = e.clientY - drag.sy
    if (!drag.moved && Math.hypot(dx, dy) < 5) return
    if (!drag.moved) {
      drag.moved = true
      clearTimeout(drag.timer)
      if (drag.id && (drag.alt || linkFrom)) drag.mode = 'link'
      else if (drag.id && drag.id !== ROOT && (!drag.touch || drag.held)) drag.mode = 'move'
      else drag.mode = 'pan'
      bar.hidden = true
    }
    if (drag.mode === 'pan') {
      view.x = drag.vx + dx
      view.y = drag.vy + dy
      fitted = false
      applyView()
      return
    }
    const over = nodeIdAt(document.elementFromPoint(e.clientX, e.clientY))
    gNodes.querySelectorAll('.mm-drop').forEach((g) => g.classList.remove('mm-drop'))
    if (drag.mode === 'link') {
      const a = tree.byId.get(drag.id)
      const p = toMap(e.clientX, e.clientY)
      gTemp.replaceChildren()
      el('path', { d: `M${a.x},${a.y} L${p.x},${p.y}`, class: 'mm-link-line temp', stroke: colors.focus, 'marker-end': 'url(#mm-arrow)' }, gTemp)
      if (over && over !== drag.id) gNodes.querySelector(`.mm-node[data-id="${over}"]`)?.classList.add('mm-drop')
      drag.over = over
      return
    }
    // move: the bubble follows the pointer; a bubble under it is the drop target
    const g = gNodes.querySelector(`.mm-node[data-id="${drag.id}"]`)
    const n = tree.byId.get(drag.id)
    if (g && n) {
      g.setAttribute('transform', `translate(${n.x + dx / view.k},${n.y + dy / view.k})`)
      g.classList.add('dragging')
      gNodes.appendChild(g)
    }
    const inside = over && branchIds(n).includes(over)
    drag.over = over && !inside ? over : null
    if (drag.over) gNodes.querySelector(`.mm-node[data-id="${drag.over}"]`)?.classList.add('mm-drop')
  })
  const up = (e) => {
    pointers.delete(e.pointerId)
    if (pinch) {
      if (pointers.size < 2) pinch = null
      return
    }
    if (!drag || e.pointerId !== drag.pid) return
    const d = drag
    drag = null
    clearTimeout(d.timer)
    gTemp.replaceChildren()
    gNodes.querySelectorAll('.mm-drop').forEach((g) => g.classList.remove('mm-drop'))
    if (e.type !== 'pointerup') return render()
    if (!d.moved) return tap(d, e)
    if (d.mode === 'link') {
      if (d.over) addLink(d.id, d.over)
      linkFrom = null
      wrap.classList.remove('linking')
      return render()
    }
    if (d.mode === 'move') {
      const n = tree.byId.get(d.id)
      if (d.over) reparent(d.id, d.over)
      else if (n) {
        // dropped on empty space: pinned where it landed
        const dx = (e.clientX - d.sx) / view.k
        const dy = (e.clientY - d.sy) / view.k
        tx(() => {
          const m = nodeMap(d.id)
          m.set('x', Math.round(n.x + dx))
          m.set('y', Math.round(n.y + dy))
        })
      }
      sel = d.id
      return render()
    }
    positionBar()
  }
  svg.addEventListener('pointerup', up)
  svg.addEventListener('pointercancel', up)

  let lastTap = { id: null, at: 0 }
  function tap(d, e) {
    if (linkFrom && d.id) {
      const from = linkFrom
      linkFrom = null
      wrap.classList.remove('linking')
      if (d.id !== from) return addLink(from, d.id)
      return render()
    }
    if (d.img && d.id === sel) return openLightbox(d.img.dataset.src)
    if (d.lid) {
      selLink = d.lid
      sel = null
      barFor = null
      return render()
    }
    const now = Date.now()
    const again = lastTap.id === d.id && now - lastTap.at < 400
    lastTap = { id: d.id, at: now }
    if (d.id) {
      // a second tap on the selected bubble edits it
      if (sel === d.id && (again || phone() || d.touch)) return startEdit(d.id)
      sel = d.id
      selLink = null
      barFor = null
      return render()
    }
    // empty space: a double-click drops a loose idea there
    if (again) {
      const p = toMap(e.clientX, e.clientY)
      return addAndEdit(null, { x: p.x, y: p.y })
    }
    sel = null
    selLink = null
    render()
  }
  svg.addEventListener('dblclick', (e) => {
    const id = nodeIdAt(e.target)
    if (id) {
      e.preventDefault()
      startEdit(id)
    }
  })
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const r = wrap.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top)
      else {
        // two-finger scroll pans
        view.x -= e.deltaX
        view.y -= e.deltaY
        fitted = false
        applyView()
      }
    },
    { passive: false }
  )

  // ---- export ----
  function svgString() {
    const clone = svg.cloneNode(true)
    clone.setAttribute('xmlns', NS)
    clone.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`)
    clone.setAttribute('width', String(Math.round(bounds.w)))
    clone.setAttribute('height', String(Math.round(bounds.h)))
    clone.querySelector('.mm-scene').removeAttribute('transform')
    clone.querySelectorAll('.mm-ring, .mm-temp, .mm-link-hit').forEach((n) => n.remove())
    const style = document.createElementNS(NS, 'style')
    style.textContent = `text{font-family:${FONT_FAMILY}} .mm-link-line{fill:none;stroke-width:1.6;stroke-dasharray:6 5}`
    clone.insertBefore(style, clone.firstChild)
    const bg = el('rect', { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h, fill: colors.paper })
    clone.insertBefore(bg, clone.querySelector('.mm-scene'))
    return new XMLSerializer().serializeToString(clone)
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

  // ---- live ----
  let raf = 0
  const schedule = () => {
    barFor = null
    if (!raf) raf = requestAnimationFrame(() => ((raf = 0), render()))
  }
  nodes.observeDeep(schedule)
  links.observeDeep(schedule)
  title.observe(schedule)
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => (fitted ? fit(true) : positionBar())) : null
  if (ro) ro.observe(wrap)
  const theme = () => schedule()
  window.addEventListener('notes-theme-change', theme)
  render()

  return {
    el: wrap,
    fit,
    exportSvg,
    exportPng,
    addChild() {
      addAndEdit(sel && tree.byId.get(sel) ? sel : ROOT)
    },
    destroy() {
      cancelAnimationFrame(raf)
      nodes.unobserveDeep(schedule)
      links.unobserveDeep(schedule)
      title.unobserve(schedule)
      document.removeEventListener('paste', onPaste)
      window.removeEventListener('notes-theme-change', theme)
      undo.destroy()
      if (ro) ro.disconnect()
      if (editor) editor.inp.remove()
      wrap.remove()
    },
  }
}
