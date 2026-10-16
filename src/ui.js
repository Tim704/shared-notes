// Tiny in-app replacements for window.alert / confirm / prompt, plus a toast
// with an optional action (used for "Deleted · Undo"). Plain DOM, no deps.
import { icon, iconLabel } from './icons.js'

let toastHost = null
let openDialog = null

function h(tag, cls, text) {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text != null) el.textContent = text
  return el
}

// dialog({ title, message, input:{value,placeholder,maxLength}, buttons:[{label,value,primary,danger}] })
// resolves with the chosen button's value (or the input string when the primary
// button is pressed and there is an input). Escape / backdrop click resolve null.
export function dialog(opts) {
  return new Promise((resolve) => {
    if (openDialog) openDialog.close(null)
    const back = h('div', 'dlg-back')
    const box = h('div', 'dlg')
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')
    box.setAttribute('aria-label', opts.title || opts.message || 'Notes')
    if (opts.title) box.appendChild(h('div', 'dlg-title', opts.title))
    if (opts.message) box.appendChild(h('div', 'dlg-msg', opts.message))
    let input = null
    if (opts.input) {
      input = h('input', 'dlg-input')
      input.type = 'text'
      input.value = opts.input.value || ''
      input.placeholder = opts.input.placeholder || ''
      if (opts.input.maxLength) input.maxLength = opts.input.maxLength
      input.autocomplete = 'off'
      input.spellcheck = false
      input.setAttribute('aria-label', opts.title || opts.message || 'Value')
      box.appendChild(input)
    }
    const row = h('div', 'dlg-row')
    const buttons = opts.buttons || [
      { label: 'Cancel', value: null },
      { label: 'OK', value: true, primary: true },
    ]
    let primaryBtn = null
    for (const b of buttons) {
      const btn = h('button', 'dlg-btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), b.label)
      btn.addEventListener('click', () => close(b.primary && input ? input.value : b.value))
      if (b.primary) primaryBtn = btn
      row.appendChild(btn)
    }
    box.appendChild(row)
    back.appendChild(box)

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close(null)
      } else if (e.key === 'Enter' && (input ? document.activeElement === input : true) && primaryBtn) {
        e.preventDefault()
        primaryBtn.click()
      }
    }
    const close = (value) => {
      if (!back.isConnected) return
      document.removeEventListener('keydown', onKey, true)
      back.remove()
      releaseFocus()
      if (openDialog && openDialog.close === close) openDialog = null
      resolve(value)
    }
    openDialog = { close }
    back.addEventListener('pointerdown', (e) => {
      if (e.target === back) close(null)
    })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(back)
    const releaseFocus = trapFocus(box)
    requestAnimationFrame(() => {
      if (input) {
        input.focus()
        input.select()
      } else if (primaryBtn) primaryBtn.focus()
    })
  })
}

export async function confirm(message, opts = {}) {
  const v = await dialog({
    title: opts.title,
    message,
    buttons: [
      { label: opts.cancelLabel || 'Cancel', value: false },
      { label: opts.okLabel || 'OK', value: true, primary: true, danger: !!opts.danger },
    ],
  })
  return v === true
}

export async function prompt(message, value = '', opts = {}) {
  const v = await dialog({
    title: opts.title,
    message,
    input: { value, placeholder: opts.placeholder, maxLength: opts.maxLength },
    buttons: [
      { label: 'Cancel', value: null },
      { label: opts.okLabel || 'OK', value: true, primary: true },
    ],
  })
  return typeof v === 'string' ? v : null
}

// menu(anchor, [{ label, onClick, cls, on, hint } | 'sep' | { head }], { keepFocus, align })
// A small floating menu under `anchor`. With keepFocus, pressing on it never
// takes focus (or the text selection) away from the editor that opened it.
const openMenus = []
export function closeMenus() {
  while (openMenus.length) openMenus.pop()()
}
export function menu(anchor, items, opts = {}) {
  closeMenus()
  const m = h('div', 'menu' + (opts.cls ? ' ' + opts.cls : ''))
  m.addEventListener('click', (e) => e.stopPropagation())
  if (opts.keepFocus) m.addEventListener('mousedown', (e) => e.preventDefault())
  for (const it of items) {
    if (it === 'sep') {
      m.appendChild(h('div', 'menu-sep'))
      continue
    }
    if (it.head) {
      m.appendChild(h('div', 'menu-h', it.head))
      continue
    }
    const b = h('button', 'menu-item' + (it.cls ? ' ' + it.cls : '') + (it.on ? ' on' : ''))
    b.type = 'button'
    const lead = h('span', 'menu-icon')
    if (it.on || it.icon) lead.appendChild(icon(it.on ? 'check' : it.icon))
    b.appendChild(lead)
    b.appendChild(h('span', 'menu-label', it.label))
    if (it.hint) b.appendChild(h('span', 'menu-hint', it.hint))
    b.addEventListener('click', () => {
      closeMenus()
      it.onClick && it.onClick()
    })
    m.appendChild(b)
  }
  document.body.appendChild(m)
  const close = popover(m, anchor, { ...opts, menu: true })
  const dismiss = () => {
    const i = openMenus.indexOf(dismiss)
    if (i >= 0) openMenus.splice(i, 1)
    close()
  }
  openMenus.push(dismiss)
  return dismiss
}

