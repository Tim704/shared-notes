// The To-do tab's data, shared by the browser (src/tasks.js), the server's
// mirror / exports (shared/serialise.js) and the tests. Pure JS, no imports.
//
// A To-do tab lives in pages[tabId] = Y.Map{ title: Y.Text, items: Y.Map }.
// `items` is FLAT: id -> Y.Map{ text, done, due:'YYYY-MM-DD', status, parent, order, created }.
// `status` is 'doing' while a task is in progress (the Board view's middle column).
// Nesting comes from `parent` (absent = a top-level task) and siblings sort by
// `order`, so indenting or moving an item is one field write that merges cleanly.

const get = (m, k) => (m && typeof m.get === 'function' ? m.get(k) : m ? m[k] : undefined)

/** Every item as a sorted tree: [{ id, text, done, due, children: [...] }]. */
export function taskTree(items) {
  const nodes = new Map()
  const each = (fn) => (items && typeof items.forEach === 'function' ? items.forEach(fn) : Object.entries(items || {}).forEach(([k, v]) => fn(v, k)))
  each((m, id) => {
    if (!m) return
    nodes.set(id, {
      id,
      text: String(get(m, 'text') ?? ''),
      done: get(m, 'done') === true,
      doing: get(m, 'status') === 'doing' && get(m, 'done') !== true,
      due: validDate(get(m, 'due')) ? get(m, 'due') : null,
      parent: get(m, 'parent') || null,
      order: Number(get(m, 'order')) || 0,
      created: Number(get(m, 'created')) || 0,
      children: [],
    })
  })
  const roots = []
  for (const n of nodes.values()) {
    // a missing parent, or a loop, puts the item back at the top level
    const p = n.parent && nodes.get(n.parent)
    if (p && !isAncestor(nodes, n.id, p.id)) p.children.push(n)
    else roots.push(n)
  }
  const sort = (list) => {
    list.sort((a, b) => a.order - b.order || a.created - b.created || (a.id < b.id ? -1 : 1))
    list.forEach((c) => sort(c.children))
    return list
  }
  return sort(roots)
}

function isAncestor(nodes, id, of) {
  // is `id` an ancestor of `of`? (walk up from `of`)
  let cur = nodes.get(of)
  for (let i = 0; cur && i < 1000; i++) {
    if (cur.id === id) return true
    cur = cur.parent ? nodes.get(cur.parent) : null
  }
  return false
}

/** Done / total over the leaf parts under a node (the node itself if it has none). */
export function progress(node) {
  if (!node.children.length) return { done: node.done ? 1 : 0, total: 1 }
  let done = 0, total = 0
  for (const c of node.children) {
    const p = progress(c)
    done += p.done
    total += p.total
  }
  return { done, total }
}

/** Depth-first list of [node, depth, path(titles of ancestors)]. */
export function flatten(tree) {
  const out = []
  const walk = (list, depth, path) => {
    for (const n of list) {
      out.push({ node: n, depth, path })
      walk(n.children, depth + 1, path.concat(n.text || 'Untitled'))
    }
  }
  walk(tree, 0, [])
  return out
}

// ---- dates (local calendar days as 'YYYY-MM-DD') ----

export function validDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}
export function ymd(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
export function addDays(s, n) {
  const d = parseYmd(s)
  d.setDate(d.getDate() + n)
  return ymd(d)
}
/** Whole days from `a` to `b` (both 'YYYY-MM-DD'). */
export function daysBetween(a, b) {
  return Math.round((parseYmd(b) - parseYmd(a)) / 86400000)
}

/** 'overdue' | 'today' | 'soon' (within 2 days) | 'later' | null */
export function dueState(due, today) {
  if (!validDate(due)) return null
  const d = daysBetween(today, due)
  if (d < 0) return 'overdue'
  if (d === 0) return 'today'
  if (d <= 2) return 'soon'
  return 'later'
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Today", "Tomorrow", "Fri", "Oct 30", "2 days overdue". */
export function dueLabel(due, today) {
  if (!validDate(due)) return ''
  const d = daysBetween(today, due)
  if (d < -7) return 'Overdue since ' + shortDate(due, today)
  if (d < -1) return `${-d} days overdue`
  if (d === -1) return 'Yesterday'
  if (d === 0) return 'Today'
  if (d === 1) return 'Tomorrow'
  if (d < 7) return DAYS[parseYmd(due).getDay()]
  return shortDate(due, today)
}
function shortDate(due, today) {
  const dt = parseYmd(due)
  const sameYear = due.slice(0, 4) === today.slice(0, 4)
  return `${MONTHS[dt.getMonth()]} ${dt.getDate()}` + (sameYear ? '' : ` ${dt.getFullYear()}`)
}

/** How many unticked items are overdue or due today (the tab badge). */
export function dueCount(items, today) {
  let n = 0
  for (const { node } of flatten(taskTree(items))) {
    if (node.done) continue
    const s = dueState(node.due, today)
    if (s === 'overdue' || s === 'today') n++
  }
  return n
}

/** A position between two sibling orders (either may be null). */
export function orderBetween(a, b) {
  if (a == null && b == null) return 1
  if (a == null) return b - 1
  if (b == null) return a + 1
  return (a + b) / 2
}

/** The tab as a nested Markdown checklist. */
export function tasksMarkdown(title, items) {
  const out = []
  if (title) out.push(`# ${title}`, '')
  for (const { node, depth } of flatten(taskTree(items))) {
    const due = node.due ? ` (due ${node.due})` : ''
    out.push(`${'  '.repeat(depth)}- [${node.done ? 'x' : node.doing ? '/' : ' '}] ${node.text.replace(/\s*\n\s*/g, ' ')}${due}`)
  }
  return out.join('\n') + '\n'
}

/** Plain-data tree for the JSON export. */
export function tasksView(items) {
  const strip = (n) => ({ id: n.id, text: n.text, done: n.done, ...(n.doing ? { status: 'doing' } : {}), ...(n.due ? { due: n.due } : {}), children: n.children.map(strip) })
  return taskTree(items).map(strip)
}
