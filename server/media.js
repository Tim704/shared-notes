// Pictures pasted or dropped into notes. Stored content-addressed on disk as
// data/media/<sha256>.<ext> (so the same picture twice costs nothing) and
// served at /media/<file>, behind the same password as everything else. Image
// bytes never go into the shared Y.Doc: a note just holds the /media/… path on
// a line of its own.

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import express from 'express'

const TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}
const FILE_RE = /^[a-f0-9]{64}\.(png|jpg|webp|gif|avif)$/

export function createMedia({ mediaDir, maxBytes }) {
  fs.mkdirSync(mediaDir, { recursive: true })
  const router = express.Router()

  // POST /api/media  (raw image bytes, Content-Type image/*) -> 201 { url }
  router.post(
    '/',
    express.raw({ type: () => true, limit: maxBytes }),
    async (req, res) => {
      try {
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
        const ext = TYPES[type]
        if (!ext) return res.status(415).json({ error: 'images only (png, jpeg, webp, gif, avif)' })
        const buf = req.body
        if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'empty upload' })
        if (!looksLike(buf, ext)) return res.status(415).json({ error: 'that does not look like a ' + ext + ' file' })
        const hash = crypto.createHash('sha256').update(buf).digest('hex')
        const file = `${hash}.${ext}`
        const abs = path.join(mediaDir, file)
        if (!fs.existsSync(abs)) await fs.promises.writeFile(abs, buf)
        else {
          const now = new Date()
          fs.promises.utimes(abs, now, now).catch(() => {}) // fresh again, so the sweeper leaves it alone
        }
        res.status(201).json({ url: '/media/' + file, bytes: buf.length })
      } catch (err) {
        console.error('Media upload failed:', err.message)
        if (!res.headersSent) res.status(500).json({ error: 'upload failed' })
      }
    }
  )
  // body too large etc.
  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    const status = err && err.type === 'entity.too.large' ? 413 : err.status || 500
    if (!res.headersSent) res.status(status).json({ error: status === 413 ? 'too large' : 'upload failed' })
  })

  // GET /media/<file>: immutable, so cache hard
  const serve = express.static(mediaDir, {
    index: false,
    immutable: true,
    maxAge: '365d',
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  })
  const files = (req, res, next) => {
    const name = req.path.replace(/^\//, '')
    if (!FILE_RE.test(name)) return res.status(404).end()
    serve(req, res, next)
  }

  /**
   * Delete pictures no note mentions any more, once they are older than
   * `graceMs` (so a picture uploaded a moment ago and not yet in a note, or one
   * in a note that is in the trash, survives). `referenced` is a Set of file names.
   */
  async function sweep(referenced, graceMs) {
    let removed = 0
    let entries = []
    try {
      entries = await fs.promises.readdir(mediaDir)
    } catch {
      return 0
    }
    const cutoff = Date.now() - graceMs
    for (const name of entries) {
      if (!FILE_RE.test(name) || referenced.has(name)) continue
      try {
        const st = await fs.promises.stat(path.join(mediaDir, name))
        if (st.mtimeMs < cutoff) {
          await fs.promises.rm(path.join(mediaDir, name), { force: true })
          removed++
        }
      } catch {
        /* gone already */
      }
    }
    return removed
  }

  return { router, files, sweep }
}

/** Every /media/<file> a body mentions, across all notes (trash included). */
export function referencedMedia(ydoc) {
  const out = new Set()
  const re = /\/media\/([a-f0-9]{64}\.(?:png|jpg|webp|gif|avif))/g
  ydoc.getMap('notes').forEach((n) => {
    if (!n || typeof n.get !== 'function') return
    for (const k of ['body', 'body2']) {
      const t = n.get(k)
      if (!t) continue
      const s = t.toString()
      let m
      while ((m = re.exec(s))) out.add(m[1])
    }
  })
  return out
}

// Magic numbers, so a renamed text file can't pose as a picture.
function looksLike(buf, ext) {
  const b = (i) => buf[i]
  if (ext === 'png') return b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47
  if (ext === 'jpg') return b(0) === 0xff && b(1) === 0xd8
  if (ext === 'gif') return b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46
  if (ext === 'webp') return buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP'
  if (ext === 'avif') return buf.slice(4, 12).toString('latin1').startsWith('ftyp')
  return false
}
