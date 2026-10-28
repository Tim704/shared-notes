// Read-only links to one note or document: /s/<token>. The token lives on the
// note (or the document tab's page) as `share`; deleting it kills the link.
// Mounted BEFORE the password check, so it opens for anyone with the link, but
// only that one note: the page is rendered here on the server (nothing else of
// the board is sent), and its pictures are served only if that note shows them.

import fs from 'fs'
import path from 'path'
import express from 'express'
import { linesOf, computeMarkers, embedOf, CALLOUTS, TODO_STATES } from '../shared/lines.js'
import { tabsOf } from '../shared/serialise.js'

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/
const MEDIA_RE = /^[A-Za-z0-9_.-]+$/

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const text = (v) => (v == null ? '' : typeof v.toString === 'function' ? v.toString() : String(v))

/** The note or document page carrying this token: { kind, title, bodies, color, edited } | null */
export function findShared(ydoc, token) {
  if (!TOKEN_RE.test(String(token || ''))) return null
  let found = null
  ydoc.getMap('notes').forEach((n) => {
    if (found || !n || typeof n.get !== 'function' || n.get('share') !== token) return
    if (typeof n.get('deleted') === 'number' || n.get('kind') === 'todo') return
    const bodies = [n.get('body')]
    if (n.get('layout') === 'book' && n.get('body2')) bodies.push(n.get('body2'))
    found = { kind: 'note', title: text(n.get('title')).trim(), bodies, color: n.get('color') || '#fff7a8', edited: n.get('lastEditedAt') || n.get('created') || null }
  })
  if (found) return found
  const pages = ydoc.getMap('pages')
  for (const t of tabsOf(ydoc)) {
    if (t.kind !== 'doc') continue
    const p = pages.get(t.id)
    if (p && typeof p.get === 'function' && p.get('share') === token) return { kind: 'doc', title: t.name, bodies: [p.get('body')], color: '#ffffff', edited: p.get('lastEditedAt') || null }
  }
  return null
}

/** Every /media/ file the shared thing shows (the only pictures its link may load). */
function mediaOf(found) {
  const out = new Set()
  for (const b of found.bodies) {
    for (const L of linesOf(b)) {
      const e = embedOf(L.text)
      if (e && e.kind === 'image' && e.src.startsWith('/media/')) out.add(e.src.slice(7))
    }
  }
  return out
}

