// The To-do tab's data, shared by the browser (src/tasks.js), the server's
// mirror / exports (shared/serialise.js) and the tests. Pure JS, no imports.
//
// A To-do tab lives in pages[tabId] = Y.Map{ title: Y.Text, items: Y.Map }.
// `items` is FLAT: id -> Y.Map{ text, done, due:'YYYY-MM-DD', status, parent, order, created }.
// `status` is 'doing' while a task is in progress (the Board view's middle column).
// Nesting comes from `parent` (absent = a top-level task) and siblings sort by
// `order`, so indenting or moving an item is one field write that merges cleanly.
//
// Several lists in one tab: pages[tabId].lists = Y.Map{ id -> { name, order } }.
// A top-level task says which list it is in with `list`; one without it (or with
// a list that is gone) is in the first list, MAIN_LIST, which always exists and
// may be renamed through lists['main']. Parts follow their top-level task.
//
// Classes ("Calculus", "Physics"): ydoc.getMap('taskClasses') = { id -> { name,
// color } }, one set for the whole board so a class looks the same in every
// To-do tab. A task names its class with `cls`; its parts inherit it unless they
// name their own.

export const MAIN_LIST = 'main'
export const CLASS_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink']

const entriesOf = (m) => {
  const out = []
  if (m && typeof m.forEach === 'function') m.forEach((v, k) => out.push([k, v]))
  else for (const [k, v] of Object.entries(m || {})) out.push([k, v])
  return out
}

/** The tab's lists in order, the first list included: [{ id, name, order }]. */
export function taskLists(lists) {
  const out = []
  let mainName = 'Tasks'
  for (const [id, v] of entriesOf(lists)) {
    const name = String(get(v, 'name') ?? '').trim()
    if (id === MAIN_LIST) {
      if (name) mainName = name
      continue
    }
    if (!v || get(v, 'gone')) continue
    out.push({ id, name: name || 'List', order: Number(get(v, 'order')) || 0 })
  }
  out.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
  return [{ id: MAIN_LIST, name: mainName, order: -Infinity }].concat(out)
}

/** The board's classes by name: [{ id, name, color }]. */
export function taskClasses(classes) {
  const out = []
  for (const [id, v] of entriesOf(classes)) {
    if (!v) continue
    const color = get(v, 'color')
    out.push({ id, name: String(get(v, 'name') ?? '').trim() || 'Class', color: CLASS_COLORS.includes(color) ? color : 'blue' })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))
}

const get = (m, k) => (m && typeof m.get === 'function' ? m.get(k) : m ? m[k] : undefined)

/**
 * Every item as a sorted tree: [{ id, text, done, due, children: [...] }].
 * Each node also carries `list` (its top-level task's list id, MAIN_LIST unless
 * `listIds` knows the one it names), `cls` (its own class) and `classId` (its
 * own or the nearest one above it).
 */
export function taskTree(items, listIds) {
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
      list: typeof get(m, 'list') === 'string' ? get(m, 'list') : null,
      cls: typeof get(m, 'cls') === 'string' && get(m, 'cls') ? get(m, 'cls') : null,
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
  const known = listIds ? new Set(listIds) : null
  const inherit = (n, list, classId) => {
    n.list = list
    n.classId = n.cls || classId || null
    n.children.forEach((c) => inherit(c, list, n.classId))
  }
  for (const r of roots) inherit(r, r.list && r.list !== MAIN_LIST && (!known || known.has(r.list)) ? r.list : MAIN_LIST, null)
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

/**
 * The tab as a nested Markdown checklist. With more than one list, each list is
 * a "## heading"; a task's own class follows its text as [Class].
 */
export function tasksMarkdown(title, items, { lists, classes } = {}) {
  const out = []
  if (title) out.push(`# ${title}`, '')
  const all = taskLists(lists)
  const tree = taskTree(items, all.map((l) => l.id))
  const names = new Map(taskClasses(classes).map((c) => [c.id, c.name]))
  const put = (roots) => {
    for (const { node, depth } of flatten(roots)) {
      const due = node.due ? ` (due ${node.due})` : ''
      const cls = node.cls && names.has(node.cls) ? ` [${names.get(node.cls)}]` : ''
      out.push(`${'  '.repeat(depth)}- [${node.done ? 'x' : node.doing ? '/' : ' '}] ${node.text.replace(/\s*\n\s*/g, ' ')}${cls}${due}`)
    }
  }
  if (all.length < 2) put(tree)
  else
    for (const l of all) {
      const roots = tree.filter((n) => n.list === l.id)
      if (!roots.length && l.id === MAIN_LIST) continue
      if (out.length && out[out.length - 1] !== '') out.push('')
      out.push(`## ${l.name}`, '')
      put(roots)
    }
  return out.join('\n') + '\n'
}

/** Plain-data tree for the JSON export. */
export function tasksView(items, { lists, classes } = {}) {
  const all = taskLists(lists)
  const listName = new Map(all.map((l) => [l.id, l.name]))
  const names = new Map(taskClasses(classes).map((c) => [c.id, c.name]))
  const strip = (n, top) => ({
    id: n.id,
    text: n.text,
    done: n.done,
    ...(n.doing ? { status: 'doing' } : {}),
    ...(n.due ? { due: n.due } : {}),
    ...(top && all.length > 1 ? { list: listName.get(n.list) } : {}),
    ...(n.cls && names.has(n.cls) ? { class: names.get(n.cls) } : {}),
    children: n.children.map((c) => strip(c, false)),
  })
  return taskTree(items, all.map((l) => l.id)).map((n) => strip(n, true))
}
