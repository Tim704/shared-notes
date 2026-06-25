import * as Y from 'yjs'
import { rafThrottle, clamp } from './util.js'

// ---------------------------------------------------------------------------
// Collaborative sketch surface. Strokes live in a Yjs Y.Array so they sync and
// persist exactly like notes do. Each stroke is a Y.Map:
//   { color, width, mode:'pen'|'erase', points: Y.Array<number> }   // flat x,y,x,y...
// Coordinates are stored in a fixed logical space (LW x LH) and scaled to fit
// each client's canvas, so a drawing looks the same on a phone and a laptop.
// ---------------------------------------------------------------------------

const LW = 1600
const LH = 1000
const MIN_STEP = 1.6 // logical units between recorded points

export function createDrawSurface(host, yStrokes, opts = {}) {
  const canvas = document.createElement('canvas')
  canvas.className = 'draw-canvas'
  host.appendChild(canvas)
  const ctx = canvas.getContext('2d')

  const tool = {
    color: opts.color || '#1f2228',
    width: opts.width || 4,
    mode: 'pen',
  }

  let dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2.5))
  let cssW = 0
  let cssH = 0
  let scale = 1
  let ox = 0
  let oy = 0

  function layout() {
    const rect = canvas.getBoundingClientRect()
    cssW = Math.max(1, rect.width)
    cssH = Math.max(1, rect.height)
    dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2.5))
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
    scale = Math.min(cssW / LW, cssH / LH)
    ox = (cssW - LW * scale) / 2
    oy = (cssH - LH * scale) / 2
    redraw()
  }

  function toLogical(clientX, clientY) {
    const rect = canvas.getBoundingClientRect()
    const sx = clientX - rect.left
    const sy = clientY - rect.top
    return [clamp((sx - ox) / scale, 0, LW), clamp((sy - oy) / scale, 0, LH)]
  }

  function drawStroke(s) {
    const pts = s.get('points')
    if (!pts || pts.length < 2) return
    const arr = pts.toArray ? pts.toArray() : pts
    ctx.save()
    ctx.globalCompositeOperation = s.get('mode') === 'erase' ? 'destination-out' : 'source-over'
    ctx.strokeStyle = s.get('color') || '#1f2228'
    ctx.fillStyle = ctx.strokeStyle
    ctx.lineWidth = Math.max(0.5, (s.get('width') || 4) * scale)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (arr.length === 2) {
      // a single tap: draw a dot
      ctx.beginPath()
      ctx.arc(ox + arr[0] * scale, oy + arr[1] * scale, ctx.lineWidth / 2, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
      return
    }
    ctx.beginPath()
    ctx.moveTo(ox + arr[0] * scale, oy + arr[1] * scale)
    for (let i = 2; i < arr.length; i += 2) {
      ctx.lineTo(ox + arr[i] * scale, oy + arr[i + 1] * scale)
    }
    ctx.stroke()
    ctx.restore()
  }

  function redraw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)
    yStrokes.forEach((s) => drawStroke(s))
  }
  const scheduleRedraw = rafThrottle(redraw)

  // ---- live drawing ----
  let active = null // { stroke: Y.Map, points: Y.Array, last:[x,y], buf:[] }
  let flushScheduled = false

  function flushBuffer() {
    flushScheduled = false
    if (!active || active.buf.length === 0) return
    const buf = active.buf
    active.buf = []
    yStrokes.doc.transact(() => {
      active.points.push(buf)
    })
  }
  function scheduleFlush() {
    if (flushScheduled) return
    flushScheduled = true
    requestAnimationFrame(flushBuffer)
  }

  function onPointerDown(e) {
    if (e.button != null && e.button !== 0 && e.pointerType === 'mouse') return
    e.preventDefault()
    try {
      canvas.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    const [x, y] = toLogical(e.clientX, e.clientY)
    const stroke = new Y.Map()
    const points = new Y.Array()
    yStrokes.doc.transact(() => {
      stroke.set('color', tool.color)
      stroke.set('width', tool.width)
      stroke.set('mode', tool.mode)
      stroke.set('points', points)
      points.push([x, y])
      yStrokes.push([stroke])
    })
    active = { stroke, points, last: [x, y], buf: [] }
  }

  function onPointerMove(e) {
    if (!active) return
    e.preventDefault()
    // coalesced events give smoother lines on fast strokes
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e]
    for (const ev of events.length ? events : [e]) {
      const [x, y] = toLogical(ev.clientX, ev.clientY)
      const dx = x - active.last[0]
      const dy = y - active.last[1]
      if (dx * dx + dy * dy < MIN_STEP * MIN_STEP) continue
      active.last = [x, y]
      active.buf.push(x, y)
    }
    scheduleFlush()
  }

  function endStroke(e) {
    if (!active) return
    if (e) {
      try {
        canvas.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }
    flushBuffer()
    active = null
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', endStroke)
  canvas.addEventListener('pointercancel', endStroke)
  canvas.addEventListener('pointerleave', endStroke)

  // ---- sync + resize ----
  const observer = () => scheduleRedraw()
  yStrokes.observeDeep(observer)
  const ro = new ResizeObserver(() => layout())
  ro.observe(canvas)
  layout()

  return {
    setColor: (c) => {
      tool.color = c
    },
    setWidth: (w) => {
      tool.width = w
    },
    setMode: (m) => {
      tool.mode = m
    },
    getTool: () => ({ ...tool }),
    clear: () => {
      yStrokes.doc.transact(() => {
        if (yStrokes.length) yStrokes.delete(0, yStrokes.length)
      })
    },
    undoLast: () => {
      yStrokes.doc.transact(() => {
        if (yStrokes.length) yStrokes.delete(yStrokes.length - 1, 1)
      })
    },
    destroy() {
      endStroke(null)
      yStrokes.unobserveDeep(observer)
      ro.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', endStroke)
      canvas.removeEventListener('pointercancel', endStroke)
      canvas.removeEventListener('pointerleave', endStroke)
      canvas.remove()
    },
  }
}
