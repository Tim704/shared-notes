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

/** Is this an address on the public internet (not loopback, LAN, link-local, CGNAT, …)? */
export function isPublicAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 100 && b >= 64 && b <= 127) return false // CGNAT (Tailscale lives here)
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 192 && b === 0) return false
    if (a === 198 && (b === 18 || b === 19)) return false
    return true
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase()
    if (l === '::' || l === '::1') return false
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l)
    if (mapped) return isPublicAddress(mapped[1])
    if (/^f[cd]/.test(l) || /^fe[89ab]/.test(l) || /^ff/.test(l)) return false
    if (l.startsWith('64:ff9b:') || l.startsWith('2001:db8')) return false
    return true
  }
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
export function titleFromHtml(html) {
  const meta = (name) => {
    const re = new RegExp(`<meta\\s[^>]*(?:property|name)\\s*=\\s*["']${name}["'][^>]*>`, 'i')
    const tag = re.exec(html)
    if (!tag) return null
    const c = /content\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag[0])
    return c ? c[2] : null
  }
  const raw = meta('og:title') || meta('twitter:title') || (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || ''
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

function fetchOnce(u, address) {
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
    req.end()
  })
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
  const deadline = Date.now() + TIMEOUT_MS
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const address = await checkHost(u)
    const r = await Promise.race([fetchOnce(u, address), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), Math.max(100, deadline - Date.now())))])
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
}
