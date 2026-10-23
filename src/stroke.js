// Shared helpers for free-hand strokes (NotePad ink and the Sketch Pad).
// Points are flat arrays: [x, y, x, y, …].
//
// smoothPoint  — a "streamline" filter applied while drawing: each recorded
//                point moves only part of the way towards the pen, which irons
//                out hand wobble without a visible lag on normal strokes.
// simplify     — Ramer–Douglas–Peucker, run when the pen lifts, so a stroke
//                keeps its shape with far fewer points.
// pathData     — an SVG path of quadratic curves through the midpoints.
// tracePath    — the same curve traced onto a canvas context.

export const SMOOTHING = 0.5 // 0 = raw input, closer to 1 = smoother but laggier

export function smoothPoint(prev, raw, k = SMOOTHING) {
  if (!prev) return raw
  return { x: prev.x + (raw.x - prev.x) * (1 - k), y: prev.y + (raw.y - prev.y) * (1 - k) }
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

export function simplify(pts, tol = 0.5) {
  const n = pts.length >> 1
  if (n < 3) return pts.slice()
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const stack = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    let max = 0, idx = -1
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i * 2], pts[i * 2 + 1], pts[a * 2], pts[a * 2 + 1], pts[b * 2], pts[b * 2 + 1])
      if (d > max) { max = d; idx = i }
    }
    if (idx >= 0 && max > tol) {
      keep[idx] = 1
      stack.push([a, idx], [idx, b])
    }
  }
  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1])
  return out
}

export function pathData(pts) {
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

// Trace the curve on a canvas; `tx`/`ty` map stored coordinates to the screen.
export function tracePath(ctx, pts, tx, ty) {
  const n = pts.length >> 1
  ctx.moveTo(tx(pts[0]), ty(pts[1]))
  for (let i = 1; i < n - 1; i++) {
    const x = pts[i * 2], y = pts[i * 2 + 1]
    ctx.quadraticCurveTo(tx(x), ty(y), tx((x + pts[i * 2 + 2]) / 2), ty((y + pts[i * 2 + 3]) / 2))
  }
  ctx.lineTo(tx(pts[(n - 1) * 2]), ty(pts[(n - 1) * 2 + 1]))
}
