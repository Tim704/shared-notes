// Free-hand ink on a sticky-note tab: little drawings and arrows in the space
// between the notes. Strokes live in the shared doc (drawings['ink:<tabId>'])
// in board/plane pixels, the same coordinates the notes use, so the layer sits
// inside the board (or the pan & zoom plane) and moves and scales with it.
//
// An SVG under the notes shows the ink; while "ink mode" is on, a transparent
// layer over the board takes the pointer. Pen strokes grow live for everyone;
// the eraser removes whole strokes. Undo / redo only touch this person's ink.
//
// createInk({ Y, toPlane, zoom, onChange }) →
//   { el, capture, bind(strokes|null), setEnabled, setActive, isActive,
//     setTool, getTool, undo, redo, bounds, schedule, destroy }
// strokes: Y.Array<Y.Map{ color, width, points: Y.Array<number> /* x,y,x,y… */ }>

const NS = 'http://www.w3.org/2000/svg'
const LOCAL = { ink: 'local' } // creating / erasing a stroke: one undo step each
const LIVE = { ink: 'live' } // the points of a stroke as it is drawn (not undo steps)
const MIN_STEP = 1.5 // px between recorded points, at zoom 1

export function createInk({ Y, toPlane, zoom, onChange }) {
  const el = document.createElementNS(NS, 'svg')
  el.setAttribute('class', 'ink')
  el.setAttribute('aria-hidden', 'true')
  const capture = document.createElement('div')
  capture.className = 'ink-capture'
  capture.hidden = true

  let strokes = null
  let undoMgr = null
  let enabled = true
  let active = false
  let tool = { mode: 'pen', color: '#1c1c1e', width: 3 }
  const paths = new Map() // Y.Map -> <path>

  function pathData(pts) {
    const n = pts.length >> 1
    if (!n) return ''
    if (n === 1) return `M${pts[0]},${pts[1]}l0.01,0`
    let d = `M${pts[0]},${pts[1]}`
    // quadratic curves through the midpoints: smooth without overshoot
    for (let i = 1; i < n - 1; i++) {
      const x = pts[i * 2], y = pts[i * 2 + 1]
      const mx = (x + pts[i * 2 + 2]) / 2, my = (y + pts[i * 2 + 3]) / 2
      d += `Q${x},${y} ${mx},${my}`
    }
    return d + `L${pts[(n - 1) * 2]},${pts[(n - 1) * 2 + 1]}`
  }

  function render() {
    const seen = new Set()
    if (strokes && enabled) {
      for (const s of strokes) {
        if (!(s instanceof Y.Map)) continue
        seen.add(s)
        let p = paths.get(s)
        if (!p) {
          p = document.createElementNS(NS, 'path')
          p.setAttribute('class', 'ink-stroke')
          paths.set(s, p)
        }
        p.setAttribute('d', pathData(s.get('points')?.toArray() || []))
        p.setAttribute('stroke', s.get('color') || '#1c1c1e')
        p.setAttribute('stroke-width', String(s.get('width') || 3))
        el.appendChild(p) // keeps document order = drawing order
      }
    }
    for (const [s, p] of paths) if (!seen.has(s)) { p.remove(); paths.delete(s) }
    onChange?.()
  }
  let raf = 0
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render() }) }

  function bind(next) {
    if (next === strokes) return
    finish()
    if (strokes) strokes.unobserveDeep(schedule)
    undoMgr?.destroy()
    strokes = next
    undoMgr = strokes ? new Y.UndoManager(strokes, { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 }) : null
    if (strokes) strokes.observeDeep(schedule)
    schedule()
  }

  // ---- drawing ----
  let cur = null // { map, points: Y.Array, last, pending: [] }
  let flushRaf = 0
  function flush() {
    flushRaf = 0
    if (!cur || !cur.pending.length) return
    const pts = cur.pending.splice(0)
    cur.map.doc.transact(() => cur.points.push(pts), LIVE)
  }
  function finish() {
    if (!cur) return
    if (flushRaf) cancelAnimationFrame(flushRaf)
    flush()
    cur = null
  }

  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay
    const len = dx * dx + dy * dy
    const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
  }
  function eraseAt(p) {
    if (!strokes) return
    const slack = 6 / zoom()
    const hits = []
    strokes.forEach((s, i) => {
      if (!(s instanceof Y.Map)) return
      const pts = s.get('points')?.toArray() || []
      const r = (s.get('width') || 3) / 2 + slack
      for (let k = 0; k + 1 < pts.length; k += 2) {
        const bx = pts[k + 2] ?? pts[k], by = pts[k + 3] ?? pts[k + 1]
        if (distToSeg(p.x, p.y, pts[k], pts[k + 1], bx, by) <= r) { hits.push(i); break }
      }
    })
    if (!hits.length) return
    strokes.doc.transact(() => { for (const i of hits.reverse()) strokes.delete(i, 1) }, LOCAL)
  }

  let erasing = false
  capture.addEventListener('pointerdown', (e) => {
    if (!strokes || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    capture.setPointerCapture(e.pointerId)
    const p = toPlane(e.clientX, e.clientY)
    if (tool.mode === 'erase') {
      erasing = true
      eraseAt(p)
      return
    }
    const map = new Y.Map()
    const points = new Y.Array()
    strokes.doc.transact(() => {
      map.set('color', tool.color)
      map.set('width', tool.width)
      map.set('points', points)
      points.push([Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10])
      strokes.push([map])
    }, LOCAL)
    cur = { map, points, last: p, pending: [] }
  })
  capture.addEventListener('pointermove', (e) => {
    if (!capture.hasPointerCapture(e.pointerId)) return
    const p = toPlane(e.clientX, e.clientY)
    if (erasing) return eraseAt(p)
    if (!cur) return
    if (Math.hypot(p.x - cur.last.x, p.y - cur.last.y) < MIN_STEP / zoom()) return
    cur.last = p
    cur.pending.push(Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10)
    if (!flushRaf) flushRaf = requestAnimationFrame(flush)
  })
  const end = (e) => {
    erasing = false
    finish()
    try { capture.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
  }
  capture.addEventListener('pointerup', end)
  capture.addEventListener('pointercancel', end)

  function setActive(on) {
    active = !!on && enabled && !!strokes
    capture.hidden = !active
    capture.classList.toggle('erasing', tool.mode === 'erase')
    if (!active) finish()
  }

  function bounds() {
    if (!strokes || !enabled) return null
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    strokes.forEach((s) => {
      if (!(s instanceof Y.Map)) return
      const pts = s.get('points')?.toArray() || []
      const r = (s.get('width') || 3) / 2
      for (let k = 0; k + 1 < pts.length; k += 2) {
        x0 = Math.min(x0, pts[k] - r); x1 = Math.max(x1, pts[k] + r)
        y0 = Math.min(y0, pts[k + 1] - r); y1 = Math.max(y1, pts[k + 1] + r)
      }
    })
    return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }

  return {
    el,
    capture,
    bind,
    setEnabled(on) {
      enabled = !!on
      el.style.display = enabled ? '' : 'none'
      if (!enabled) setActive(false)
      schedule()
    },
    setActive,
    isActive: () => active,
    setTool(t) {
      tool = { ...tool, ...t }
      capture.classList.toggle('erasing', tool.mode === 'erase')
    },
    getTool: () => ({ ...tool }),
    undo: () => { finish(); undoMgr?.undo() },
    redo: () => undoMgr?.redo(),
    canUndo: () => !!undoMgr?.undoStack.length,
    bounds,
    schedule,
    destroy() {
      bind(null)
      el.remove()
      capture.remove()
    },
  }
}
