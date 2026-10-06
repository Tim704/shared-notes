// Arrows between notes ("connectors"), the freeform half of mind mapping.
// Stored in doc.getArray('edges') as Y.Map { id, from, to, label, color, style, head }
// and drawn as one SVG layer under the cards: smooth cubic curves leaving the
// facing sides of the two notes, with real arrowheads, re-routed live as notes
// move. Drag from the small dot on a note's right edge to another note to make
// one; click an arrow to label, recolour, restyle or delete it.

const NS = 'http://www.w3.org/2000/svg'
export const EDGE_COLORS = ['#c9ced6', '#ffd23f', '#ff8787', '#4dabf7', '#69db7c', '#da77f2']
const HEAD = 11

const mk = (tag, attrs, parent) => {
  const n = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v)
  if (parent) parent.appendChild(n)
  return n
}
const getter = (e) => (e && typeof e.get === 'function' ? (k) => e.get(k) : (k) => e && e[k])

/**
 * createEdges({ doc, getCard, toPlane, scale, genId, Y, ui })
 *   getCard(noteId) → { el } for notes drawn on the board right now (else null)
 *   toPlane(clientX, clientY) → { x, y } in the cards' coordinate space
 */
export function createEdges({ doc, getCard, toPlane, scale = () => 1, genId, Y, ui }) {
  const yEdges = doc.getArray('edges')
  const svg = mk('svg', { class: 'edges' })
  const gEdges = mk('g', {}, svg)
  const temp = mk('path', { class: 'edge-temp', d: '' }, svg)
  let selected = null
  let pop = null
  let enabled = true

  const rectOf = (el) => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight })

  // the facing sides of two boxes, with outward normals
  function anchors(a, b) {
    const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }
    const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
    const dx = cb.x - ca.x
    const dy = cb.y - ca.y
    if (Math.abs(dx) / (a.w + b.w) >= Math.abs(dy) / (a.h + b.h)) {
      const s = dx >= 0 ? 1 : -1
      return {
        p1: { x: ca.x + (s * a.w) / 2, y: ca.y },
        n1: { x: s, y: 0 },
        p2: { x: cb.x - (s * b.w) / 2, y: cb.y },
        n2: { x: -s, y: 0 },
      }
    }
    const s = dy >= 0 ? 1 : -1
    return {
      p1: { x: ca.x, y: ca.y + (s * a.h) / 2 },
      n1: { x: 0, y: s },
      p2: { x: cb.x, y: cb.y - (s * b.h) / 2 },
      n2: { x: 0, y: -s },
    }
  }

  function curve(p1, n1, p2, n2) {
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y)
    const c = Math.max(28, Math.min(170, dist * 0.42))
    const c1 = { x: p1.x + n1.x * c, y: p1.y + n1.y * c }
    const c2 = { x: p2.x + n2.x * c, y: p2.y + n2.y * c }
    return { c1, c2 }
  }

  function arrowHead(tip, from, size) {
    const dx = tip.x - from.x
    const dy = tip.y - from.y
    const L = Math.hypot(dx, dy) || 1
    const ux = dx / L
    const uy = dy / L
    const bx = tip.x - ux * size
    const by = tip.y - uy * size
    const px = -uy * size * 0.5
    const py = ux * size * 0.5
    return `M${tip.x},${tip.y} L${bx + px},${by + py} L${bx - px},${by - py} Z`
  }

  const bez = (p1, c1, c2, p2, t) => {
    const u = 1 - t
    return {
      x: u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x,
      y: u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y,
    }
  }

  function render() {
    gEdges.replaceChildren()
    if (!enabled) return
    for (const e of yEdges.toArray()) {
      const get = getter(e)
      const id = get('id')
      const A = getCard(get('from'))
      const B = getCard(get('to'))
      if (!id || !A || !B || A === B) continue
      if (A.el.classList.contains('hidden') || B.el.classList.contains('hidden')) continue
      const { p1, n1, p2, n2 } = anchors(rectOf(A.el), rectOf(B.el))
      const head = get('head') || 'arrow'
      const color = get('color') || EDGE_COLORS[0]
      // pull the line ends back so the arrowheads' tips sit on the note edge
      const e2 = head !== 'none' ? { x: p2.x + n2.x * HEAD * 0.8, y: p2.y + n2.y * HEAD * 0.8 } : p2
      const e1 = head === 'both' ? { x: p1.x + n1.x * HEAD * 0.8, y: p1.y + n1.y * HEAD * 0.8 } : p1
      const { c1, c2 } = curve(e1, n1, e2, n2)
      const d = `M${e1.x},${e1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${e2.x},${e2.y}`
      const g = mk('g', { class: 'edge' + (selected === id ? ' sel' : ''), 'data-id': id }, gEdges)
      mk('path', { class: 'edge-hit', d }, g)
      mk(
        'path',
        {
          class: 'edge-line',
          d,
          stroke: color,
          'stroke-dasharray': get('style') === 'dashed' ? '7 6' : 'none',
        },
        g
      )
      if (head !== 'none') mk('path', { class: 'edge-head', d: arrowHead(p2, c2, HEAD), fill: color }, g)
      if (head === 'both') mk('path', { class: 'edge-head', d: arrowHead(p1, c1, HEAD), fill: color }, g)
      const mid = bez(e1, c1, c2, e2, 0.5)
      const label = String(get('label') || '')
      if (label) {
        const t = mk('text', { class: 'edge-label', x: mid.x, y: mid.y, 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, null)
        t.textContent = label
        const w = Math.min(220, label.length * 6.8 + 14)
        mk('rect', { class: 'edge-label-bg', x: mid.x - w / 2, y: mid.y - 10, width: w, height: 20, rx: 6 }, g)
        g.appendChild(t)
      }
      mk('circle', { class: 'edge-mid', cx: mid.x, cy: mid.y, r: 1 }, g)
    }
    if (pop && selected) positionPop()
  }

  let pending = false
  function schedule() {
    if (pending) return
    pending = true
    requestAnimationFrame(() => {
      pending = false
      render()
    })
  }

  // ---- making a new arrow -----------------------------------------------------------
  function startLink(fromId, ev) {
    const A = getCard(fromId)
    if (!A) return
    ev.preventDefault()
    ev.stopPropagation()
    deselect()
    let over = null
    const move = (e) => {
      const p = toPlane(e.clientX, e.clientY)
      const a = rectOf(A.el)
      const fake = { x: p.x - 1, y: p.y - 1, w: 2, h: 2 }
      const { p1, n1 } = anchors(a, fake)
      const c = Math.max(24, Math.min(120, Math.hypot(p.x - p1.x, p.y - p1.y) * 0.4))
      temp.setAttribute('d', `M${p1.x},${p1.y} C${p1.x + n1.x * c},${p1.y + n1.y * c} ${p.x},${p.y} ${p.x},${p.y}`)
      const hit = document.elementFromPoint(e.clientX, e.clientY)
      const card = hit && hit.closest ? hit.closest('.card') : null
      const id = card && card.dataset.id !== fromId && getCard(card.dataset.id) ? card.dataset.id : null
      if (over && over !== id) {
        const c0 = getCard(over)
        if (c0) c0.el.classList.remove('link-target')
      }
      over = id
      if (over) getCard(over).el.classList.add('link-target')
    }
    const up = (e) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      temp.setAttribute('d', '')
      if (over) {
        const c0 = getCard(over)
        if (c0) c0.el.classList.remove('link-target')
      }
      if (e.type === 'pointerup' && over) {
        const dup = yEdges.toArray().some((x) => getter(x)('from') === fromId && getter(x)('to') === over)
        if (dup) return
        const id = genId()
        doc.transact(() => {
          const m = new Y.Map()
          m.set('id', id)
          m.set('from', fromId)
          m.set('to', over)
          m.set('head', 'arrow')
          m.set('style', 'solid')
          yEdges.push([m])
        })
        select(id)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    move(ev)
  }

  // ---- selecting and editing an arrow -----------------------------------------------
  const find = (id) => {
    const arr = yEdges.toArray()
    const i = arr.findIndex((x) => getter(x)('id') === id)
    return i < 0 ? null : { i, e: arr[i] }
  }

  svg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest && e.target.closest('.edge')
    if (!g) return
    e.stopPropagation()
    e.preventDefault()
    select(g.dataset.id)
  })

  function select(id) {
    selected = id
    render()
    openPop()
  }
  function deselect() {
    if (!selected && !pop) return
    selected = null
    closePop()
    render()
  }

  function openPop() {
    closePop()
    const f = find(selected)
    if (!f) return
    const get = getter(f.e)
    pop = document.createElement('div')
    pop.className = 'edge-pop'
    pop.addEventListener('pointerdown', (e) => e.stopPropagation())
    pop.addEventListener('click', (e) => e.stopPropagation())
    const set = (k, v) => {
      const cur = find(selected)
      if (!cur || typeof cur.e.set !== 'function') return
      doc.transact(() => (v == null || v === '' ? cur.e.delete(k) : cur.e.set(k, v)))
    }
    const label = document.createElement('input')
    label.className = 'edge-input'
    label.placeholder = 'Label'
    label.maxLength = 60
    label.value = get('label') || ''
    label.addEventListener('input', () => set('label', label.value))
    label.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter' || e.key === 'Escape') deselect()
    })
    const sw = document.createElement('div')
    sw.className = 'edge-row'
    for (const c of EDGE_COLORS) {
      const b = document.createElement('button')
      b.className = 'edge-swatch' + ((get('color') || EDGE_COLORS[0]) === c ? ' on' : '')
      b.style.background = c
      b.title = c
      b.addEventListener('click', () => {
        set('color', c === EDGE_COLORS[0] ? null : c)
        openPop()
      })
      sw.appendChild(b)
    }
    const row = document.createElement('div')
    row.className = 'edge-row'
    const opt = (text, title, on, fn) => {
      const b = document.createElement('button')
      b.className = 'edge-btn' + (on ? ' on' : '')
      b.textContent = text
      b.title = title
      b.addEventListener('click', () => {
        fn()
        openPop()
      })
      row.appendChild(b)
    }
    const head = get('head') || 'arrow'
    opt('→', 'Arrow', head === 'arrow', () => set('head', 'arrow'))
    opt('↔', 'Both ends', head === 'both', () => set('head', 'both'))
    opt('—', 'No arrowhead', head === 'none', () => set('head', 'none'))
    opt('┄', 'Dashed', get('style') === 'dashed', () => set('style', get('style') === 'dashed' ? 'solid' : 'dashed'))
    opt('⇄', 'Swap direction', false, () => {
      const cur = find(selected)
      if (!cur) return
      const g2 = getter(cur.e)
      const from = g2('from')
      doc.transact(() => {
        cur.e.set('from', g2('to'))
        cur.e.set('to', from)
      })
    })
    const del = document.createElement('button')
    del.className = 'edge-btn danger'
    del.textContent = '🗑'
    del.title = 'Delete arrow (Del)'
    del.addEventListener('click', () => removeSelected())
    row.appendChild(del)
    pop.append(label, sw, row)
    document.body.appendChild(pop)
    positionPop()
  }

  function positionPop() {
    if (!pop) return
    const g = gEdges.querySelector(`.edge[data-id="${selected}"] .edge-mid`)
    if (!g) return closePop()
    const r = g.getBoundingClientRect()
    const w = pop.offsetWidth || 230
    pop.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, r.left - w / 2)) + 'px'
    pop.style.top = Math.min(window.innerHeight - pop.offsetHeight - 6, r.top + 14) + 'px'
  }
  function closePop() {
    if (pop) pop.remove()
    pop = null
  }

  function removeSelected() {
    const f = find(selected)
    if (!f) return
    const snap = typeof f.e.toJSON === 'function' ? f.e.toJSON() : { ...f.e }
    doc.transact(() => yEdges.delete(f.i, 1))
    deselect()
    if (ui)
      ui.toast('Arrow deleted', {
        action: 'Undo',
        onAction: () =>
          doc.transact(() => {
            const m = new Y.Map()
            for (const [k, v] of Object.entries(snap)) m.set(k, v)
            yEdges.push([m])
          }),
      })
  }

  /** Remove every arrow touching these notes (hard delete). */
  function removeFor(ids) {
    const set = new Set(ids)
    for (let i = yEdges.length - 1; i >= 0; i--) {
      const g = getter(yEdges.get(i))
      if (set.has(g('from')) || set.has(g('to'))) yEdges.delete(i, 1)
    }
  }

  document.addEventListener('pointerdown', (e) => {
    if (!selected) return
    if (pop && pop.contains(e.target)) return
    if (e.target.closest && e.target.closest('.edge')) return
    deselect()
  })
  window.addEventListener('keydown', (e) => {
    if (!selected) return
    const a = document.activeElement
    if (a && (a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      removeSelected()
    } else if (e.key === 'Escape') deselect()
  })
  window.addEventListener('scroll', () => pop && positionPop(), true)
  yEdges.observeDeep(() => {
    if (selected && !find(selected)) deselect()
    schedule()
  })

  return {
    el: svg,
    render,
    schedule,
    startLink,
    deselect,
    removeFor,
    setEnabled(on) {
      enabled = !!on
      if (!on) deselect()
      schedule()
    },
    scale,
  }
}
