// Alignment help while moving and resizing notes: snap an edge or centre line
// to a neighbour's (or to a grid) and show thin guide lines. Pure geometry plus
// one small layer that draws the guides; the board code decides when to call it.

/**
 * snapMove(rect, others, { threshold, grid }) → { dx, dy, guides }
 * rect/others: { x, y, w, h }. dx/dy: how far to shift rect to snap.
 */
export function snapMove(rect, others, opts = {}) {
  const t = opts.threshold || 6
  const mineX = [rect.x, rect.x + rect.w / 2, rect.x + rect.w]
  const mineY = [rect.y, rect.y + rect.h / 2, rect.y + rect.h]
  let bx = null
  let by = null
  for (const o of others) {
    const ox = [o.x, o.x + o.w / 2, o.x + o.w]
    const oy = [o.y, o.y + o.h / 2, o.y + o.h]
    for (const m of mineX)
      for (const v of ox) {
        const d = v - m
        if (Math.abs(d) <= t && (!bx || Math.abs(d) < Math.abs(bx.d))) bx = { d, at: v }
      }
    for (const m of mineY)
      for (const v of oy) {
        const d = v - m
        if (Math.abs(d) <= t && (!by || Math.abs(d) < Math.abs(by.d))) by = { d, at: v }
      }
  }
  let dx = bx ? bx.d : 0
  let dy = by ? by.d : 0
  const g = opts.grid || 0
  if (g > 0) {
    if (!bx) dx = Math.round(rect.x / g) * g - rect.x
    if (!by) dy = Math.round(rect.y / g) * g - rect.y
  }
  const r = { x: rect.x + dx, y: rect.y + dy, w: rect.w, h: rect.h }
  return { dx, dy, guides: guidesFor(r, others, bx && bx.at, by && by.at) }
}

/** snapResize(rect, others, opts) → { w, h, guides }: snaps the right and bottom edges. */
export function snapResize(rect, others, opts = {}) {
  const t = opts.threshold || 6
  const right = rect.x + rect.w
  const bottom = rect.y + rect.h
  let bx = null
  let by = null
  for (const o of others) {
    for (const v of [o.x, o.x + o.w]) {
      const d = v - right
      if (Math.abs(d) <= t && (!bx || Math.abs(d) < Math.abs(bx.d))) bx = { d, at: v }
    }
    for (const v of [o.y, o.y + o.h]) {
      const d = v - bottom
      if (Math.abs(d) <= t && (!by || Math.abs(d) < Math.abs(by.d))) by = { d, at: v }
    }
  }
  let w = rect.w + (bx ? bx.d : 0)
  let h = rect.h + (by ? by.d : 0)
  const g = opts.grid || 0
  if (g > 0) {
    if (!bx) w = Math.round((rect.x + rect.w) / g) * g - rect.x
    if (!by) h = Math.round((rect.y + rect.h) / g) * g - rect.y
  }
  const r = { x: rect.x, y: rect.y, w, h }
  return { w, h, guides: guidesFor(r, others, bx && bx.at, by && by.at) }
}

// guide segments through every note touching the snapped line
function guidesFor(r, others, gx, gy) {
  const out = []
  const near = (a, b) => Math.abs(a - b) < 0.75
  if (gx != null) {
    let y0 = r.y
    let y1 = r.y + r.h
    for (const o of others) {
      if ([o.x, o.x + o.w / 2, o.x + o.w].some((v) => near(v, gx))) {
        y0 = Math.min(y0, o.y)
        y1 = Math.max(y1, o.y + o.h)
      }
    }
    out.push({ x1: gx, y1: y0 - 8, x2: gx, y2: y1 + 8 })
  }
  if (gy != null) {
    let x0 = r.x
    let x1 = r.x + r.w
    for (const o of others) {
      if ([o.y, o.y + o.h / 2, o.y + o.h].some((v) => near(v, gy))) {
        x0 = Math.min(x0, o.x)
        x1 = Math.max(x1, o.x + o.w)
      }
    }
    out.push({ x1: x0 - 8, y1: gy, x2: x1 + 8, y2: gy })
  }
  return out
}

