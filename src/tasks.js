import * as Y from 'yjs'
import { icon } from './icons.js'
import * as ui from './ui.js'
import { genId } from './util.js'
import { taskTree, flatten, progress, dueState, dueLabel, ymd, parseYmd, addDays, orderBetween, validDate } from '../shared/tasks.js'

// ---------------------------------------------------------------------------
// The To-do tab: tasks broken into parts (nested as deep as you like), each with
// a tick, an optional due date and, when it has parts, a progress bar over its
// smallest parts. Three views of the same list: List, Week and Month.
//
// Data (see shared/tasks.js): page.get('items') is a flat Y.Map of
// id -> Y.Map{ text, done, due, parent, order, created }.
//
// Typing writes with the TYPE origin and doesn't redraw (that would replace the
// field under the caret); every other change redraws and puts focus back.
// Which tasks are folded, the open view and the "Done" section are per device.
//
// createTasksView(host, page) → { destroy, addTask }
// ---------------------------------------------------------------------------

const TYPE = { tasks: 'type' }
const FOLD_KEY = 'notesTaskFolds'
const DONE_FOLD = 'notesTasksDoneOpen'
const VIEW_KEY = 'notesTasksView'
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const load = (k, fallback) => {
  try {
    const v = JSON.parse(localStorage.getItem(k))
    return v == null ? fallback : v
  } catch {
    return fallback
  }
}
const save = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* storage off: keep it for this session */
  }
}
const el = (tag, cls, text) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}
const today = () => ymd(new Date())
const phone = () => matchMedia('(max-width: 600px)').matches

