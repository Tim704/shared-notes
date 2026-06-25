import * as Y from 'yjs'
import { rafThrottle, clamp } from './util.js'

// ---------------------------------------------------------------------------
// Collaborative sketch surface. Strokes AND text labels live in one Yjs
// Y.Array so they sync and persist exactly like notes do.
//   stroke: Y.Map { color, width, mode:'pen'|'erase', points: Y.Array<number> }
//   text:   Y.Map { type:'text', x, y, text, color, size }
// Coordinates are stored in a fixed logical space (LW x LH) and scaled to fit
// each client's canvas, so a drawing looks the same on a phone and a laptop.
// Text is always rendered on top of strokes (so the eraser never eats it).
// ---------------------------------------------------------------------------

const LW = 1600
const LH = 1000
const MIN_STEP = 1.6 // logical units between recorded points
const FONT = '"Schibsted Grotesk", ui-sans-serif, system-ui, sans-serif'
const LINE_H = 1.25

export function createDrawSurface(host, yStrokes, opts = {}) {
  const canvas = document.createElement('canvas')
  canvas.className = 'draw-canvas'
  host.appendChild(canvas)
  const ctx = canvas.getContext('2d')

  // Overlay <textarea> used while placing/editing a text label.
  const textInput = document.createElement('textarea')
  textInput.className = 'draw-text-input'
  textInput.rows = 1
  textInput.spellcheck = false
  textInput.style.display = 'none'
  host.appendChild(textInput)

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
    if (editing) positionEditor()
    redraw()
  }

  function toLogical(clientX, clientY) {
    const rect = canvas.getBoundingClientRect()
    const sx = clientX - rect.left
    const sy = clientY - rect.top
    return [clamp((sx - ox) / scale, 0, LW), clamp((sy - oy) / scale, 0, LH)]
  }

  // ---- rendering ----
  function isText(s) {
    return s && s.get('type') === 'text'
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

  function drawText(s) {
    const text = String(s.get('text') ?? '')
    if (!text) return
    const x = s.get('x') || 0
    const y = s.get('y') || 0
    const size = (s.get('size') || 28) * scale
    ctx.save()
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = s.get('color') || '#1f2228'
    ctx.font = `600 ${size}px ${FONT}`
    ctx.textBaseline = 'top'
    const lh = size * LINE_H
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], ox + x * scale, oy + y * scale + i * lh)
    }
    ctx.restore()
  }

  function redraw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)
    // strokes first (their eraser composites among themselves)...
    yStrokes.forEach((s) => {
      if (!isText(s)) drawStroke(s)
    })
    // ...then text always on top.
    yStrokes.forEach((s) => {
      if (isText(s)) drawText(s)
    })
  }
  const scheduleRedraw = rafThrottle(redraw)

  // ---- text hit-testing + editing ----
  let editing = null // { obj: Y.Map|null, x, y, size }

  function indexOfStroke(s) {
    for (let i = 0; i < yStrokes.length; i++) if (yStrokes.get(i) === s) return i
    return -1
  }

  function measureLogicalWidth(text, size) {
    // measure at identity transform so the result is in logical units
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.font = `600 ${size}px ${FONT}`
    let w = 0
    for (const line of String(text).split('\n')) w = Math.max(w, ctx.measureText(line || ' ').width)
    ctx.restore()
    return w
  }

  function textAt(lx, ly) {
    for (let i = yStrokes.length - 1; i >= 0; i--) {
      const s = yStrokes.get(i)
      if (!isText(s)) continue
      const x = s.get('x') || 0
      const y = s.get('y') || 0
      const size = s.get('size') || 28
      const text = String(s.get('text') ?? '')
      const lines = text.split('\n')
      const lh = size * LINE_H
      const h = Math.max(lh, lines.length * lh)
      const w = measureLogicalWidth(text, size)
      if (lx >= x - 6 && lx <= x + w + 10 && ly >= y - 4 && ly <= y + h + 4) return s
    }
    return null
  }

  function textSize() {
    return clamp(Math.round(tool.width * 6), 18, 160)
  }

  function positionEditor() {
    if (!editing) return
    textInput.style.left = ox + editing.x * scale + 'px'
    textInput.style.top = oy + editing.y * scale + 'px'
    textInput.style.fontSize = Math.max(10, editing.size * scale) + 'px'
    autoSizeEditor()
  }

  function autoSizeEditor() {
    textInput.style.width = 'auto'
    textInput.style.height = 'auto'
    textInput.style.width = Math.min(textInput.scrollWidth + 4, cssW) + 'px'
    textInput.style.height = textInput.scrollHeight + 'px'
  }

  function openTextEditor(lx, ly, existing) {
    closeTextEditor(true) // commit anything already open
    const size = existing ? existing.get('size') || 28 : textSize()
    editing = {
      obj: existing || null,
      x: existing ? existing.get('x') || 0 : lx,
      y: existing ? existing.get('y') || 0 : ly,
      size,
    }
    textInput.value = existing ? String(existing.get('text') ?? '') : ''
    textInput.style.color = existing ? existing.get('color') || tool.color : tool.color
    textInput.style.display = 'block'
    positionEditor()
    redraw() // hide the underlying object while it's being edited would be nice, but keep simple
    requestAnimationFrame(() => {
      textInput.focus()
      const len = textInput.value.length
      try {
        textInput.setSelectionRange(len, len)
      } catch {
        /* ignore */
      }
    })
  }

  function closeTextEditor(commit) {
    if (!editing) return
    const ed = editing
    editing = null
    const text = textInput.value
    textInput.style.display = 'none'
    textInput.value = ''
    if (!commit) return
    const hasText = text.trim() !== ''
    yStrokes.doc.transact(() => {
      const idx = ed.obj ? indexOfStroke(ed.obj) : -1
      if (ed.obj && idx >= 0) {
        // editing an existing, still-present label
        if (!hasText) yStrokes.delete(idx, 1)
        else ed.obj.set('text', text)
      } else if (hasText) {
        // either a brand-new label, or one that was deleted from under us while
        // we were editing — re-add the edit rather than silently dropping it
        const t = new Y.Map()
        t.set('type', 'text')
        t.set('x', ed.x)
        t.set('y', ed.y)
        t.set('text', text)
        t.set('color', (ed.obj && ed.obj.get('color')) || tool.color)
        t.set('size', ed.size)
        yStrokes.push([t])
      }
    })
  }

  textInput.addEventListener('input', autoSizeEditor)
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      closeTextEditor(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeTextEditor(false)
    }
  })
  textInput.addEventListener('blur', () => closeTextEditor(true))
  textInput.addEventListener('pointerdown', (e) => e.stopPropagation())

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

    if (tool.mode === 'text') {
      const [lx, ly] = toLogical(e.clientX, e.clientY)
      const hit = textAt(lx, ly)
      openTextEditor(lx, ly, hit)
      return
    }

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

  function applyCursor() {
    canvas.style.cursor = tool.mode === 'text' ? 'text' : 'crosshair'
  }
  applyCursor()

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
      if (m !== 'text') closeTextEditor(true)
      tool.mode = m
      applyCursor()
    },
    getTool: () => ({ ...tool }),
    clear: () => {
      closeTextEditor(false)
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
      closeTextEditor(false)
      yStrokes.unobserveDeep(observer)
      ro.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', endStroke)
      canvas.removeEventListener('pointercancel', endStroke)
      canvas.removeEventListener('pointerleave', endStroke)
      textInput.remove()
      canvas.remove()
    },
  }
}
