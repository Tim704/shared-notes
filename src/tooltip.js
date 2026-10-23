// Hover descriptions. Hovering a control for a moment shows a small bubble with
// its name and, for the features listed in TIPS, one line on what it does.
//
// Controls keep setting `title` as before. The first time the pointer reaches
// one, its title moves to data-tip so the browser's own tooltip doesn't show
// as well. aria-label is left alone, so screen readers are unaffected.
// A control can give its own line with data-tip-desc.
//
// Mouse and trackpad only: touch screens have no hover.

const DELAY = 450

// title → what the feature does (keys match the titles set in the code)
const TIPS = {
  'Add a tab': 'Make a new NotePad, Document, Sketch Pad or Mind map.',
  'New tab': 'Make a new NotePad, Document, Sketch Pad or Mind map.',
  'All tabs (home)': 'Every tab in one place, with who is on each one and search across all of them.',
  'Tab options': 'Rename, change the icon and colour, archive or delete this tab.',
  'Open full screen (or double-click the header)': 'Write in this note full screen, without distractions.',
  'Colour, size, layout & more': 'Paper colour, text size, layout, moving to another tab and history.',
  'More note settings: layout, title, move to tab, history': 'Layout, title, moving to another tab and earlier versions.',
  'Delete note': 'Moves the note to this tab’s trash. You can undo it.',
  'Drag to resize': 'Drag the corner to change the note’s size.',
  'Draw between the notes (D)': 'Draw arrows and sketches in the space between notes.',
  'Eraser: removes whole strokes': 'Touch a stroke to remove it.',
  'Undo your last stroke (Ctrl/Cmd+Z)': 'Takes back the last thing you drew.',
  'Pen colour': 'The colour of the next stroke.',
  'Pen size': 'How thick the next stroke is.',
  'Add a picture (or paste / drop one in)': 'Insert an image. You can also paste or drop one straight in.',
  'Checkbox  (Ctrl/Cmd+Shift+9, or type [] and a space)': 'Turn the line into a tickable to-do.',
  'Bullets, numbers and headings': 'Bulleted or numbered lists and headings.',
  'Collapse / expand (just for you)': 'Fold the note down to its title. Only you see it folded.',
  'Collapse or expand every note on this tab (just for you)': 'Fold every note to its title. Only you see it folded.',
  'Earlier versions of this note': 'See and restore what this note looked like before.',
  'Hide this note without deleting it': 'Archive it: out of the way, but kept.',
  'Show archived and deleted notes': 'Bring back notes you archived or deleted.',
  'Pinned notes come first on phones and in the widget': 'Pinned notes are listed first on phones and in the widget.',
  'Grow with content (no inner scroll)': 'The note gets taller as you type instead of scrolling inside.',
  'Save this colour to favourites': 'Keep this colour in your swatches.',
  'Align: left → centre → right  (Ctrl/Cmd+Shift+L / E / R)': 'Line the text up left, centred or right.',
  'Align left edges': 'Line the selected notes up on their left edges.',
  'Align right edges': 'Line the selected notes up on their right edges.',
  'Align top edges': 'Line the selected notes up along their tops.',
  'Align bottom edges': 'Line the selected notes up along their bottoms.',
  'Align centres (vertical line)': 'Centre the selected notes on one vertical line.',
  'Align middles (horizontal line)': 'Centre the selected notes on one horizontal line.',
  'Space evenly, left to right': 'Even gaps between the selected notes, side to side.',
  'Space evenly, top to bottom': 'Even gaps between the selected notes, top to bottom.',
  'Same width': 'Make the selected notes as wide as each other.',
  'Same height': 'Make the selected notes as tall as each other.',
  'Tidy up into a grid': 'Arrange the selected notes in a neat grid.',
  'Colour the selected notes': 'Give every selected note the same paper colour.',
  'Delete the selected notes (Delete)': 'Move every selected note to the trash. You can undo it.',
  'Clear selection (Esc)': 'Deselect all notes.',
  'Settings & backup': 'Your name, appearance, backups and more.',
  'Change your name': 'The name friends see next to your edits.',
}

export function initTooltips() {
  if (!window.matchMedia || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return
  const tip = document.createElement('div')
  tip.className = 'tip'
  tip.setAttribute('role', 'tooltip')
  tip.hidden = true
  const name = document.createElement('div')
  name.className = 'tip-name'
  const desc = document.createElement('div')
  desc.className = 'tip-desc'
  tip.append(name, desc)
  document.body.appendChild(tip)

  let target = null
  let timer = 0

  const hide = () => {
    clearTimeout(timer)
    target = null
    tip.hidden = true
  }

  function show(el) {
    const label = el.dataset.tip
    if (!label || !el.isConnected) return
    name.textContent = label
    const more = el.dataset.tipDesc || TIPS[label] || ''
    desc.textContent = more
    desc.hidden = !more
    tip.hidden = false
    const r = el.getBoundingClientRect()
    const w = tip.offsetWidth, h = tip.offsetHeight
    let left = r.left + r.width / 2 - w / 2
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
    let top = r.bottom + 8
    if (top + h > window.innerHeight - 8) top = r.top - h - 8
    tip.style.left = Math.round(left) + 'px'
    tip.style.top = Math.round(Math.max(8, top)) + 'px'
  }

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return
    const el = e.target.closest?.('[title], [data-tip]')
    if (el === target) return
    hide()
    if (!el) return
    if (el.hasAttribute('title')) {
      const t = el.getAttribute('title').trim()
      el.removeAttribute('title')
      if (t) el.dataset.tip = t
    }
    if (!el.dataset.tip) return
    target = el
    timer = setTimeout(() => show(el), DELAY)
  })
  document.addEventListener('pointerout', (e) => {
    if (target && !target.contains(e.relatedTarget)) hide()
  })
  document.addEventListener('pointerdown', hide, true)
  document.addEventListener('scroll', hide, true)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide()
  })
}
