// The mind map's data, shared by the browser (src/mindmap.js), the server's
// mirror / exports (shared/serialise.js) and the tests. Pure JS, no imports.
//
// A mind map tab lives in pages[tabId]:
//   title  Y.Text   the centre bubble's text
//   nodes  Y.Map    id -> Y.Map{ text, parent, order, x?, y?, color?, shape?, note?, image?, folded? }
//   links  Y.Map    id -> Y.Map{ from, to, label? }
//   v      2        set once the map has its own bubbles (older maps drew the outline in `body`)
//
// The centre is the fixed id 'root' and is not stored in `nodes`. A node whose
// `parent` is absent is a loose idea, placed wherever it was dropped. A node
// with `x`/`y` is pinned there (map coordinates, centre at 0,0) and the branch
// under it is laid out around it; everything else is laid out as a tree.

export const ROOT = 'root'
export const SHAPES = ['rounded', 'pill', 'box', 'line']
export const BRANCH = ['#d9730d', '#2e9e4f', '#2f80ed', '#9b51e0', '#c69400', '#0e9aa7', '#d63b6d', '#5b5bd6']
export const H_GAP = 56
export const V_GAP = 14

const get = (m, k) => (m && typeof m.get === 'function' ? m.get(k) : m ? m[k] : undefined)
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null)
function each(map, fn) {
  if (!map) return
  if (typeof map.forEach === 'function' && typeof map.get === 'function') map.forEach(fn)
  else Object.entries(map).forEach(([k, v]) => fn(v, k))
}

/** The map as a tree: { root, loose: [...], byId: Map }. */
export function mapTree(nodes, rootText = '') {
  const byId = new Map()
  const root = { id: ROOT, text: String(rootText || ''), parent: null, children: [], depth: 0, isRoot: true }
  byId.set(ROOT, root)
  each(nodes, (m, id) => {
    if (!m || id === ROOT) return
    byId.set(id, {
      id,
      text: String(get(m, 'text') ?? ''),
      parent: get(m, 'parent') || null,
      order: Number(get(m, 'order')) || 0,
      x: num(get(m, 'x')),
      y: num(get(m, 'y')),
      color: get(m, 'color') || null,
      shape: SHAPES.includes(get(m, 'shape')) ? get(m, 'shape') : 'rounded',
      note: String(get(m, 'note') || ''),
      image: get(m, 'image') || null,
      folded: get(m, 'folded') === true,
      children: [],
    })
  })
  const loose = []
  const climbsTo = (from, target) => {
    // does walking up from `from` reach `target`?
    let cur = byId.get(from)
    for (let i = 0; cur && i < 10000; i++) {
      if (cur.id === target) return true
      cur = cur.parent ? byId.get(cur.parent) : null
    }
    return false
  }
  for (const n of byId.values()) {
    if (n.isRoot) continue
    if (!n.parent) {
      loose.push(n)
      continue
    }
    const p = byId.get(n.parent)
    // a missing parent, or a loop, hangs the node off the centre
    if (p && !climbsTo(p.id, n.id)) p.children.push(n)
    else root.children.push(n)
  }
  const sort = (list) => list.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
  const walk = (n, depth) => {
    sort(n.children)
    for (const c of n.children) walk(c, depth + 1)
    n.depth = depth
  }
  walk(root, 0)
  sort(loose)
  loose.forEach((n) => walk(n, 1))
  return { root, loose, byId }
}

/** Every id in a node's branch, the node first. */
export function branchIds(node) {
  const out = []
  const walk = (n) => {
    out.push(n.id)
    n.children.forEach(walk)
  }
  walk(node)
  return out
}

/**
 * Positions for every visible node. `size(node)` → { w, h }.
 * Sets on each node: x, y, w, h, side (1 right / -1 left), color, hidden (under a fold).
 * Deterministic: every device draws the same map from the same data.
 */