/** A layer of guide lines in board/plane coordinates. */
export function createGuides() {
  const layer = document.createElement('div')
  layer.className = 'guides'
  return {
    el: layer,
    show(guides, scale = 1) {
      layer.replaceChildren()
      const px = 1 / scale
      for (const g of guides) {
        const d = document.createElement('div')
        d.className = 'guide'
        if (g.x1 === g.x2) {
          d.style.left = g.x1 - px / 2 + 'px'
          d.style.top = g.y1 + 'px'
          d.style.width = px + 'px'
          d.style.height = g.y2 - g.y1 + 'px'
        } else {
          d.style.left = g.x1 + 'px'
          d.style.top = g.y1 - px / 2 + 'px'
          d.style.width = g.x2 - g.x1 + 'px'
          d.style.height = px + 'px'
        }
        layer.appendChild(d)
      }
    },
    clear() {
      layer.replaceChildren()
    },
  }
}

// ---- align / distribute a selection ---------------------------------------------
// rects: [{ id, x, y, w, h }] → [{ id, x, y, w?, h? }] (only what changes)

export function alignRects(rects, how) {
  if (rects.length < 2) return []
  const minX = Math.min(...rects.map((r) => r.x))
  const maxX = Math.max(...rects.map((r) => r.x + r.w))
  const minY = Math.min(...rects.map((r) => r.y))
  const maxY = Math.max(...rects.map((r) => r.y + r.h))
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return rects.map((r) => {
    if (how === 'left') return { id: r.id, x: minX, y: r.y }
    if (how === 'right') return { id: r.id, x: maxX - r.w, y: r.y }
    if (how === 'center') return { id: r.id, x: Math.round(cx - r.w / 2), y: r.y }
    if (how === 'top') return { id: r.id, x: r.x, y: minY }
    if (how === 'bottom') return { id: r.id, x: r.x, y: maxY - r.h }
    if (how === 'middle') return { id: r.id, x: r.x, y: Math.round(cy - r.h / 2) }
    return { id: r.id, x: r.x, y: r.y }
  })
}

/** Equal gaps between the notes, keeping the two outermost where they are. */
export function distributeRects(rects, axis) {
  if (rects.length < 3) return []
  const horiz = axis === 'h'
  const sorted = rects.slice().sort((a, b) => (horiz ? a.x - b.x : a.y - b.y))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const span = horiz ? last.x + last.w - first.x : last.y + last.h - first.y
  const sizes = sorted.reduce((s, r) => s + (horiz ? r.w : r.h), 0)
  const gap = (span - sizes) / (sorted.length - 1)
  let pos = horiz ? first.x : first.y
  return sorted.map((r) => {
    const out = horiz ? { id: r.id, x: Math.round(pos), y: r.y } : { id: r.id, x: r.x, y: Math.round(pos) }
    pos += (horiz ? r.w : r.h) + gap
    return out
  })
}

export function matchSize(rects, dim) {
  if (rects.length < 2) return []
  const v = Math.max(...rects.map((r) => (dim === 'w' ? r.w : r.h)))
  return rects.map((r) => (dim === 'w' ? { id: r.id, x: r.x, y: r.y, w: v } : { id: r.id, x: r.x, y: r.y, h: v }))
}

/** Tidy up: a neat grid in reading order (rows by y, then x), starting at the top-left note. */
export function tidyRects(rects, gap = 16) {
  if (!rects.length) return []
  const ordered = rects.slice().sort((a, b) => a.y - b.y || a.x - b.x)
  const x0 = Math.min(...rects.map((r) => r.x))
  const y0 = Math.min(...rects.map((r) => r.y))
  const cols = Math.max(1, Math.round(Math.sqrt(rects.length * 1.6)))
  const colW = Math.max(...rects.map((r) => r.w)) + gap
  const out = []
  let y = y0
  for (let i = 0; i < ordered.length; i += cols) {
    const row = ordered.slice(i, i + cols)
    row.forEach((r, j) => out.push({ id: r.id, x: x0 + j * colW, y }))
    y += Math.max(...row.map((r) => r.h)) + gap
  }
  return out
}
