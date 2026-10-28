// The title of a web page, for a link pasted into a note (GET /api/unfurl).
// The browser can't read other sites, so the Pi fetches the page. Guarded so it
// can't be used to poke around the Pi's own network: http(s) only, ports 80 and
// 443, every address the name resolves to must be public, redirects are
// re-checked, and only the first 512 KB of HTML is read, for at most 5 seconds.

import dns from 'dns/promises'
import net from 'net'
import http from 'http'
import https from 'https'

const MAX_BYTES = 512 * 1024
const TIMEOUT_MS = 5000
const MAX_REDIRECTS = 3
const cache = new Map() // url -> { title, at }
const CACHE_MS = 60 * 60 * 1000

// Everything that is not the public internet: loopback, private, link-local,
// CGNAT (Tailscale lives there), multicast, reserved, and the IPv6 forms that
// wrap an IPv4 address (compatible, NAT64, 6to4, Teredo). IPv4-mapped IPv6
// (::ffff:a.b.c.d, in any spelling) BlockList checks against the IPv4 rules itself.
const BLOCKED = new net.BlockList()
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) BLOCKED.addSubnet(a, p, 'ipv4')
for (const [a, p] of [
  ['::', 96], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) BLOCKED.addSubnet(a, p, 'ipv6')

/** Is this an address on the public internet (not loopback, LAN, link-local, CGNAT, …)? */
export function isPublicAddress(ip) {
  if (net.isIPv4(ip)) return !BLOCKED.check(ip, 'ipv4')
  if (net.isIPv6(ip)) return !BLOCKED.check(ip, 'ipv6')
  return false
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      } catch {
        return m
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** <meta property="og:title">, else <title>, from a chunk of HTML. */
export function titleFromHtml(input) {
  // only the head matters; bounded patterns, so a hostile page can't make this slow
  let html = String(input || '').slice(0, 64 * 1024)
  const end = html.search(/<\/head>/i)
  if (end >= 0) html = html.slice(0, end)
  const meta = (name) => {
    const re = new RegExp(`<meta\\s[^<>]{0,1024}?(?:property|name)\\s*=\\s*["']${name}["'][^<>]{0,1024}>`, 'i')
    const tag = re.exec(html)
    if (!tag) return null
    const c = /content\s*=\s*(["'])([^"'<>]{0,1024})\1/i.exec(tag[0])
    return c ? c[2] : null
  }
  const at = html.search(/<title[\s>]/i)
  let raw = meta('og:title') || meta('twitter:title') || ''
  if (!raw && at >= 0) {
    const open = html.indexOf('>', at)
    const close = open >= 0 ? html.slice(open + 1, open + 1 + 2048).search(/<\/title>/i) : -1
    if (close >= 0) raw = html.slice(open + 1, open + 1 + close)
  }
  const t = decodeEntities(raw).replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 200) : null
}

async function checkHost(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http and https')
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('port not allowed')
  if (u.username || u.password) throw new Error('no credentials in links')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true })
  if (!addrs.length || !addrs.every((a) => isPublicAddress(a.address))) throw new Error('not a public address')
  return addrs[0].address
}

function fetchOnce(u, address, signal) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: 'GET',
        // connect to the address we checked, so a second DNS answer can't swap it
        lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address, family: net.isIPv6(address) ? 6 : 4 }]) : cb(null, address, net.isIPv6(address) ? 6 : 4)),
        servername: net.isIP(u.hostname) ? undefined : u.hostname,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SharedNotes link preview)', Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en' },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          return resolve({ redirect: new URL(res.headers.location, u) })
        }
        if (res.statusCode !== 200 || !/html/i.test(String(res.headers['content-type'] || ''))) {
          res.resume()
          return resolve({ html: '' })
        }
        let got = 0
        const chunks = []
        res.on('data', (c) => {
          got += c.length
          chunks.push(c)
          if (got >= MAX_BYTES || /<\/head>/i.test(c.toString('latin1'))) res.destroy()
        })
        const done = () => resolve({ html: Buffer.concat(chunks).toString('utf8') })
        res.on('end', done)
        res.on('close', done)
        res.on('error', done)
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    const abort = () => req.destroy(new Error('timeout'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    req.on('close', () => signal.removeEventListener('abort', abort))
    req.end()
  })
}

// at most two lookups at a time, so slow sites can't tie up the Pi
let active = 0
const queue = []
async function slot(fn) {
  if (active >= 2) {
    if (queue.length >= 20) throw new Error('busy')
    await new Promise((r) => queue.push(r))
  }
  active++
  try {
    return await fn()
  } finally {
    active--
    queue.shift()?.()
  }
}

/** The page title of `url`, or null. Never throws for a bad page; throws for a refused address. */
export async function unfurl(url) {
  let u
  try {
    u = new URL(String(url))
  } catch {
    throw new Error('bad url')
  }
  const key = u.href
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.title
  return slot(async () => {
    const ctl = new AbortController()
    let timer
    const deadline = new Promise((_, rej) => {
      timer = setTimeout(() => {
        ctl.abort()
        rej(new Error('timeout'))
      }, TIMEOUT_MS)
    })
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const address = await Promise.race([checkHost(u), deadline])
        const r = await Promise.race([fetchOnce(u, address, ctl.signal), deadline])
        if (r.redirect) {
          u = r.redirect
          continue
        }
        const title = r.html ? titleFromHtml(r.html) : null
        cache.set(key, { title, at: Date.now() })
        if (cache.size > 500) cache.delete(cache.keys().next().value)
        return title
      }
      return null
    } finally {
      clearTimeout(timer)
      ctl.abort()
    }
  })
}
