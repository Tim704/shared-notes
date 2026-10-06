// The "canvas" view of a tab: an endless plane you pan and zoom, instead of a
// board that only grows downwards. Notes keep their shared x/y/w/h (which may
// now be negative); the pan and zoom are this device's own business and are
// remembered per tab in localStorage.
//
//   drag the background, middle-drag, or hold Space and drag   pan
//   two-finger scroll / mouse wheel                             pan
//   Ctrl/⌘ + wheel, trackpad pinch, two-finger pinch            zoom (towards the pointer)
//   the − / % / + / ⤢ buttons and the minimap                   zoom, fit, jump

import { clamp, rafThrottle } from './util.js'

const KEY = 'notesViewport'
const MIN_K = 0.1
const MAX_K = 4

function loadAll() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

/**
 * createViewport({ board, plane, getRects, onChange })
 *   getRects(): [{ x, y, w, h, color }] for the minimap / fit
 *   onChange(view): after every pan/zoom
 * Returns { enable(tabId), disable(), view(), toPlane(cx, cy), center(), fit(), zoomBy(f, cx, cy),
 *           refreshMap(), isPanning(), destroy() }
 */
export function createViewport({ board, plane, getRects, onChange = () => {}, shouldPan = () => true }) {
  let tabId = null
  let view = { x: 40, y: 30, k: 1 }
  let on = false
  let spaceDown = false
  let pan = null // { id, sx, sy, vx, vy }
  const touches = new Map() // pointerId -> {x, y}
  let pinch = null

  // ---- chrome: zoom controls + minimap ------------------------------------------
  const ctrls = document.createElement('div')
  ctrls.className = 'vp-ctrls'
  const btn = (label, title, fn) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'vp-btn'
    b.textContent = label
    b.title = title
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      fn()
    })
    ctrls.appendChild(b)
    return b
  }
  btn('−', 'Zoom out', () => zoomBy(1 / 1.25))
  const pct = btn('100%', 'Back to 100%', () => zoomTo(1))
  pct.classList.add('vp-pct')
  btn('+', 'Zoom in', () => zoomBy(1.25))
  btn('⤢', 'Fit every note', () => fit())
  const map = document.createElement('canvas')
  map.className = 'vp-map'
  map.width = 180
  map.height = 120
  map.title = 'Click to jump there'

  const save = rafThrottle(() => {
    if (!tabId) return
    const all = loadAll()
    all[tabId] = { x: Math.round(view.x), y: Math.round(view.y), k: Math.round(view.k * 1000) / 1000 }
    try {
      localStorage.setItem(KEY, JSON.stringify(all))
    } catch {
      /* ignore */
    }
  })

  function apply() {
    plane.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`
    board.style.backgroundPosition = `${view.x}px ${view.y}px`
    board.style.backgroundSize = `${22 * view.k}px ${22 * view.k}px`
    pct.textContent = Math.round(view.k * 100) + '%'
    drawMap()
    save()
    onChange(view)
  }

  function size() {
    return { W: board.clientWidth || window.innerWidth, H: board.clientHeight || window.innerHeight }
  }

  function zoomTo(k, cx, cy) {
    const { W, H } = size()
    const px = cx == null ? W / 2 : cx
    const py = cy == null ? H / 2 : cy
    const nk = clamp(k, MIN_K, MAX_K)
    view = { k: nk, x: px - ((px - view.x) / view.k) * nk, y: py - ((py - view.y) / view.k) * nk }
    apply()
  }
  const zoomBy = (f, cx, cy) => zoomTo(view.k * f, cx, cy)

  function contentBounds() {
    const rs = getRects()
    if (!rs.length) return null
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const r of rs) {
      x0 = Math.min(x0, r.x)
      y0 = Math.min(y0, r.y)
      x1 = Math.max(x1, r.x + r.w)
      y1 = Math.max(y1, r.y + r.h)
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }

  function fit() {
    const b = contentBounds()
    const { W, H } = size()
    if (!b) {
      view = { x: 40, y: 30, k: 1 }
      return apply()
    }
    const k = clamp(Math.min((W - 80) / b.w, (H - 80) / b.h), MIN_K, 1.5)
    view = { k, x: W / 2 - (b.x + b.w / 2) * k, y: H / 2 - (b.y + b.h / 2) * k }
    apply()
  }

  // screen (client) point → plane coordinates
  function toPlane(cx, cy) {
    const r = board.getBoundingClientRect()
    return { x: (cx - r.left - board.clientLeft - view.x) / view.k, y: (cy - r.top - board.clientTop - view.y) / view.k }
  }

  // centre of what is on screen, in plane coordinates
  function center() {
    const { W, H } = size()
    return { x: (W / 2 - view.x) / view.k, y: (H / 2 - view.y) / view.k }
  }

  // ---- minimap -------------------------------------------------------------------
  let mapScale = null
  function drawMap() {
    if (!on) return
    const ctx = map.getContext('2d')
    const MW = map.width
    const MH = map.height
    ctx.clearRect(0, 0, MW, MH)
    const { W, H } = size()
    const vis = { x: -view.x / view.k, y: -view.y / view.k, w: W / view.k, h: H / view.k }
    const b = contentBounds() || vis
    const x0 = Math.min(b.x, vis.x)
    const y0 = Math.min(b.y, vis.y)
    const x1 = Math.max(b.x + b.w, vis.x + vis.w)
    const y1 = Math.max(b.y + b.h, vis.y + vis.h)
    const s = Math.min((MW - 10) / (x1 - x0 || 1), (MH - 10) / (y1 - y0 || 1))
    const ox = (MW - (x1 - x0) * s) / 2 - x0 * s
    const oy = (MH - (y1 - y0) * s) / 2 - y0 * s
    mapScale = { s, ox, oy }
    for (const r of getRects()) {
      ctx.fillStyle = r.color || '#fff7a8'
      ctx.globalAlpha = 0.9
      ctx.fillRect(ox + r.x * s, oy + r.y * s, Math.max(2, r.w * s), Math.max(2, r.h * s))
    }
    ctx.globalAlpha = 1
    ctx.strokeStyle = '#ffd23f'
    ctx.lineWidth = 1.5
    ctx.strokeRect(ox + vis.x * s, oy + vis.y * s, vis.w * s, vis.h * s)
  }
  const jump = (e) => {
    if (!mapScale) return
    const r = map.getBoundingClientRect()
    const px = ((e.clientX - r.left) * map.width) / r.width
    const py = ((e.clientY - r.top) * map.height) / r.height
    const x = (px - mapScale.ox) / mapScale.s
    const y = (py - mapScale.oy) / mapScale.s
    const { W, H } = size()
    view = { ...view, x: W / 2 - x * view.k, y: H / 2 - y * view.k }
    apply()
  }
  map.addEventListener('pointerdown', (e) => {
    e.stopPropagation()
    jump(e)
    const mv = (ev) => jump(ev)
    const up = () => {
      window.removeEventListener('pointermove', mv)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', mv)
    window.addEventListener('pointerup', up)
  })

  // ---- input ---------------------------------------------------------------------
  const isBackground = (t) =>
    t === board || t === plane || (t && t.classList && (t.classList.contains('edges') || t.classList.contains('guides')))

  function onWheel(e) {
    if (!on) return
    if (e.target.closest && e.target.closest('.card-bodyhost, .card-pop, .mm-wrap') && !(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      const r = board.getBoundingClientRect()
      zoomBy(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), e.clientX - r.left, e.clientY - r.top)
    } else {
      const f = e.deltaMode === 1 ? 16 : 1
      view = { ...view, x: view.x - (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * f, y: view.y - (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * f }
      apply()
    }
  }

  function onPointerDown(e) {
    if (!on) return
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touches.size === 2) {
        const [a, b] = Array.from(touches.values())
        pan = null
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, view: { ...view } }
        e.preventDefault()
        return
      }
    }
    const middle = e.button === 1
    const bg = isBackground(e.target)
    if (!(middle || (spaceDown && e.button === 0) || (bg && e.button === 0 && shouldPan(e)))) return
    e.preventDefault()
    e.stopPropagation()
    pan = { id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }
    board.classList.add('panning')
    try {
      board.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }
  function onPointerMove(e) {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch && touches.size === 2) {
      const [a, b] = Array.from(touches.values())
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const cx = (a.x + b.x) / 2
      const cy = (a.y + b.y) / 2
      const r = board.getBoundingClientRect()
      const k = clamp(pinch.view.k * (d / (pinch.d || 1)), MIN_K, MAX_K)
      const px = pinch.cx - r.left
      const py = pinch.cy - r.top
      view = {
        k,
        x: px - ((px - pinch.view.x) / pinch.view.k) * k + (cx - pinch.cx),
        y: py - ((py - pinch.view.y) / pinch.view.k) * k + (cy - pinch.cy),
      }
      apply()
      return
    }
    if (!pan || e.pointerId !== pan.id) return
    view = { ...view, x: pan.vx + e.clientX - pan.sx, y: pan.vy + e.clientY - pan.sy }
    apply()
  }
  function onPointerUp(e) {
    touches.delete(e.pointerId)
    if (touches.size < 2) pinch = null
    if (pan && e.pointerId === pan.id) {
      pan = null
      board.classList.remove('panning')
    }
  }
  const editing = () => {
    const a = document.activeElement
    return a && (a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')
  }
  function onKey(e) {
    if (!on || e.code !== 'Space' || editing()) return
    if (e.type === 'keydown') {
      if (!e.repeat) {
        spaceDown = true
        board.classList.add('space-pan')
      }
      e.preventDefault()
    } else {
      spaceDown = false
      board.classList.remove('space-pan')
    }
  }

  board.addEventListener('wheel', onWheel, { passive: false })
  board.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKey)
  const onResize = rafThrottle(() => on && drawMap())
  window.addEventListener('resize', onResize)

  return {
    enable(id) {
      tabId = id
      const saved = loadAll()[id]
      on = true
      board.appendChild(ctrls)
      board.appendChild(map)
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.k)) {
        view = { x: saved.x, y: saved.y, k: clamp(saved.k, MIN_K, MAX_K) }
        apply()
      } else {
        view = { x: 40, y: 30, k: 1 }
        apply()
        requestAnimationFrame(() => fit())
      }
    },
    disable() {
      on = false
      tabId = null
      pan = null
      ctrls.remove()
      map.remove()
      plane.style.transform = ''
      board.style.backgroundPosition = ''
      board.style.backgroundSize = ''
    },
    view: () => view,
    toPlane,
    center,
    fit,
    zoomBy,
    centerOn(px, py) {
      const { W, H } = size()
      view = { ...view, x: W / 2 - px * view.k, y: H / 2 - py * view.k }
      apply()
    },
    refreshMap: () => drawMap(),
    isPanning: () => !!pan || !!pinch,
    isOn: () => on,
    tab: () => (on ? tabId : null),
  }
}
