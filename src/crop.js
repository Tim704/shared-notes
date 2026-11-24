// Cropping a picture: an overlay with the whole picture and a frame to drag.
// Nothing is cut out of the file; the result is the kept part in percent of the
// picture (see `cr` in shared/lines.js), so a crop can always be changed or undone.

import * as ui from './ui.js'

const MIN = 5 // percent: the smallest frame, so its handles stay grabbable

/**
 * openCrop(src, current) → Promise of
 *   { x, y, w, h, ratio }  the new crop
 *   'none'                 show the whole picture again
 *   null                   cancelled
 */
export function openCrop(src, current) {
  return new Promise((resolve) => {
    const back = document.createElement('div')
    back.className = 'lightbox cropper'
    back.setAttribute('role', 'dialog')
    back.setAttribute('aria-modal', 'true')
    back.setAttribute('aria-label', 'Crop picture')
    const stage = document.createElement('div')
    stage.className = 'crop-stage'
    const img = document.createElement('img')
    img.src = src
    img.alt = 'The picture being cropped'
    img.draggable = false
    const frame = document.createElement('div')
    frame.className = 'crop-frame'
    frame.tabIndex = 0
    frame.setAttribute('aria-label', 'Crop frame: drag it, or use the arrow keys')
    for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const d = document.createElement('span')
      d.className = 'crop-h crop-' + h
      d.dataset.h = h
      frame.appendChild(d)
    }
    stage.append(img, frame)
    const bar = document.createElement('div')
    bar.className = 'crop-bar'
    const btn = (label, cls, fn) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'dlg-btn ' + cls
      b.textContent = label
      b.addEventListener('click', fn)
      bar.appendChild(b)
      return b
    }
    back.append(stage, bar)

    let r = current ? { x: current.x, y: current.y, w: current.w, h: current.h } : { x: 0, y: 0, w: 100, h: 100 }
    const paint = () => {
      frame.style.left = r.x + '%'
      frame.style.top = r.y + '%'
      frame.style.width = r.w + '%'
      frame.style.height = r.h + '%'
    }
    paint()

    const close = (value) => {
      document.removeEventListener('keydown', onKey, true)
      back.remove()
      releaseFocus()
      resolve(value)
    }
    const done = () => {
      if (r.w > 99.9 && r.h > 99.9) return close(current ? 'none' : null)
      const nw = img.naturalWidth || 1
      const nh = img.naturalHeight || 1
      close({ ...r, ratio: (nw * r.w) / (nh * r.h) })
    }
    btn('Whole picture', 'crop-reset', () => {
      r = { x: 0, y: 0, w: 100, h: 100 }
      paint()
    })
    btn('Cancel', 'crop-cancel', () => close(null))
    const ok = btn('Done', 'primary crop-done', done)

    // drag the frame to move it, a handle to resize it
    frame.addEventListener('pointerdown', (e) => {
      if (e.button) return
      e.preventDefault()
      e.stopPropagation()
      frame.focus()
      const h = e.target.dataset?.h || ''
      const box = img.getBoundingClientRect()
      const start = { ...r }
      const sx = e.clientX
      const sy = e.clientY
      try {
        frame.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      const move = (ev) => {
        const dx = ((ev.clientX - sx) / Math.max(1, box.width)) * 100
        const dy = ((ev.clientY - sy) / Math.max(1, box.height)) * 100
        let { x, y, w, h: hh } = start
        if (!h) {
          x = Math.max(0, Math.min(100 - w, x + dx))
          y = Math.max(0, Math.min(100 - hh, y + dy))
        } else {
          if (h.includes('w')) {
            const nx = Math.max(0, Math.min(start.x + start.w - MIN, start.x + dx))
            w = start.x + start.w - nx
            x = nx
          }
          if (h.includes('e')) w = Math.max(MIN, Math.min(100 - start.x, start.w + dx))
          if (h.includes('n')) {
            const ny = Math.max(0, Math.min(start.y + start.h - MIN, start.y + dy))
            hh = start.y + start.h - ny
            y = ny
          }
          if (h.includes('s')) hh = Math.max(MIN, Math.min(100 - start.y, start.h + dy))
        }
        r = { x, y, w, h: hh }
        paint()
      }
      const up = () => {
        frame.removeEventListener('pointermove', move)
        frame.removeEventListener('pointerup', up)
        frame.removeEventListener('pointercancel', up)
      }
      frame.addEventListener('pointermove', move)
      frame.addEventListener('pointerup', up)
      frame.addEventListener('pointercancel', up)
    })

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close(null)
      } else if (e.key === 'Enter' && !e.target.closest?.('button')) {
        e.preventDefault()
        e.stopPropagation()
        done()
      } else if (e.key.startsWith('Arrow') && document.activeElement === frame) {
        e.preventDefault()
        e.stopPropagation()
        const step = e.shiftKey ? 5 : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        r = { ...r, x: Math.max(0, Math.min(100 - r.w, r.x + dx)), y: Math.max(0, Math.min(100 - r.h, r.y + dy)) }
        paint()
      }
    }
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(back)
    const releaseFocus = ui.trapFocus(back)
    ok.focus()
  })
}
