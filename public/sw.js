// Service worker: network first, cache as a fallback. Online users always get
// the freshest files (so a deploy is never masked by a stale cache); with the Pi
// unreachable the last good copy of the app shell is served, and the board
// itself comes from IndexedDB (see y-indexeddb in src/client.js).
const CACHE = 'shared-notes-shell-v1'
const SHELL = ['/', '/index.html', '/style.css', '/bundle.js', '/site.webmanifest', '/favicon.svg']

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin) return // fonts etc: let the browser handle it
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/login') return
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {})
        }
        return res
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/') : undefined))
      )
  )
})
