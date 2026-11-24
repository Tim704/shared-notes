import * as Y from 'yjs'
import { DOCUMENT_INK } from './util.js'
import { rafThrottle, clamp } from './util.js'
import { smoothPoint, simplify, tracePath } from './stroke.js'
import { getSettings } from './settings.js'

const smoothing = () => Math.max(0, Math.min(0.9, Number(getSettings().inkSmoothing) || 0))

// ---------------------------------------------------------------------------
// Collaborative sketch surface. Strokes AND text labels live in one Yjs
// Y.Array so they sync and persist exactly like notes do.
//   stroke: Y.Map { color, width, mode:'pen'|'erase', points: Y.Array<number> }
//   text:   Y.Map { type:'text', x, y, text, color, size }
//   image:  Y.Map { type:'image', src:'/media/…', x, y, w, h }
// Pictures are drawn on their own canvas under the ink, so the eraser (which
// cuts holes in the ink canvas) never eats them and you can draw on top.
// Coordinates are stored in a fixed logical space (LW x LH) and scaled to fit
// each client's canvas, so a drawing looks the same on a phone and a laptop.
// Text is always rendered on top of strokes (so the eraser never eats it).
// ---------------------------------------------------------------------------

const LW = 1600
const LH = 1000
const MIN_STEP = 1.6 // logical units between recorded points
const FONT = '-apple-system, BlinkMacSystemFont, "Inter var", "Segoe UI", system-ui, sans-serif'
const LINE_H = 1.25

