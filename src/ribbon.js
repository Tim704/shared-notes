// The ribbon: a Word-style toolbar under the tab bar (desktop). It holds the
// text formatting, the settings of the note being edited and the ink tools,
// so the notes themselves carry no toolbars. Plain DOM; client.js fills it.
//
// createRibbon(el) → { el, group(label, cls), button(...), sep(group), setVisible }
// Buttons never take focus (mousedown is cancelled), so pressing one keeps
// the caret and selection in the note or document being edited.
import { icon } from './icons.js'

export function createRibbon(el) {
  el.addEventListener('mousedown', (e) => {
    if (!e.target.closest('input, select')) e.preventDefault()
  })

  function group(label, cls = '') {
    const g = document.createElement('div')
    g.className = 'rib-group' + (cls ? ' ' + cls : '')
    g.setAttribute('role', 'group')
    g.setAttribute('aria-label', label)
    el.appendChild(g)
    return g
  }

  // button(group, { icon, text, title, onPress, toggle }) → <button>
  function button(g, opts) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'rib-btn' + (opts.cls ? ' ' + opts.cls : '') + (opts.text ? ' has-text' : '')
    if (opts.icon) b.appendChild(icon(opts.icon))
    if (opts.text) {
      const t = document.createElement('span')
      t.textContent = opts.text
      b.appendChild(t)
    }
    b.title = opts.title || opts.text || ''
    b.setAttribute('aria-label', b.title)
    if (opts.toggle) b.setAttribute('aria-pressed', 'false')
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      opts.onPress?.(b, e)
    })
    g.appendChild(b)
    return b
  }

  function sep(g) {
    const s = document.createElement('span')
    s.className = 'rib-sep'
    g.appendChild(s)
    return s
  }

  return {
    el,
    group,
    button,
    sep,
    setVisible(on) {
      el.classList.toggle('shown', !!on)
    },
  }
}

export const setPressed = (b, on) => {
  b.classList.toggle('on', !!on)
  if (b.hasAttribute('aria-pressed')) b.setAttribute('aria-pressed', String(!!on))
}
