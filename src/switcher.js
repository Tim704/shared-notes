import { icon } from './icons.js'
import { trapFocus } from './ui.js'

// ---------------------------------------------------------------------------
// The quick switcher (Ctrl/Cmd+K): type a few letters of a note or tab, Enter
// goes there. Matches where your letters start a word rank first. With no
// match, Enter makes a note with that title.
//
// openSwitcher({ items, onPick, onCreate, placeholder })
//   items()             → [{ label, hint, icon, kind, ... }] (anything you need back)
//   onPick(item, ev)    the chosen item (ev.shiftKey / metaKey for "open large")
//   onCreate(text)      Enter on a query nothing matches (omit to disable)
// ---------------------------------------------------------------------------

/** How well `label` matches the (lower-case) query: 0 = not at all. */
export function matchScore(label, q) {
  const l = String(label || '').toLowerCase()
  if (!q) return 1
  if (l === q) return 100
  if (l.startsWith(q)) return 80
  const words = l.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const qw = q.split(/\s+/).filter(Boolean)
  if (qw.every((w) => words.some((x) => x.startsWith(w)))) return 60
  if (l.includes(q)) return 40
  // letters in order ("gro" → "Groceries", "sl" → "Shopping list")
  let i = 0
  for (const ch of l) if (ch === q[i]) i++
  return i === q.length ? 10 : 0
}

/** Rank items by their label (and their other names). */
export function rank(items, q) {
  const want = q.trim().toLowerCase()
  return items
    .map((it, n) => ({ it, n, s: Math.max(matchScore(it.label, want), ...(it.names || []).map((x) => matchScore(x, want) - 5)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (a.it.weight || 0) - (b.it.weight || 0) || a.n - b.n)
    .map((x) => x.it)
}

let open = null

export function openSwitcher({ items, onPick, onCreate, placeholder = 'Go to a note or tab…', createLabel = 'Create note' }) {
  if (open) open.close()
  const back = document.createElement('div')
  back.className = 'qs-back'
  const box = document.createElement('div')
  box.className = 'qs'
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  box.setAttribute('aria-label', 'Quick switcher')
  const field = document.createElement('div')
  field.className = 'qs-field'
  field.appendChild(icon('search'))
  const input = document.createElement('input')
  input.className = 'qs-input'
  input.type = 'text'
  input.placeholder = placeholder
  input.autocomplete = 'off'
  input.spellcheck = false
  input.setAttribute('aria-label', placeholder)
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-expanded', 'true')
  input.setAttribute('aria-controls', 'qs-list')
  field.appendChild(input)
  const list = document.createElement('div')
  list.className = 'qs-list'
  list.id = 'qs-list'
  list.setAttribute('role', 'listbox')
  const foot = document.createElement('div')
  foot.className = 'qs-foot'
  foot.textContent = '↑↓ to move · Enter to go · Shift+Enter to open large' + (onCreate ? ' · no match: Enter creates it' : '')
  box.append(field, list, foot)
  back.appendChild(box)
  document.body.appendChild(back)
  const release = trapFocus(box)

  const all = items()
  let shown = []
  let index = 0

  const draw = () => {
    const q = input.value
    shown = rank(all, q).slice(0, 40)
    const exact = shown.some((it) => it.label.trim().toLowerCase() === q.trim().toLowerCase())
    if (onCreate && q.trim() && !exact) shown.push({ create: true, label: q.trim() })
    index = Math.min(index, Math.max(0, shown.length - 1))
    list.replaceChildren()
    if (!shown.length) {
      const e = document.createElement('div')
      e.className = 'qs-empty'
      e.textContent = 'Nothing matches.'
      list.appendChild(e)
      return
    }
    shown.forEach((it, i) => {
      const row = document.createElement('div')
      row.className = 'qs-row' + (i === index ? ' on' : '') + (it.create ? ' qs-create' : '')
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(i === index))
      row.id = 'qs-opt-' + i
      const ic = document.createElement('span')
      ic.className = 'qs-icon'
      ic.appendChild(icon(it.create ? 'plus' : it.icon || 'note'))
      const label = document.createElement('span')
      label.className = 'qs-label'
      label.textContent = it.create ? `${createLabel} “${it.label}”` : it.label || 'Untitled'
      row.append(ic, label)
      if (it.hint && !it.create) {
        const h = document.createElement('span')
        h.className = 'qs-hint'
        h.textContent = it.hint
        row.appendChild(h)
      }
      row.addEventListener('mousemove', () => {
        if (index !== i) {
          index = i
          mark()
        }
      })
      row.addEventListener('click', (e) => choose(i, e))
      list.appendChild(row)
    })
    input.setAttribute('aria-activedescendant', 'qs-opt-' + index)
  }
  const mark = () => {
    Array.from(list.children).forEach((r, i) => {
      r.classList.toggle('on', i === index)
      r.setAttribute('aria-selected', String(i === index))
    })
    list.children[index]?.scrollIntoView({ block: 'nearest' })
    input.setAttribute('aria-activedescendant', 'qs-opt-' + index)
  }
  const choose = (i, ev) => {
    const it = shown[i]
    if (!it) return
    close()
    if (it.create) onCreate(it.label)
    else onPick(it, ev || {})
  }
  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!shown.length) return
      index = (index + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length
      mark()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(index, e)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }
  input.addEventListener('input', () => {
    index = 0
    draw()
  })
  input.addEventListener('keydown', onKey)
  back.addEventListener('pointerdown', (e) => {
    if (e.target === back) close()
  })
  function close() {
    if (!back.isConnected) return
    back.remove()
    release()
    open = null
  }
  open = { close }
  draw()
  requestAnimationFrame(() => input.focus())
  return { close, input }
}

export const switcherOpen = () => !!open