export function createTasksView(host, page, opts = {}) {
  const tabId = opts.tabId || 'tasks'
  if (!(page.get('items') instanceof Y.Map)) page.doc.transact(() => page.set('items', new Y.Map()))
  const items = page.get('items')
  const doc = page.doc

  const folds = new Set(load(FOLD_KEY, []))
  const doneOpen = load(DONE_FOLD, {})
  const views = load(VIEW_KEY, {})
  let view = ['list', 'week', 'month'].includes(views[tabId]) ? views[tabId] : 'list'
  let month = today().slice(0, 7) // 'YYYY-MM' shown in the Month view
  let pickedDay = null // phone Month view: the day listed under the grid
  let pendingFocus = null // { id, caret } to focus after the next draw
  let flashId = null

  // ---- frame ----
  const root = el('div', 'tasks')
  const head = el('div', 'tasks-head')
  const title = el('input', 'tasks-title')
  title.placeholder = 'To-do'
  title.maxLength = 80
  title.setAttribute('aria-label', 'List title')
  const titleText = page.get('title')
  const syncTitle = () => {
    if (document.activeElement !== title) title.value = titleText ? titleText.toString() : ''
  }
  syncTitle()
  title.addEventListener('input', () => {
    if (!titleText) return
    doc.transact(() => {
      titleText.delete(0, titleText.length)
      titleText.insert(0, title.value)
    }, TYPE)
  })
  titleText?.observe(syncTitle)
  const seg = ui.segmented('View', [['list', 'List'], ['week', 'Week'], ['month', 'Month']], view, (v) => setView(v))
  seg.classList.add('tasks-views')
  head.append(title, seg)
  const body = el('div', 'tasks-body')
  root.append(head, body)
  host.appendChild(root)

  function setView(v) {
    view = v
    views[tabId] = v
    save(VIEW_KEY, views)
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v)))
    draw()
  }

  // ---- data helpers ----
  const node = (id) => items.get(id)
  function siblings(parent) {
    const out = []
    items.forEach((m, id) => {
      if ((m.get('parent') || null) === (parent || null)) out.push({ id, order: Number(m.get('order')) || 0, created: m.get('created') || 0 })
    })
    return out.sort((a, b) => a.order - b.order || a.created - b.created || (a.id < b.id ? -1 : 1))
  }
  // an order for a new sibling right after `afterId` (or at the end)
  function orderAfter(parent, afterId) {
    const sib = siblings(parent)
    if (afterId == null) return orderBetween(sib.length ? sib[sib.length - 1].order : null, null)
    const i = sib.findIndex((s) => s.id === afterId)
    const a = sib[i]?.order ?? null
    const b = sib[i + 1]?.order ?? null
    if (a != null && b != null && b - a < 1e-6) {
      renumber(parent)
      return orderAfter(parent, afterId)
    }
    return orderBetween(a, b)
  }
  function renumber(parent) {
    doc.transact(() => siblings(parent).forEach((s, i) => node(s.id).set('order', i + 1)))
  }
  function create(parent, afterId, extra = {}) {
    const id = genId()
    const m = new Y.Map()
    doc.transact(() => {
      m.set('text', extra.text || '')
      m.set('order', orderAfter(parent, afterId))
      m.set('created', Date.now())
      if (parent) m.set('parent', parent)
      if (extra.due) m.set('due', extra.due)
      items.set(id, m)
    })
    if (parent) setFold(parent, false)
    return id
  }
  function subtree(id) {
    const out = [id]
    for (let i = 0; i < out.length; i++) items.forEach((m, cid) => m.get('parent') === out[i] && out.push(cid))
    return out
  }
  function remove(id, { quiet } = {}) {
    const ids = subtree(id)
    const snap = ids.map((i) => [i, node(i).toJSON()])
    doc.transact(() => ids.forEach((i) => items.delete(i)))
    if (quiet) return
    const label = snap[0][1].text || 'Task'
    ui.toast(`"${label.slice(0, 30)}" deleted` + (ids.length > 1 ? ` with ${ids.length - 1} part${ids.length > 2 ? 's' : ''}` : ''), {
      action: 'Undo',
      ms: 7000,
      onAction: () =>
        doc.transact(() => {
          for (const [i, data] of snap) {
            if (items.has(i)) continue
            const m = new Y.Map()
            for (const [k, v] of Object.entries(data)) m.set(k, v)
            items.set(i, m)
          }
        }),
    })
  }
  async function confirmRemove(id) {
    const n = subtree(id).length - 1
    if (n > 0) {
      const ok = await ui.confirm(`Delete "${node(id).get('text') || 'this task'}" and its ${n} part${n > 1 ? 's' : ''}?`, {
        okLabel: 'Delete',
        danger: true,
      })
      if (!ok) return
    }
    remove(id)
  }
  function toggle(id) {
    const m = node(id)
    if (m) doc.transact(() => (m.get('done') ? m.delete('done') : m.set('done', true)))
  }
  function setDue(id, v) {
    const m = node(id)
    if (m) doc.transact(() => (validDate(v) ? m.set('due', v) : m.delete('due')))
  }
  function indent(id) {
    const m = node(id)
    const sib = siblings(m.get('parent'))
    const i = sib.findIndex((s) => s.id === id)
    if (i <= 0) return
    const newParent = sib[i - 1].id
    const order = orderAfter(newParent, null)
    doc.transact(() => {
      m.set('parent', newParent)
      m.set('order', order)
    })
    setFold(newParent, false)
  }
  function outdent(id) {
    const m = node(id)
    const parent = m.get('parent')
    if (!parent) return
    const grand = node(parent)?.get('parent') || null
    const order = orderAfter(grand, parent)
    doc.transact(() => {
      m.set('order', order)
      if (grand) m.set('parent', grand)
      else m.delete('parent')
    })
  }
  function move(id, dir) {
    const m = node(id)
    const sib = siblings(m.get('parent'))
    const i = sib.findIndex((s) => s.id === id)
    const j = i + dir
    if (j < 0 || j >= sib.length) return
    // land just past the neighbour
    const a = dir < 0 ? sib[j - 1]?.order ?? null : sib[j].order
    const b = dir < 0 ? sib[j].order : sib[j + 1]?.order ?? null
    doc.transact(() => m.set('order', orderBetween(a, b)))
  }
  function setFold(id, on) {
    if (on === folds.has(id)) return
    if (on) folds.add(id)
    else folds.delete(id)
    save(FOLD_KEY, Array.from(folds).slice(-2000))
  }

  // ---- drawing ----
  function draw() {
    const scroll = body.scrollTop
    const focused = document.activeElement?.closest?.('.task-row')
    if (!pendingFocus && focused && body.contains(focused)) {
      const inp = focused.querySelector('.task-text')
      pendingFocus = { id: focused.dataset.id, caret: inp ? inp.selectionStart : null }
    }
    root.dataset.view = view
    body.replaceChildren()
    const tree = taskTree(items)
    if (view === 'week') drawWeek(tree)
    else if (view === 'month') drawMonth(tree)
    else drawList(tree)
    body.scrollTop = scroll
    if (pendingFocus) {
      const inp = body.querySelector(`.task-row[data-id="${pendingFocus.id}"] .task-text`)
      if (inp) {
        inp.focus({ preventScroll: false })
        const c = pendingFocus.caret == null ? inp.value.length : Math.min(pendingFocus.caret, inp.value.length)
        try {
          inp.setSelectionRange(c, c)
        } catch {
          /* not a text input */
        }
      }
      pendingFocus = null
    }
    if (flashId) {
      const row = body.querySelector(`.task-row[data-id="${flashId}"]`)
      if (row) {
        row.scrollIntoView({ block: 'center' })
        row.classList.add('flash')
        setTimeout(() => row.classList.remove('flash'), 1400)
      }
      flashId = null
    }
  }

  const focusRow = (id, caret = null) => {
    pendingFocus = { id, caret }
    draw()
  }

  function dueChip(n, onPick) {
    const t = today()
    const chip = el('button', 'task-due' + (n.due ? '' : ' empty'))
    chip.type = 'button'
    if (n.due) {
      chip.dataset.state = n.done ? 'done' : dueState(n.due, t)
      chip.textContent = dueLabel(n.due, t)
      chip.title = 'Due ' + parseYmd(n.due).toDateString() + ' (click to change)'
    } else {
      chip.appendChild(icon('calendar'))
      chip.title = 'Set a due date'
    }
    chip.setAttribute('aria-label', chip.title)
    const picker = el('input', 'task-date')
    picker.type = 'date'
    picker.tabIndex = -1
    picker.setAttribute('aria-hidden', 'true')
    if (n.due) picker.value = n.due
    picker.addEventListener('change', () => onPick(picker.value || null))
    chip.addEventListener('click', (e) => {
      e.stopPropagation()
      try {
        picker.showPicker()
      } catch {
        picker.focus()
        picker.click()
      }
    })
    const wrap = el('span', 'task-due-wrap')
    wrap.append(chip, picker)
    return wrap
  }

  function check(n) {
    const c = el('input', 'task-check')
    c.type = 'checkbox'
    c.checked = n.done
    c.setAttribute('aria-label', (n.done ? 'Untick ' : 'Tick ') + (n.text || 'task'))
    c.addEventListener('change', () => toggle(n.id))
    return c
  }

  function row(n, depth, host) {
    const r = el('div', 'task-row' + (n.done ? ' done' : '') + (n.children.length ? ' has-parts' : ''))
    r.dataset.id = n.id
    r.style.setProperty('--depth', depth)
    const folded = folds.has(n.id)
    const fold = el('button', 'task-fold')
    fold.type = 'button'
    if (n.children.length) {
      fold.appendChild(icon('right'))
      fold.classList.toggle('open', !folded)
      fold.title = folded ? 'Show parts' : 'Hide parts'
      fold.setAttribute('aria-label', fold.title)
      fold.setAttribute('aria-expanded', String(!folded))
      fold.addEventListener('click', () => {
        setFold(n.id, !folded)
        draw()
      })
    } else fold.disabled = true
    const text = el('input', 'task-text')
    text.value = n.text
    text.placeholder = depth ? 'Part' : 'Task'
    text.maxLength = 300
    text.setAttribute('aria-label', depth ? 'Part' : 'Task')
    text.addEventListener('input', () => {
      const m = node(n.id)
      if (m) doc.transact(() => m.set('text', text.value), TYPE)
    })
    text.addEventListener('keydown', (e) => onKey(e, n, text))
    r.append(fold, check(n), text)
    if (n.children.length) {
      const p = progress(n)
      const prog = el('span', 'task-prog')
      prog.title = `${p.done} of ${p.total} parts done`
      const bar = el('span', 'task-bar')
      const fill = el('span', 'task-fill')
      fill.style.width = (p.total ? (100 * p.done) / p.total : 0) + '%'
      bar.appendChild(fill)
      prog.append(bar, el('span', 'task-count', `${p.done}/${p.total}`))
      r.appendChild(prog)
    }
    r.appendChild(dueChip(n, (v) => setDue(n.id, v)))
    const more = el('button', 'task-more')
    more.type = 'button'
    more.title = 'More'
    more.setAttribute('aria-label', 'More for ' + (n.text || 'task'))
    more.appendChild(icon('more'))
    more.addEventListener('click', (e) => {
      e.stopPropagation()
      ui.menu(
        more,
        [
          { label: 'Add a part', icon: 'plus', onClick: () => focusRow(create(n.id, null)) },
          { label: 'Add a task below', icon: 'plus', onClick: () => focusRow(create(node(n.id).get('parent'), n.id)) },
          { label: 'Set due date…', icon: 'calendar', onClick: () => r.querySelector('.task-due').click() },
          ...(n.due ? [{ label: 'Clear due date', onClick: () => setDue(n.id, null) }] : []),
          'sep',
          { label: 'Move up', onClick: () => move(n.id, -1) },
          { label: 'Move down', onClick: () => move(n.id, 1) },
          { label: 'Indent (make it a part)', onClick: () => indent(n.id) },
          ...(depth ? [{ label: 'Outdent', onClick: () => outdent(n.id) }] : []),
          'sep',
          { label: 'Delete', icon: 'trash', cls: 'danger', onClick: () => confirmRemove(n.id) },
        ],
        { align: 'right' }
      )
    })
    r.appendChild(more)
    host.appendChild(r)
    if (!folded) n.children.forEach((c) => row(c, depth + 1, host))
  }

  // the rows in screen order, for arrow keys and "focus the row above"
  const visibleIds = () => Array.from(body.querySelectorAll('.task-row')).map((r) => r.dataset.id)

  function onKey(e, n, input) {
    const m = node(n.id)
    if (!m) return
    const mod = e.metaKey || e.ctrlKey
    if (e.key === 'Enter' && mod) {
      e.preventDefault()
      pendingFocus = { id: n.id, caret: input.selectionStart }
      toggle(n.id)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (!input.value.trim() && m.get('parent')) {
        // Enter on an empty part steps back out, like a list in a text editor
        pendingFocus = { id: n.id }
        outdent(n.id)
        return
      }
      focusRow(create(m.get('parent'), n.id))
    } else if (e.key === 'Tab') {
      e.preventDefault()
      pendingFocus = { id: n.id, caret: input.selectionStart }
      if (e.shiftKey) outdent(n.id)
      else indent(n.id)
      draw()
    } else if (e.key === 'Backspace' && !input.value && !n.children.length) {
      e.preventDefault()
      const ids = visibleIds()
      const above = ids[ids.indexOf(n.id) - 1]
      remove(n.id, { quiet: true })
      if (above) focusRow(above)
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      pendingFocus = { id: n.id, caret: input.selectionStart }
      move(n.id, e.key === 'ArrowUp' ? -1 : 1)
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const ids = visibleIds()
      const next = ids[ids.indexOf(n.id) + (e.key === 'ArrowUp' ? -1 : 1)]
      if (next) {
        e.preventDefault()
        const inp = body.querySelector(`.task-row[data-id="${next}"] .task-text`)
        inp?.focus()
      }
    }
  }

  function drawList(tree) {
    const open = tree.filter((n) => !n.done)
    const done = tree.filter((n) => n.done)
    const list = el('div', 'task-list')
    open.forEach((n) => row(n, 0, list))
    if (!tree.length) {
      const empty = el('div', 'tasks-empty')
      empty.append(el('div', 'tasks-empty-h', 'Nothing to do yet'), el('div', 'tasks-empty-p', 'Add a task, then press Enter for the next one and Tab to make it a part.'))
      list.appendChild(empty)
    }
    const add = el('button', 'task-add')
    add.type = 'button'
    add.append(icon('plus'), document.createTextNode(tree.length ? 'Add a task' : 'Add your first task'))
    add.addEventListener('click', () => focusRow(create(null, open.length ? open[open.length - 1].id : null)))
    list.appendChild(add)
    body.appendChild(list)
    if (done.length) {
      const isOpen = !!doneOpen[tabId]
      const h = el('button', 'task-done-h')
      h.type = 'button'
      h.setAttribute('aria-expanded', String(isOpen))
      const chev = icon('right')
      chev.classList.toggle('open', isOpen)
      h.append(chev, document.createTextNode(`Done (${done.length})`))
      h.addEventListener('click', () => {
        doneOpen[tabId] = !isOpen
        save(DONE_FOLD, doneOpen)
        draw()
      })
      body.appendChild(h)
      if (isOpen) {
        const dl = el('div', 'task-list task-done-list')
        done.forEach((n) => row(n, 0, dl))
        body.appendChild(dl)
      }
    }
  }

  // jump from the calendar to the item in the list
  function reveal(id) {
    let p = node(id)?.get('parent')
    for (let i = 0; p && i < 100; i++) {
      setFold(p, false)
      p = node(p)?.get('parent')
    }
    let top = id
    for (let i = 0; node(top)?.get('parent') && i < 100; i++) top = node(top).get('parent')
    if (node(top)?.get('done')) {
      doneOpen[tabId] = true
      save(DONE_FOLD, doneOpen)
    }
    flashId = id
    setView('list')
  }

  function dueEntry(f, t, { showDate } = {}) {
    const n = f.node
    const r = el('div', 'task-entry' + (n.done ? ' done' : ''))
    r.dataset.id = n.id
    const txt = el('button', 'task-entry-text')
    txt.type = 'button'
    txt.appendChild(el('span', 'task-entry-name', n.text || 'Untitled'))
    if (f.path.length) txt.appendChild(el('span', 'task-entry-path', f.path.join(' › ')))
    txt.addEventListener('click', () => reveal(n.id))
    r.append(check(n), txt)
    if (n.children.length) {
      const p = progress(n)
      r.appendChild(el('span', 'task-count', `${p.done}/${p.total}`))
    }
    if (showDate) {
      const chip = el('span', 'task-due')
      chip.dataset.state = n.done ? 'done' : dueState(n.due, t)
      chip.textContent = dueLabel(n.due, t)
      r.appendChild(chip)
    }
    return r
  }

  function drawWeek(tree) {
    const t = today()
    const all = flatten(tree).filter((f) => f.node.due)
    const dow = (parseYmd(t).getDay() + 6) % 7 // Monday = 0
    const end = addDays(t, 6 - dow + 7) // the Sunday of next week
    const wrap = el('div', 'task-week')
    const group = (label, entries, cls, showDate) => {
      if (!entries.length) return
      const g = el('section', 'task-day' + (cls ? ' ' + cls : ''))
      g.appendChild(el('h3', 'task-day-h', label))
      entries.forEach((f) => g.appendChild(dueEntry(f, t, { showDate })))
      wrap.appendChild(g)
    }
    group('Overdue', all.filter((f) => !f.node.done && f.node.due < t).sort((a, b) => (a.node.due < b.node.due ? -1 : 1)), 'overdue', true)
    for (let d = t; d <= end; d = addDays(d, 1)) {
      const dt = parseYmd(d)
      const label = (d === t ? 'Today · ' : d === addDays(t, 1) ? 'Tomorrow · ' : '') + `${DOW[(dt.getDay() + 6) % 7]} ${dt.getDate()} ${MONTHS[dt.getMonth()].slice(0, 3)}`
      group(label, all.filter((f) => f.node.due === d), d === t ? 'today' : '')
    }
    if (!wrap.children.length) {
      const empty = el('div', 'tasks-empty')
      empty.append(el('div', 'tasks-empty-h', 'Nothing due in the next two weeks'), el('div', 'tasks-empty-p', 'Give a task a due date and it shows up here.'))
      wrap.appendChild(empty)
    }
    body.appendChild(wrap)
  }

  function drawMonth(tree) {
    const t = today()
    const byDay = new Map()
    for (const f of flatten(tree)) {
      if (!f.node.due) continue
      if (!byDay.has(f.node.due)) byDay.set(f.node.due, [])
      byDay.get(f.node.due).push(f)
    }
    const [y, mo] = month.split('-').map(Number)
    const first = new Date(y, mo - 1, 1)
    const start = addDays(ymd(first), -((first.getDay() + 6) % 7))
    const last = ymd(new Date(y, mo, 0))

    const bar = el('div', 'task-month-bar')
    const nav = (label, ico, fn) => {
      const b = el('button', 'task-nav')
      b.type = 'button'
      if (ico) b.appendChild(icon(ico))
      else b.textContent = label
      b.title = label
      b.setAttribute('aria-label', label)
      b.addEventListener('click', fn)
      return b
    }
    const shift = (n) => {
      const d = new Date(y, mo - 1 + n, 1)
      month = ymd(d).slice(0, 7)
      pickedDay = null
      draw()
    }
    bar.append(
      el('h3', 'task-month-h', `${MONTHS[mo - 1]} ${y}`),
      nav('Previous month', 'back', () => shift(-1)),
      nav('Today', null, () => {
        month = t.slice(0, 7)
        pickedDay = phone() ? t : null
        draw()
      }),
      nav('Next month', 'right', () => shift(1))
    )
    const grid = el('div', 'task-month')
    grid.setAttribute('role', 'grid')
    DOW.forEach((d) => grid.appendChild(el('div', 'task-dow', d)))
    for (let d = start, i = 0; i < 42 && (i % 7 !== 0 || d <= last); d = addDays(d, 1), i++) {
      const cell = el('div', 'task-cell')
      cell.setAttribute('role', 'gridcell')
      if (d.slice(0, 7) !== month) cell.classList.add('other')
      if (d === t) cell.classList.add('today')
      if (d === pickedDay) cell.classList.add('picked')
      cell.appendChild(el('span', 'task-cell-n', String(parseYmd(d).getDate())))
      const list = byDay.get(d) || []
      const chips = el('div', 'task-chips')
      list.slice(0, 3).forEach((f) => {
        const c = el('button', 'task-chip' + (f.node.done ? ' done' : ''))
        c.type = 'button'
        c.dataset.state = f.node.done ? 'done' : dueState(d, t)
        c.textContent = f.node.text || 'Untitled'
        c.title = (f.path.length ? f.path.join(' › ') + ' › ' : '') + (f.node.text || 'Untitled')
        c.addEventListener('click', (e) => {
          e.stopPropagation()
          if (phone()) {
            pickedDay = d
            draw()
          } else reveal(f.node.id)
        })
        chips.appendChild(c)
      })
      if (list.length > 3) {
        const more = el('button', 'task-chip more', `+${list.length - 3} more`)
        more.type = 'button'
        more.addEventListener('click', (e) => {
          e.stopPropagation()
          ui.menu(more, list.map((f) => ({ label: f.node.text || 'Untitled', on: f.node.done, onClick: () => reveal(f.node.id) })))
        })
        chips.appendChild(more)
      }
      cell.appendChild(chips)
      cell.addEventListener('click', () => {
        if (phone()) {
          pickedDay = d
          draw()
          return
        }
        // desktop: a click on an empty part of a day adds a task due that day
        const id = create(null, null, { due: d })
        pendingFocus = { id }
        setView('list')
      })
      cell.title = phone() ? '' : 'Click to add a task due this day'
      grid.appendChild(cell)
    }
    body.append(bar, grid)

    if (phone() && pickedDay) {
      const day = el('section', 'task-day')
      const dt = parseYmd(pickedDay)
      day.appendChild(el('h3', 'task-day-h', `${DOW[(dt.getDay() + 6) % 7]} ${dt.getDate()} ${MONTHS[dt.getMonth()]}`))
      ;(byDay.get(pickedDay) || []).forEach((f) => day.appendChild(dueEntry(f, t)))
      const add = el('button', 'task-add')
      add.type = 'button'
      add.append(icon('plus'), document.createTextNode('Add a task due this day'))
      const due = pickedDay
      add.addEventListener('click', () => {
        const id = create(null, null, { due })
        pendingFocus = { id }
        setView('list')
      })
      day.appendChild(add)
      body.appendChild(day)
    }
  }

  // ---- sync ----
  let raf = 0
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(() => ((raf = 0), draw()))
  }
  const onItems = (events, tr) => {
    if (tr.origin === TYPE && tr.local) return // our own typing: the field already shows it
    schedule()
  }
  items.observeDeep(onItems)
  // the due labels ("Today", "Tomorrow") move on at midnight
  let day = today()
  const tick = setInterval(() => {
    if (today() !== day) {
      day = today()
      schedule()
    }
  }, 60000)
  draw()

  return {
    el: root,
    addTask() {
      if (view !== 'list') setView('list')
      const tree = taskTree(items).filter((n) => !n.done)
      focusRow(create(null, tree.length ? tree[tree.length - 1].id : null))
    },
    destroy() {
      cancelAnimationFrame(raf)
      clearInterval(tick)
      items.unobserveDeep(onItems)
      titleText?.unobserve(syncTitle)
      root.remove()
    },
  }
}
