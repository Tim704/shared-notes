// Tiny in-app replacements for window.alert / confirm / prompt, plus a toast
// with an optional action (used for "Deleted · Undo"). Plain DOM, no deps.

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
      if (openDialog && openDialog.close === close) openDialog = null
      resolve(value)
    }
    openDialog = { close }
    back.addEventListener('pointerdown', (e) => {
      if (e.target === back) close(null)
    })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(back)
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

// toast('Note deleted', { action: 'Undo', onAction, ms: 6000 })
export function toast(message, opts = {}) {
  if (!toastHost) {
    toastHost = h('div', 'toasts')
    document.body.appendChild(toastHost)
  }
  const t = h('div', 'toast')
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
  const x = h('button', 'toast-x', '×')
  x.title = 'Dismiss'
  x.addEventListener('click', remove)
  t.appendChild(x)
  toastHost.appendChild(t)
  // keep at most three on screen
  while (toastHost.children.length > 3) toastHost.firstChild.remove()
  timer = setTimeout(remove, opts.ms || 5000)
  return remove
}