// toast('Note deleted', { action: 'Undo', onAction, ms: 6000 })
export function toast(message, opts = {}) {
  if (!toastHost) {
    toastHost = h('div', 'toasts')
    toastHost.setAttribute('aria-live', 'polite')
    toastHost.setAttribute('aria-relevant', 'additions')
    document.body.appendChild(toastHost)
  }
  const t = h('div', 'toast')
  t.appendChild(icon(opts.action === 'Undo' ? 'undo' : 'check'))
  t.appendChild(h('span', 'toast-msg', message))
  let timer = null
  const remove = () => {
    clearTimeout(timer)
    t.classList.add('out')
    setTimeout(() => t.remove(), 180)
  }
  if (opts.action) {
    const b = h('button', 'toast-act', opts.action)
    b.addEventListener('click', () => {
      remove()
      if (opts.onAction) opts.onAction()
    })
    t.appendChild(b)
  }
  const x = h('button', 'toast-x')
  x.title = 'Dismiss'
  iconLabel(x, '', 'close')
  x.addEventListener('click', remove)
  t.appendChild(x)
  toastHost.appendChild(t)
  let start = null
  t.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') start = { x: e.clientX, y: e.clientY } })
  t.addEventListener('pointerup', e => {
    if (start && (Math.abs(e.clientX - start.x) > 60 || e.clientY - start.y > 40)) remove()
    start = null
  })
  // keep at most three on screen
  while (toastHost.children.length > 3) toastHost.firstChild.remove()
  timer = setTimeout(remove, opts.ms || 5000)
  return remove
}

// Focus stays inside modal surfaces; the opener regains it on dismissal.
export function trapFocus(el) {
  const previous = document.activeElement
  const focusables = () => [...el.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"], [contenteditable="true"]')].filter(n => !n.disabled && n.getClientRects().length)
  const key = e => {
    if (e.key !== 'Tab') return
    const items = focusables()
    if (!items.length) { e.preventDefault(); return }
    const first = items[0], last = items.at(-1)
    if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) { e.preventDefault(); first.focus() }
  }
  el.addEventListener('keydown', key)
  return () => { el.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
}

export function menuKeyboard(el, close, anchor, { keepFocus = false } = {}) {
  el.setAttribute('role', 'menu')
  const items = () => [...el.querySelectorAll('.menu-item')].filter(b => !b.disabled)
  items().forEach(b => { b.setAttribute('role', 'menuitem'); b.tabIndex = -1 })
  let typed = '', timer
  const onKey = e => {
    // An editor retains focus for pointer formatting, but arrows can enter its menu.
    if (!el.isConnected || (!el.contains(document.activeElement) && !keepFocus && document.activeElement !== anchor)) return
    const rows = items(), current = rows.indexOf(document.activeElement)
    let next
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); anchor?.focus({ preventScroll:true }); return }
    if (e.key === 'ArrowDown') next = (current + 1) % rows.length
    else if (e.key === 'ArrowUp') next = (current + rows.length - 1) % rows.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = rows.length - 1
    else if (e.key === 'Enter' && current >= 0) { e.preventDefault(); e.stopPropagation(); rows[current].click(); return }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && el.contains(document.activeElement)) {
      typed += e.key.toLocaleLowerCase(); clearTimeout(timer); timer = setTimeout(() => { typed = '' }, 600)
      next = rows.findIndex(b => b.textContent.trim().toLocaleLowerCase().startsWith(typed))
    }
    if (next != null && next >= 0) { e.preventDefault(); e.stopPropagation(); rows[next]?.focus() }
  }
  document.addEventListener('keydown', onKey, true)
  if (!keepFocus) items()[0]?.focus({ preventScroll: true })
  return () => { clearTimeout(timer); document.removeEventListener('keydown', onKey, true) }
}

