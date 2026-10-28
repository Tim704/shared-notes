// Webhooks: POST to the URLs in NOTES_WEBHOOKS (comma-separated) when a note
// changes, so other tools can react to the board. Changes to one note are
// gathered for a few seconds (NOTES_WEBHOOK_MS, default 5000) and sent as one
// call. With NOTES_WEBHOOK_SECRET set, each call carries
// X-Notes-Signature: sha256=<HMAC of the body>. Failures are logged, never retried.
//
// Body: { event: 'note.created' | 'note.updated' | 'note.trashed' | 'note.restored' | 'note.deleted',
//         at, note: { ...the API's note view, tabId, tabName } | { id } }

import crypto from 'crypto'
import { noteView, tabsOf } from '../shared/serialise.js'

export function parseHooks(env) {
  return String(env || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => {
      try {
        const u = new URL(s)
        return u.protocol === 'https:' || u.protocol === 'http:'
      } catch {
        return false
      }
    })
}

export function createWebhooks({ ydoc, urls, secret = '', delayMs = 5000, log = console, fetchImpl = globalThis.fetch }) {
  if (!urls.length) return { enabled: false, flush: async () => {} }
  const yNotes = ydoc.getMap('notes')
  const state = new Map() // id -> { existed, wasTrashed }
  const pending = new Map() // id -> timer
  const known = new Map() // id -> trashed?
  yNotes.forEach((n, id) => known.set(id, typeof n?.get?.('deleted') === 'number'))

  const fire = async (id) => {
    pending.delete(id)
    const before = state.get(id) || { existed: known.has(id), wasTrashed: known.get(id) === true }
    state.delete(id)
    const n = yNotes.get(id)
    let event
    let note
    if (!n || typeof n.get !== 'function') {
      known.delete(id)
      if (!before.existed) return
      event = 'note.deleted'
      note = { id }
    } else {
      const trashed = typeof n.get('deleted') === 'number'
      known.set(id, trashed)
      if (!before.existed) event = trashed ? null : 'note.created'
      else if (trashed && !before.wasTrashed) event = 'note.trashed'
      else if (!trashed && before.wasTrashed) event = 'note.restored'
      else event = trashed ? null : 'note.updated'
      if (!event) return
      const tab = tabsOf(ydoc).find((t) => t.id === String(n.get('tabId')))
      note = { ...noteView(id, n), tabId: n.get('tabId') == null ? null : String(n.get('tabId')), tabName: tab ? tab.name : null }
    }
    const body = JSON.stringify({ event, at: new Date().toISOString(), note })
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'SharedNotes-Webhook/1' }
    if (secret) headers['X-Notes-Signature'] = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
    await Promise.all(
      urls.map(async (url) => {
        try {
          const ctl = new AbortController()
          const t = setTimeout(() => ctl.abort(), 8000)
          const res = await fetchImpl(url, { method: 'POST', headers, body, signal: ctl.signal })
          clearTimeout(t)
          if (!res.ok) log.error(`Webhook ${url} answered ${res.status}`)
        } catch (err) {
          log.error(`Webhook ${url} failed: ${err.message}`)
        }
      })
    )
  }

  const touch = (id) => {
    if (!state.has(id)) state.set(id, { existed: known.has(id), wasTrashed: known.get(id) === true })
    clearTimeout(pending.get(id))
    const t = setTimeout(() => fire(id), delayMs)
    t.unref?.()
    pending.set(id, t)
  }

  yNotes.observeDeep((events) => {
    const ids = new Set()
    for (const e of events) {
      if (e.target === yNotes) for (const k of e.keysChanged || []) ids.add(k)
      else if (e.path.length) ids.add(String(e.path[0]))
    }
    for (const id of ids) touch(id)
  })

  return {
    enabled: true,
    // send whatever is waiting now (tests, shutdown)
    async flush() {
      const ids = Array.from(pending.keys())
      for (const id of ids) clearTimeout(pending.get(id))
      await Promise.all(ids.map(fire))
    },
  }
}