export function layoutMap(tree, size) {
  const { root, loose } = tree
  const visible = []
  const measure = (n) => {
    const s = size(n)
    n.w = s.w
    n.h = s.h
  }
  const kidsOf = (n) => (n.folded ? [] : n.children)
  // vertical room a node's laid-out (unpinned) branch needs
  const span = (n) => {
    measure(n)
    const kids = kidsOf(n)
    kids.filter((c) => c.x != null).forEach((c) => span(c))
    const flow = kids.filter((c) => c.x == null)
    if (!flow.length) return (n.span = n.h)
    const s = flow.reduce((a, c) => a + span(c), 0) + V_GAP * (flow.length - 1)
    return (n.span = Math.max(n.h, s))
  }
  const placeKids = (n, dir, color) => {
    const kids = kidsOf(n)
    const flow = kids.filter((c) => c.x == null)
    const total = flow.reduce((a, c) => a + c.span, 0) + V_GAP * Math.max(0, flow.length - 1)
    let y = n.y - total / 2
    for (const c of flow) {
      c.side = dir
      c.x = n.x + dir * (n.w / 2 + H_GAP + c.w / 2)
      c.y = y + c.span / 2
      y += c.span + V_GAP
      place(c, dir, color)
    }
    for (const c of kids.filter((k) => k.pinned)) {
      c.side = c.x >= n.x ? 1 : -1
      place(c, c.side, color)
    }
  }
  const place = (n, dir, color) => {
    n.color = n.color || color
    visible.push(n)
    placeKids(n, dir, n.color)
  }
  const hide = (n) => {
    for (const c of n.children) {
      c.hidden = true
      hide(c)
    }
  }
  const markPins = (n) => {
    n.pinned = !n.isRoot && n.x != null && n.y != null
    if (!n.pinned && !n.isRoot) n.x = n.y = null
    n.children.forEach(markPins)
    if (n.folded) hide(n)
  }
  markPins(root)
  loose.forEach((n) => markPins(n))

  // the centre
  span(root)
  root.x = 0
  root.y = 0
  root.side = 0
  visible.push(root)
  // first-level branches: balanced between the right and the left
  const first = kidsOf(root)
  const weight = (n) => Math.max(1, kidsOf(n).reduce((s, c) => s + weight(c), 0))
  const total = first.reduce((s, c) => s + weight(c), 0)
  let acc = 0
  const sides = new Map()
  first.forEach((c) => {
    sides.set(c, first.length > 1 && acc >= total / 2 ? -1 : 1)
    acc += weight(c)
  })
  first.forEach((c, i) => {
    c.color = c.color || BRANCH[i % BRANCH.length]
  })
  for (const dir of [1, -1]) {
    const flow = first.filter((c) => sides.get(c) === dir && !c.pinned)
    const h = flow.reduce((a, c) => a + c.span, 0) + V_GAP * Math.max(0, flow.length - 1)
    let y = -h / 2
    for (const c of flow) {
      c.side = dir
      c.x = dir * (root.w / 2 + H_GAP + c.w / 2)
      c.y = y + c.span / 2
      y += c.span + V_GAP
      place(c, dir, c.color)
    }
  }
  for (const c of first.filter((k) => k.pinned)) {
    c.side = c.x >= 0 ? 1 : -1
    place(c, c.side, c.color)
  }

  // loose ideas: where they were dropped, or in a row under the map
  let maxY = 0
  for (const n of visible) maxY = Math.max(maxY, n.y + n.h / 2)
  let lx = 0
  for (const n of loose) {
    span(n)
    if (!n.pinned) {
      n.x = lx
      n.y = maxY + 60 + n.h / 2
      lx += n.w + 24
    }
    n.side = 1
    place(n, 1, n.color || '#8e8e93')
  }
  return visible
}

/** An older map (an outline in `body`) as new nodes: [{ id, text, parent, order }]. */
export function fromOutline(outline, genId) {
  const out = []
  const walk = (list, parent) =>
    list.forEach((t, i) => {
      const id = genId()
      const a = (t.line && t.line.attrs) || {}
      const text = (a.lt === 'todo' ? (a.done ? '☑ ' : '☐ ') : '') + String(t.line?.text || '').trim()
      out.push({ id, text, parent: parent || ROOT, order: i + 1 })
      walk(t.children || [], id)
    })
  walk(outline, null)
  return out
}

/** The map as Markdown: a nested list, notes as quotes, then loose ideas and links. */
export function mapMarkdown(title, nodes, links) {
  const tree = mapTree(nodes, title)
  const out = [`# ${tree.root.text.replace(/\s*\n\s*/g, ' ') || 'Mind map'}`, '']
  const line = (n, depth) => {
    const pad = '  '.repeat(depth)
    out.push(`${pad}- ${n.text.replace(/\s*\n\s*/g, ' ') || '(empty)'}`)
    if (n.image) out.push(`${pad}  ![](${n.image})`)
    if (n.note) n.note.split('\n').forEach((l) => out.push(`${pad}  > ${l}`))
    n.children.forEach((c) => line(c, depth + 1))
  }
  tree.root.children.forEach((c) => line(c, 0))
  if (tree.loose.length) {
    out.push('', '## Loose ideas', '')
    tree.loose.forEach((c) => line(c, 0))
  }
  const ls = []
  each(links, (m) => {
    const a = tree.byId.get(get(m, 'from'))
    const b = tree.byId.get(get(m, 'to'))
    if (a && b) ls.push(`- ${a.text || '(empty)'} → ${b.text || '(empty)'}${get(m, 'label') ? ` (${get(m, 'label')})` : ''}`)
  })
  if (ls.length) out.push('', '## Links', '', ...ls.sort())
  return out.join('\n') + '\n'
}

/** A branch as a task with nested parts (for "Send to To-do"). */
export function branchToTasks(node) {
  return { text: node.text || 'Untitled', children: node.children.map(branchToTasks) }
}

/** Plain data for the JSON export. */
export function mapView(title, nodes, links) {
  const tree = mapTree(nodes, title)
  const strip = (n) => ({
    id: n.id,
    text: n.text,
    ...(n.note ? { note: n.note } : {}),
    ...(n.image ? { image: n.image } : {}),
    ...(n.color ? { color: n.color } : {}),
    children: n.children.map(strip),
  })
  const ls = []
  each(links, (m, id) => ls.push({ id, from: get(m, 'from'), to: get(m, 'to'), ...(get(m, 'label') ? { label: get(m, 'label') } : {}) }))
  return { root: strip(tree.root), loose: tree.loose.map(strip), links: ls }
}
