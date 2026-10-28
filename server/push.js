// Reminders: Web Push from the Pi, with no dependency. Each device that turns
// reminders on sends its push subscription (plus its time zone and the hour it
// wants them); once a day, at that hour on that device's clock, the Pi sends it
// one notification listing what is overdue or due that day: To-do tasks and
// @dated checkboxes in notes. It works with the app closed (on an iPhone the app
// must be added to the home screen first).
//
// The protocol is done by hand with node:crypto: VAPID (RFC 8292) signs who we
// are, and the message is encrypted for the device (RFC 8291, aes128gcm per
// RFC 8188). Keys and subscriptions live in <data>/push.json.

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import https from 'https'
import { tabsOf } from '../shared/serialise.js'
import { taskTree, flatten } from '../shared/tasks.js'
import { noteTodos } from '../shared/links.js'

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url')

// Push services we will post to (a subscription naming any other host is refused,
// so the Pi can't be pointed at arbitrary addresses).
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/i

export function validSubscription(sub) {
  if (!sub || typeof sub !== 'object') return false
  let u
  try {
    u = new URL(String(sub.endpoint))
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || !PUSH_HOSTS.test(u.hostname)) return false
  const k = sub.keys || {}
  return fromB64u(k.p256dh).length === 65 && fromB64u(k.auth).length === 16
}

// ---- VAPID ------------------------------------------------------------------------

export function createVapidKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = privateKey.export({ format: 'jwk' })
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-65) // the uncompressed point
  return { publicKey: b64u(raw), privateJwk: jwk }
}