export function positionPopover(el, anchor, { align = 'right' } = {}) {
  if (matchMedia('(max-width: 600px)').matches) return
  const r = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight
  const left = Math.max(8, Math.min(align === 'right' ? r.right - w : r.left, innerWidth - w - 8))
  const below = r.bottom + h + 8 < innerHeight
  el.style.left = left + 'px'
  el.style.right = 'auto'
  el.style.top = Math.max(8, below ? r.bottom + 8 : r.top - h - 8) + 'px'
  el.style.setProperty('--anchor-x', Math.max(16, Math.min(w - 16, r.left + r.width / 2 - left)) + 'px')
  el.style.transformOrigin = `var(--anchor-x) ${below ? 'top' : 'bottom'}`
  el.classList.toggle('above-anchor', !below)
}

export function sheet(el, { label = 'Options', close } = {}) {
  el.classList.add('sheet')
  el.setAttribute('aria-label', label)
  const grabber = h('div', 'sheet-grabber'); grabber.setAttribute('aria-hidden', 'true')
  el.prepend(grabber)
  let start
  grabber.addEventListener('pointerdown', e => { start = e.clientY; grabber.setPointerCapture(e.pointerId) })
  grabber.addEventListener('pointerup', e => { if (start != null && e.clientY - start > 50) close?.(); start = null })
  return () => grabber.remove()
}

export function popover(el, anchor, opts = {}) {
  const phone = matchMedia('(max-width: 600px)').matches
  const wasConnected = el.isConnected
  if (!wasConnected) document.body.appendChild(el)
  el.classList.add('open')
  let cleanKeys = () => {}, cleanFocus = () => {}, cleanSheet = () => {}
  let dismissed = false
  const close = () => {
    if (dismissed) return
    dismissed = true
    cleanKeys(); cleanFocus(); cleanSheet()
    window.removeEventListener('resize', position)
    anchor?.setAttribute('aria-expanded', 'false')
    if (opts.retain) el.classList.remove('open')
    else el.remove()
    opts.onClose?.()
  }
  const position = () => positionPopover(el, anchor, opts)
  if (phone) cleanSheet = sheet(el, { label: opts.label, close })
  position()
  window.addEventListener('resize', position)
  anchor?.setAttribute('aria-expanded', 'true')
  anchor?.setAttribute('aria-haspopup', opts.menu ? 'menu' : 'dialog')
  if (opts.menu) cleanKeys = menuKeyboard(el, close, anchor, opts)
  else {
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', opts.label || 'Note options')
    cleanFocus = trapFocus(el)
    const esc = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() } }
    el.addEventListener('keydown', esc)
    cleanKeys = () => el.removeEventListener('keydown', esc)
    // start on the current choice (e.g. the note's colour), not just the first control
    if (!opts.keepFocus) (el.querySelector('button[aria-pressed="true"]') || el.querySelector('button, input, select'))?.focus({ preventScroll: true })
  }
  return close
}

export function segmented(label, choices, value, onChange) {
  const group = h('div', 'segmented')
  group.setAttribute('role', 'group'); group.setAttribute('aria-label', label)
  for (const [key, title] of choices) {
    const b = h('button', 'segment', title); b.type = 'button'; b.dataset.value = key
    b.setAttribute('aria-pressed', String(key === value))
    b.addEventListener('click', () => {
      group.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)))
      onChange(key)
    })
    group.appendChild(b)
  }
  return group
}

// FLIP: read both rectangles once, then animate only transform and opacity.
export function zoomFrom(el, from, { reverse = false } = {}) {
  if (!from?.width || !el.isConnected) return null
  const to = el.getBoundingClientRect()
  if (!to.width) return null
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const transform = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`
  const frames = reduced ? [{ opacity:0 }, { opacity:1 }] : [{ transform, opacity:.4 }, { transform:'none', opacity:1 }]
  if (reverse) frames.reverse()
  const anim = el.animate(frames, { duration:reduced ? 120 : 380, easing:'cubic-bezier(.32,.72,0,1)', fill:'both' })
  // A cancelled animation rejects `finished` with AbortError; callers only ever
  // want "it stopped", so swallow it here rather than at every call site.
  anim.finished.catch(() => {})
  return anim
}
