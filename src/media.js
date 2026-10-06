// Pictures in notes: shrink big photos in the browser, upload them to the Pi
// (POST /api/media), and show them full size in a lightbox. The note itself
// only stores the returned /media/<hash>.<ext> path on a line of its own.

import * as ui from './ui.js'

const MAX_SIDE = 2000 // px; phone photos are 4000+ and the Pi has an SD card
const MAX_UPLOAD = 8 * 1024 * 1024 // matches the server default (NOTES_MEDIA_MAX_MB)
const RECODE_OVER = 1.5 * 1024 * 1024 // re-encode anything bigger than this even if it is small in pixels

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality))
}

/** A File → a Blob ready to upload (downscaled / re-encoded when worth it). */
export async function prepareImage(file) {
  if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type)) {
    // e.g. HEIC from an iPhone: let the browser decode it if it can
    if (!/^image\//.test(file.type)) throw new Error('not a picture')
  }
  if (file.type === 'image/gif') return file // keep animation
  let bmp = null
  try {
    bmp = await createImageBitmap(file)
  } catch {
    if (/^image\/(png|jpeg|webp|avif)$/.test(file.type)) return file
    throw new Error('this picture format is not supported')
  }
  const big = Math.max(bmp.width, bmp.height)
  if (big <= MAX_SIDE && file.size <= RECODE_OVER && /^image\/(png|jpeg|webp|avif)$/.test(file.type)) {
    bmp.close && bmp.close()
    return file
  }
  const k = Math.min(1, MAX_SIDE / big)
  const w = Math.max(1, Math.round(bmp.width * k))
  const h = Math.max(1, Math.round(bmp.height * k))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close && bmp.close()
  let out = await canvasBlob(canvas, 'image/webp', 0.85)
  if (!out || out.type !== 'image/webp') out = await canvasBlob(canvas, 'image/jpeg', 0.86)
  return out || file
}

/** Upload pictures; resolves with the /media/… URLs that made it. */
export async function uploadImages(files) {
  const urls = []
  for (const f of files) {
    let blob
    try {
      blob = await prepareImage(f)
    } catch (err) {
      ui.toast(`Couldn't use ${f.name || 'that picture'}: ${err.message}`)
      continue
    }
    if (blob.size > MAX_UPLOAD) {
      ui.toast(`${f.name || 'That picture'} is too big (max ${Math.round(MAX_UPLOAD / 1048576)} MB)`)
      continue
    }
    const done = ui.toast('Uploading picture…', { ms: 60000 })
    try {
      const r = await fetch('/api/media', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob })
      const data = await r.json().catch(() => ({}))
      done()
      if (!r.ok || !data.url) {
        ui.toast('Upload failed: ' + (data.error || r.status))
        continue
      }
      urls.push(data.url)
    } catch {
      done()
      ui.toast('Pictures need the Pi. Try again when it is reachable.')
    }
  }
  return urls
}

/** Ask for pictures with the file picker. */
export function pickImages() {
  return new Promise((resolve) => {
    const inp = document.createElement('input')
    inp.type = 'file'
    inp.accept = 'image/*'
    inp.multiple = true
    inp.style.display = 'none'
    inp.addEventListener('change', () => {
      resolve(Array.from(inp.files || []))
      inp.remove()
    })
    document.body.appendChild(inp)
    inp.click()
  })
}

/** Full-size view of a picture. Click, Escape or back closes it. */
export function openLightbox(emb) {
  const src = typeof emb === 'string' ? emb : emb && emb.src
  if (!src) return
  const back = document.createElement('div')
  back.className = 'lightbox'
  const img = document.createElement('img')
  img.src = src
  img.alt = ''
  const open = document.createElement('a')
  open.className = 'lightbox-open'
  open.href = src
  open.target = '_blank'
  open.rel = 'noopener'
  open.textContent = 'Open original ↗'
  open.addEventListener('click', (e) => e.stopPropagation())
  back.append(img, open)
  const close = () => {
    document.removeEventListener('keydown', onKey, true)
    back.remove()
  }
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }
  back.addEventListener('click', close)
  document.addEventListener('keydown', onKey, true)
  document.body.appendChild(back)
}