/** The Authorization header for a push to `endpoint`. */
export function vapidAuth(endpoint, keys, subject, now = Date.now()) {
  const aud = new URL(endpoint).origin
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }))
  const key = crypto.createPrivateKey({ key: keys.privateJwk, format: 'jwk' })
  const sig = crypto.sign('sha256', Buffer.from(header + '.' + payload), { key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${keys.publicKey}`
}

// ---- message encryption (RFC 8291 / RFC 8188 aes128gcm) ---------------------------

const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len))

/**
 * Encrypt `payload` for a subscription's keys ({ p256dh, auth }, base64url).
 * Returns the request body. `opts` (salt, serverKeys) exist for tests.
 */
export function encryptPayload(payload, keys, opts = {}) {
  const uaPublic = fromB64u(keys.p256dh)
  const authSecret = fromB64u(keys.auth)
  const ecdh = crypto.createECDH('prime256v1')
  if (opts.serverPrivate) ecdh.setPrivateKey(opts.serverPrivate)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(uaPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = hkdf(authSecret, shared, keyInfo, 32)
  const salt = opts.salt || crypto.randomBytes(16)
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12)
  const plain = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])]) // 2: the last (only) record
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce)
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
  const rs = Buffer.alloc(4)
  rs.writeUInt32BE(4096)
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body])
}

/** The receiving side (what a browser does): for tests. */
export function decryptPayload(body, uaPrivate, uaPublic, authSecret) {
  const salt = body.subarray(0, 16)
  const idlen = body[20]
  const asPublic = body.subarray(21, 21 + idlen)
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.setPrivateKey(uaPrivate)
  const shared = ecdh.computeSecret(asPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = hkdf(authSecret, shared, keyInfo, 32)
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12)
  const data = body.subarray(21 + idlen)
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(data.subarray(data.length - 16))
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()])
  let end = plain.length - 1
  while (end >= 0 && plain[end] === 0) end--
  return plain.subarray(0, end).toString('utf8') // drop the delimiter (and any padding)
}

function post(endpoint, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(endpoint)
    const req = https.request(
      { method: 'POST', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: { ...headers, 'Content-Length': body.length }, timeout: 10000 },
      (res) => {
        let text = ''
        res.on('data', (c) => (text.length < 2000 ? (text += c) : null))
        res.on('end', () => resolve({ status: res.statusCode, text }))
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(body)
  })
}

// ---- what is due ------------------------------------------------------------------

/** Unticked To-do tasks and note checkboxes due on or before `day`: [{ text, due, where }] */
export function dueItems(ydoc, day) {
  const out = []
  const pages = ydoc.getMap('pages')
  for (const t of tabsOf(ydoc)) {
    if (t.kind !== 'tasks' || t.archived) continue
    const p = pages.get(t.id)
    const items = p && typeof p.get === 'function' ? p.get('items') : null
    if (!items) continue
    for (const { node } of flatten(taskTree(items))) {
      if (!node.done && node.due && node.due <= day) out.push({ text: node.text || 'Untitled task', due: node.due, where: t.name, tabId: t.id })
    }
  }
  for (const x of noteTodos(ydoc)) {
    if (x.done || x.state === '-' || !x.due || x.due > day) continue
    out.push({ text: x.text.replace(/(^|\s)@\d{4}-\d{2}-\d{2}(?![\w-])/g, '$1').trim() || 'Checkbox', due: x.due, where: x.title, noteId: x.kind === 'note' ? x.id : null })
  }
  return out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0))
}

/** The notification for a day: { title, body, url } or null when nothing is due. */
export function digest(ydoc, day) {
  const items = dueItems(ydoc, day)
  if (!items.length) return null
  const overdue = items.filter((i) => i.due < day).length
  const today = items.length - overdue
  const title = [overdue ? `${overdue} overdue` : '', today ? `${today} due today` : ''].filter(Boolean).join(', ')
  const lines = items.slice(0, 5).map((i) => '• ' + i.text + (i.due < day ? ' (overdue)' : ''))
  if (items.length > 5) lines.push(`and ${items.length - 5} more`)
  const tabs = new Set(items.map((i) => i.tabId).filter(Boolean))
  const url = items.length === 1 && items[0].noteId ? '/#note=' + items[0].noteId + '&full' : tabs.size === 1 ? '/#tab=' + [...tabs][0] : '/'
  return { title: title[0].toUpperCase() + title.slice(1), body: lines.join('\n'), url }
}

// ---- local clocks -------------------------------------------------------------------

/** { day: 'YYYY-MM-DD', hour } now in an IANA time zone (falls back to the Pi's). */
export function localNow(tz, now = new Date()) {
  let parts
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  }
  const get = (t) => parts.find((p) => p.type === t)?.value
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 }
}

// ---- the service ----------------------------------------------------------------------

export function createPush({ ydoc, dataDir, subject = 'mailto:notes@localhost', send = post, log = console }) {
  const file = path.join(dataDir, 'push.json')
  let state = { vapid: null, subs: [] }
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    /* first run */
  }
  if (!state.vapid || !state.vapid.publicKey || !state.vapid.privateJwk) {
    state.vapid = createVapidKeys()
    save()
  }
  function save() {
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 })
      fs.renameSync(file + '.tmp', file)
    } catch (err) {
      log.error('Push: could not save subscriptions:', err.message)
    }
  }

  const find = (endpoint) => state.subs.find((s) => s.endpoint === endpoint)

  function subscribe({ subscription, tz, hour, name }) {
    if (!validSubscription(subscription)) throw { status: 400, message: 'not a push subscription this server can use' }
    const h = Math.max(0, Math.min(23, Math.round(Number(hour)) || 0))
    const zone = typeof tz === 'string' && tz.length < 64 ? tz : null
    const now = localNow(zone)
    let s = find(subscription.endpoint)
    if (!s && state.subs.length >= 50) throw { status: 429, message: 'too many devices have reminders on' }
    if (!s) {
      s = { id: crypto.randomBytes(6).toString('hex'), endpoint: subscription.endpoint, created: Date.now() }
      state.subs.push(s)
    }
    s.keys = { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }
    s.tz = zone
    s.hour = h
    s.name = String(name || '').slice(0, 40)
    // turned on after today's hour: start tomorrow (the test button covers "now")
    s.lastSent = now.hour >= h ? now.day : s.lastSent || null
    save()
    return { id: s.id, hour: s.hour, tz: s.tz }
  }

  function unsubscribe(endpoint) {
    const before = state.subs.length
    state.subs = state.subs.filter((s) => s.endpoint !== endpoint)
    if (state.subs.length !== before) save()
    return before !== state.subs.length
  }

  async function sendTo(s, message) {
    const body = encryptPayload(JSON.stringify(message), s.keys)
    const res = await send(
      s.endpoint,
      {
        Authorization: vapidAuth(s.endpoint, state.vapid, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '43200',
        Urgency: 'normal',
      },
      body
    )
    if (res.status === 404 || res.status === 410) {
      unsubscribe(s.endpoint) // the device dropped it
      return { ok: false, gone: true, status: res.status }
    }
    if (res.status < 200 || res.status >= 300) log.error('Push: send failed', res.status, String(res.text || '').slice(0, 200))
    return { ok: res.status >= 200 && res.status < 300, status: res.status }
  }

  async function test(endpoint) {
    const s = find(endpoint)
    if (!s) throw { status: 404, message: 'this device is not subscribed' }
    const now = localNow(s.tz)
    const d = digest(ydoc, now.day)
    return sendTo(s, d ? { ...d, title: 'Test · ' + d.title } : { title: 'Reminders are on', body: `Nothing is due today. You’ll hear from the Pi at ${String(s.hour).padStart(2, '0')}:00 when something is.`, url: '/' })
  }

  let running = false
  async function tick(now = new Date()) {
    if (running) return
    running = true
    try {
      for (const s of state.subs.slice()) {
        const t = localNow(s.tz, now)
        if (t.hour < s.hour || s.lastSent === t.day) continue
        s.lastSent = t.day
        save()
        const d = digest(ydoc, t.day)
        if (!d) continue
        try {
          await sendTo(s, d)
        } catch (err) {
          log.error('Push: send failed:', err.message)
        }
      }
    } finally {
      running = false
    }
  }

  return {
    publicKey: () => state.vapid.publicKey,
    subscribe,
    unsubscribe,
    test,
    tick,
    count: () => state.subs.length,
    start(ms = 60000) {
      const t = setInterval(() => tick().catch((err) => log.error('Push tick failed:', err.message)), ms)
      t.unref()
      return t
    },
  }
}
