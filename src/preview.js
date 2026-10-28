// ---------------------------------------------------------------------------
// Hover preview for [[links]] (desktop only): rest the pointer on a link for a
// moment and a card shows where it goes, without leaving the note.
//
// initHoverPreview({ describe(href) → { title, hint, lines: [string], color } | null })
// ---------------------------------------------------------------------------

const DELAY = 450

export function initHoverPreview({ describe }) {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return
  let timer = 0
  let card = null
  let anchor = null

  const hide = () => {
    clearTimeout(timer)
    timer = 0
    anchor = null
    if (card) {
      card.remove()
      card = null
    }
  }

  const show = (a) => {
    const info = describe(a.dataset.href)
    if (!info || !a.isConnected) return
    card = document.createElement('div')
    card.className = 'link-preview'
    card.setAttribute('role', 'tooltip')
    if (info.color) card.style.setProperty('--pv-paper', info.color)
    if (info.ink) card.style.setProperty('--pv-ink', info.ink)
    const head = document.createElement('div')
    head.className = 'lp-title'
    head.textContent = info.title || 'Untitled'
    card.appendChild(head)
    if (info.hint) {
      const h = document.createElement('div')
      h.className = 'lp-hint'
      h.textContent = info.hint
      card.appendChild(h)
    }
    const body = document.createElement('div')
    body.className = 'lp-body'
    const lines = (info.lines || []).filter((l) => l != null)
    if (!lines.length) {
      const e = document.createElement('div')
      e.className = 'lp-empty'
      e.textContent = info.empty || 'Nothing written yet.'
      body.appendChild(e)
    }
    for (const l of lines.slice(0, 12)) {
      const p = document.createElement('div')
      p.className = 'lp-line' + (l.cls ? ' ' + l.cls : '')
      p.textContent = typeof l === 'string' ? l : l.text
      body.appendChild(p)
    }
    card.appendChild(body)
    document.body.appendChild(card)
    const r = a.getBoundingClientRect()
    const w = card.offsetWidth
    const h = card.offsetHeight
    const below = r.bottom + 8 + h < innerHeight
    card.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px'
    card.style.top = (below ? r.bottom + 8 : Math.max(8, r.top - h - 8)) + 'px'
  }

  document.addEventListener('mouseover', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a.rb-wiki') : null
    if (a === anchor) return
    hide()
    if (!a) return
    anchor = a
    timer = setTimeout(() => show(a), DELAY)
  })
  document.addEventListener('pointerdown', hide, true)
  document.addEventListener('keydown', hide, true)
  window.addEventListener('scroll', hide, true)
}