export function createDrawSurface(host, yStrokes, opts = {}) {
  const under = document.createElement('canvas') // the paper and the pictures
  under.className = 'draw-pics'
  host.appendChild(under)
  const uctx = under.getContext('2d')
  const canvas = document.createElement('canvas')
  canvas.className = 'draw-canvas over-pics'
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
    color: opts.color || DOCUMENT_INK,
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
    under.width = canvas.width
    under.height = canvas.height
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
    ctx.strokeStyle = s.get('color') || DOCUMENT_INK
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
    tracePath(ctx, arr, (x) => ox + x * scale, (y) => oy + y * scale)
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
    ctx.fillStyle = s.get('color') || DOCUMENT_INK
    ctx.font = `600 ${size}px ${FONT}`
    ctx.textBaseline = 'top'
    const lh = size * LINE_H
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], ox + x * scale, oy + y * scale + i * lh)
    }
    ctx.restore()
  }

  function isImage(s) {
    return s && s.get('type') === 'image'
  }
  const pics = new Map() // src -> HTMLImageElement (loaded, loading or failed)
  function picFor(src) {
    let im = pics.get(src)
    if (!im) {
      im = new Image()
      im.onload = () => scheduleRedraw()
      im.src = src
      pics.set(src, im)
    }
    return im.complete && im.naturalWidth ? im : null
  }
  const boxOf = (s) => ({ x: Number(s.get('x')) || 0, y: Number(s.get('y')) || 0, w: Math.max(8, Number(s.get('w')) || 0), h: Math.max(8, Number(s.get('h')) || 0) })
  const HANDLE = 14 // css px: the resize corner of the selected picture

  function redraw() {
    uctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    uctx.clearRect(0, 0, cssW, cssH)
    yStrokes.forEach((s) => {
      if (!isImage(s)) return
      const b = boxOf(s)
      const im = picFor(String(s.get('src') || ''))
      if (im) uctx.drawImage(im, ox + b.x * scale, oy + b.y * scale, b.w * scale, b.h * scale)
      else {
        uctx.fillStyle = 'rgba(127,127,127,.18)'
        uctx.fillRect(ox + b.x * scale, oy + b.y * scale, b.w * scale, b.h * scale)
      }
    })
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)
    // strokes first (their eraser composites among themselves)...
    yStrokes.forEach((s) => {
      if (!isText(s) && !isImage(s)) drawStroke(s)
    })
    // ...then text always on top.
    yStrokes.forEach((s) => {
      if (isText(s)) drawText(s)
    })
    // what is on the sheet, readable without reading pixels back (tests, assistive tools)
    let nPics = 0
    yStrokes.forEach((s) => isImage(s) && nPics++)
    host.dataset.pictures = String(nPics)
    const pickedBox = picked && tool.mode === 'select' && indexOfStroke(picked) >= 0 ? boxOf(picked) : null
    host.dataset.picked = pickedBox ? [pickedBox.x, pickedBox.y, pickedBox.w, pickedBox.h].join(',') : ''
    // the picked picture's frame and resize corner
    if (pickedBox) {
      const b = pickedBox
      const x = ox + b.x * scale
      const y = oy + b.y * scale
      ctx.save()
      ctx.strokeStyle = '#0a84ff'
      ctx.lineWidth = 2
      ctx.strokeRect(x, y, b.w * scale, b.h * scale)
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      ctx.arc(x + b.w * scale, y + b.h * scale, HANDLE / 2, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }
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

  // ---- pictures: pick, move, resize, delete (the Select tool) ----
  let picked = null // the selected image Y.Map
  let moving = null // { obj, kind: 'move'|'size', sx, sy, box, ratio }
  function imageAt(lx, ly) {
    for (let i = yStrokes.length - 1; i >= 0; i--) {
      const s = yStrokes.get(i)
      if (!isImage(s)) continue
      const b = boxOf(s)
      if (lx >= b.x && lx <= b.x + b.w && ly >= b.y && ly <= b.y + b.h) return s
    }
    return null
  }
  function startPicture(e) {
    const [lx, ly] = toLogical(e.clientX, e.clientY)
    const grab = HANDLE / scale
    let hit = null
    let kind = 'move'
    if (picked && indexOfStroke(picked) >= 0) {
      const b = boxOf(picked)
      if (Math.hypot(lx - (b.x + b.w), ly - (b.y + b.h)) <= grab) {
        hit = picked
        kind = 'size'
      }
    }
    if (!hit) hit = imageAt(lx, ly)
    picked = hit
    onPick(!!picked)
    redraw()
    if (!hit) return
    try {
      canvas.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    const box = boxOf(hit)
    moving = { obj: hit, kind, sx: lx, sy: ly, box, ratio: box.w / box.h, next: null }
  }
  const commitPicture = rafThrottle(() => {
    if (!moving || !moving.next || indexOfStroke(moving.obj) < 0) return
    const n = moving.next
    yStrokes.doc.transact(() => {
      for (const k of ['x', 'y', 'w', 'h']) if (moving.obj.get(k) !== n[k]) moving.obj.set(k, n[k])
    })
  })
  function movePicture(e) {
    const [lx, ly] = toLogical(e.clientX, e.clientY)
    const { box, kind, sx, sy, ratio } = moving
    const r = (v) => Math.round(v * 10) / 10
    if (kind === 'move') moving.next = { x: r(clamp(box.x + lx - sx, -box.w + 20, LW - 20)), y: r(clamp(box.y + ly - sy, -box.h + 20, LH - 20)), w: box.w, h: box.h }
    else {
      // the corner keeps the picture's shape
      const w = clamp(Math.max(lx - box.x, (ly - box.y) * ratio), 24, LW * 2)
      moving.next = { x: box.x, y: box.y, w: r(w), h: r(w / ratio) }
    }
    commitPicture()
  }
  function endPicture(e) {
    if (!moving) return
    if (e) {
      try {
        canvas.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      if (e.type === 'pointerup') movePicture(e)
    }
    const m = moving
    if (m.next && indexOfStroke(m.obj) >= 0) yStrokes.doc.transact(() => ['x', 'y', 'w', 'h'].forEach((k) => m.obj.get(k) !== m.next[k] && m.obj.set(k, m.next[k])))
    moving = null
  }
  function deletePicked() {
    const i = picked ? indexOfStroke(picked) : -1
    if (i < 0) return false
    yStrokes.doc.transact(() => yStrokes.delete(i, 1))
    picked = null
    onPick(false)
    return true
  }
  const onPick = opts.onPick || (() => {})
  const onKey = (e) => {
    if (tool.mode !== 'select' || !picked || editing) return
    if (e.target && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (deletePicked()) e.preventDefault()
    } else if (e.key === 'Escape') {
      picked = null
      onPick(false)
      redraw()
    }
  }
  window.addEventListener('keydown', onKey)
  /** Put a picture on the sheet (centred, or at a client point), picked and ready to move. */
  function addImage(src, natW, natH, at) {
    const ratio = natW > 0 && natH > 0 ? natW / natH : 4 / 3
    let w = Math.min(640, Math.max(120, natW || 480))
    let h = w / ratio
    if (h > 520) {
      h = 520
      w = h * ratio
    }
    const [cx, cy] = at ? toLogical(at.x, at.y) : [LW / 2, LH / 2]
    const m = new Y.Map()
    yStrokes.doc.transact(() => {
      m.set('type', 'image')
      m.set('src', src)
      m.set('x', Math.round(clamp(cx - w / 2, 0, LW - w)))
      m.set('y', Math.round(clamp(cy - h / 2, 0, LH - h)))
      m.set('w', Math.round(w))
      m.set('h', Math.round(h))
      yStrokes.push([m])
    })
    picked = m
    onPick(true)
    redraw()
    return m
  }

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
    if (tool.mode === 'select') return startPicture(e)

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
    active = { stroke, points, last: [x, y], smooth: { x, y }, raw: { x, y }, buf: [] }
  }

  function onPointerMove(e) {
    if (moving) {
      e.preventDefault()
      return movePicture(e)
    }
    if (!active) return
    e.preventDefault()
    // coalesced events give smoother lines on fast strokes
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e]
    for (const ev of events.length ? events : [e]) {
      const [rx, ry] = toLogical(ev.clientX, ev.clientY)
      active.raw = { x: rx, y: ry }
      active.smooth = smoothPoint(active.smooth, active.raw, smoothing())
      const { x, y } = active.smooth
      const dx = x - active.last[0]
      const dy = y - active.last[1]
      if (dx * dx + dy * dy < MIN_STEP * MIN_STEP) continue
      active.last = [x, y]
      active.buf.push(x, y)
    }
    scheduleFlush()
  }

  function endStroke(e) {
    if (moving && (!e || e.type !== 'pointerleave')) endPicture(e)
    if (!active) return
    if (e) {
      try {
        canvas.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }
    // the smoothed line trails the pen a little: end it where the pen lifted
    const { raw, last } = active
    if (Math.hypot(raw.x - last[0], raw.y - last[1]) > 0.5) active.buf.push(raw.x, raw.y)
    flushBuffer()
    const { points } = active
    const pts = points.toArray()
    const lean = simplify(pts, 0.4)
    if (lean.length < pts.length) {
      yStrokes.doc.transact(() => {
        points.delete(0, points.length)
        points.push(lean)
      })
    }
    active = null
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', endStroke)
  canvas.addEventListener('pointercancel', endStroke)
  canvas.addEventListener('pointerleave', endStroke)

  function applyCursor() {
    canvas.style.cursor = tool.mode === 'text' ? 'text' : tool.mode === 'select' ? 'default' : 'crosshair'
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
      if (m !== 'select') {
        picked = null
        onPick(false)
      }
      applyCursor()
      redraw()
    },
    addImage,
    // switch tool without dropping the picture that was just placed
    setModeKeepingPick: (m) => {
      const keep = picked
      tool.mode = m
      picked = m === 'select' ? keep : null
      applyCursor()
      redraw()
    },
    deletePicked,
    hasPicked: () => !!picked && indexOfStroke(picked) >= 0,
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
      window.removeEventListener('keydown', onKey)
      textInput.remove()
      canvas.remove()
      under.remove()
      delete host.dataset.pictures
      delete host.dataset.picked
    },
  }
}