function runHtml(r) {
  let h = esc(r.text)
  if (!r.marks.href) h = h.replace(/(https?:\/\/[^\s<>"']+)/g, (u) => `<a href="${u}" rel="noopener noreferrer nofollow" target="_blank">${u}</a>`)
  const m = r.marks
  if (m.b) h = `<strong>${h}</strong>`
  if (m.i) h = `<em>${h}</em>`
  if (m.u) h = `<u>${h}</u>`
  if (m.s) h = `<s>${h}</s>`
  if (m.hl) h = `<mark class="hl-${esc(m.hl)}">${h}</mark>`
  if (m.href && /^(https?:|mailto:)/i.test(m.href)) h = `<a href="${esc(m.href)}" rel="noopener noreferrer nofollow" target="_blank">${h}</a>`
  return h
}

/** One body → HTML (lists, checkboxes, headings, callouts, dividers, pictures). */
export function bodyHtml(ytext, mediaBase) {
  const lines = linesOf(ytext)
  const markers = computeMarkers(lines)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i]
    const a = L.attrs || {}
    const ind = (a.lt === 'li' || a.lt === 'todo') && a.ind ? ` style="padding-left:${a.ind * 1.4}em"` : ''
    const al = a.al ? ` data-al="${esc(a.al)}"` : ''
    const emb = embedOf(L.text)
    let inner
    if (emb && emb.kind === 'image') {
      const src = emb.src.startsWith('/media/') ? mediaBase + encodeURIComponent(emb.src.slice(7)) : emb.src
      inner = `<img src="${esc(src)}" alt="" loading="lazy"${a.ew ? ` style="width:${Math.max(10, Math.min(100, Number(a.ew) || 100))}%"` : ''}>`
    } else if (emb) inner = `<a href="${esc(emb.src)}" rel="noopener noreferrer nofollow" target="_blank">${emb.kind === 'youtube' ? '▶ YouTube video' : 'Instagram post'}</a>`
    else inner = L.runs.map(runHtml).join('') || '&nbsp;'
    if (a.lt === 'h') out.push(`<h2${al}>${inner}</h2>`)
    else if (a.lt === 'hr') out.push('<hr>')
    else if (a.lt === 'li') out.push(`<div class="li"${ind}${al}><span class="mk">${esc(markers[i])}</span><span>${inner}</span></div>`)
    else if (a.lt === 'todo') {
      const box = a.done ? '☑' : a.ts === '/' ? '◐' : a.ts === '-' ? '⊘' : a.ts === '>' ? '↷' : '☐'
      const st = a.done ? ' done' : a.ts === '-' ? ' cancelled' : ''
      out.push(`<div class="todo${st}"${ind}${al}><span class="mk" title="${esc(a.done ? 'Done' : TODO_STATES[a.ts] || 'To do')}">${box}</span><span>${inner}</span></div>`)
    } else if (a.lt === 'callout') {
      const kind = CALLOUTS.includes(a.co) ? a.co : 'note'
      out.push(`<div class="co co-${kind}"${al}>${inner}</div>`)
    } else out.push(`<p${al}>${inner}</p>`)
  }
  return out.join('\n')
}

const CSS = `
:root{color-scheme:light dark;--paper:#fff;--ink:#1c1c1e;--dim:#6e6e73;--line:rgba(0,0,0,.12);--link:#0a60c2}
@media (prefers-color-scheme:dark){:root{--ink:#f2f2f7;--dim:#a1a1a6;--line:rgba(255,255,255,.16);--link:#64a8ff}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:#f2f2f7;color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",system-ui,sans-serif}
@media (prefers-color-scheme:dark){body{background:#000}}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}
.sheet{background:var(--paper);border-radius:14px;padding:28px 28px 32px;box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 30px rgba(0,0,0,.06)}
@media (prefers-color-scheme:dark){.sheet{background:#1c1c1e}}
h1{font-size:1.7em;line-height:1.2;margin:0 0 .6em;overflow-wrap:anywhere}
h2{font-size:1.2em;margin:1.1em 0 .3em}
p{margin:.15em 0;overflow-wrap:anywhere}
.li,.todo{display:flex;gap:.5em;margin:.12em 0}.mk{flex:none;min-width:1.1em;color:var(--dim)}
.todo.done>span:last-child,.todo.cancelled>span:last-child{text-decoration:line-through;color:var(--dim)}
.co{border-left:3px solid #0a84ff;background:rgba(10,132,255,.08);padding:.35em .8em;margin:.2em 0;border-radius:4px}
.co-tip{border-color:#30d158;background:rgba(48,209,88,.1)}.co-warning{border-color:#ff9f0a;background:rgba(255,159,10,.1)}
.co-danger{border-color:#ff453a;background:rgba(255,69,58,.1)}.co-quote{border-color:var(--line);background:none;color:var(--dim);font-style:italic}
hr{border:0;border-top:1px solid var(--line);margin:1em 0}
img{max-width:100%;height:auto;border-radius:8px;display:block;margin:.4em 0}
a{color:var(--link)}mark{background:#ffe066;color:#1c1c1e;border-radius:2px}
mark.hl-green{background:#b8f2c2}mark.hl-blue{background:#bfe0ff}mark.hl-pink{background:#ffc8dd}mark.hl-purple{background:#e0ccff}
[data-al=center]{text-align:center;justify-content:center}[data-al=right]{text-align:right;justify-content:flex-end}
.page{margin-top:1.2em;padding-top:1em;border-top:1px dashed var(--line)}
footer{color:var(--dim);font-size:13px;text-align:center;margin-top:18px}
@media print{body{background:#fff}.sheet{box-shadow:none;padding:0}footer{display:none}}
`

function pageHtml(found, token) {
  const base = `/s/${token}/media/`
  const title = found.title || (found.kind === 'doc' ? 'Document' : 'Note')
  const bodies = found.bodies.map((b, i) => `<section class="${i ? 'page' : ''}">${bodyHtml(b, base)}</section>`).join('\n')
  const when = found.edited ? new Date(found.edited).toUTCString().replace(' GMT', ' UTC') : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main><article class="sheet">${found.title ? `<h1>${esc(found.title)}</h1>` : ''}
${bodies}
</article><footer>Shared read-only from Shared Notes${when ? ' · last edited ' + esc(when) : ''}</footer></main></body></html>`
}

export function createShare({ ydoc, mediaDir }) {
  const router = express.Router()
  const headers = (res) => {
    res.set('Cache-Control', 'no-store')
    res.set('X-Robots-Tag', 'noindex, nofollow')
    res.set('Referrer-Policy', 'no-referrer')
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
  }
  const gone = (res) => {
    headers(res)
    res.status(404).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not shared</title><style>${CSS}</style><main><article class="sheet"><h1>This link isn’t shared any more</h1><p>Ask whoever sent it for a new one.</p></article></main>`)
  }
  router.get('/s/:token', (req, res) => {
    const found = findShared(ydoc, req.params.token)
    if (!found) return gone(res)
    headers(res)
    res.type('html').send(pageHtml(found, req.params.token))
  })
  router.get('/s/:token/media/:file', (req, res) => {
    const found = findShared(ydoc, req.params.token)
    const file = String(req.params.file)
    if (!found || !MEDIA_RE.test(file) || !mediaOf(found).has(file)) return res.status(404).end()
    const full = path.join(mediaDir, file)
    if (!fs.existsSync(full)) return res.status(404).end()
    res.set('Cache-Control', 'private, max-age=3600')
    res.sendFile(full)
  })
  return router
}
