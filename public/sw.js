// Service worker: network first, cache as a fallback. Online users always get
// the freshest files (so a deploy is never masked by a stale cache); with the Pi
// unreachable the last good copy of the app shell is served, and the board
// itself comes from IndexedDB (see y-indexeddb in src/client.js).
// Pictures (/media/<hash>.<ext>) never change, so they are cache first: once
// seen on a device they keep showing with the Pi off.
const CACHE = 'shared-notes-shell-v5'
const MEDIA = 'shared-notes-media-v1'
const MEDIA_MAX = 300 // pictures kept per device
const SHELL = ['/', '/index.html', '/tokens.css', '/style.css', '/bundle.js', '/site.webmanifest', '/favicon.svg', '/favicon-32.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/fonts/inter-latin-variable.woff2', '/fonts/OFL.txt']

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))).catch(() => {})) // never precache a stale copy
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== MEDIA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

async function trimMedia() {
  const c = await caches.open(MEDIA)
  const keys = await c.keys()
  for (let i = 0; i < keys.length - MEDIA_MAX; i++) await c.delete(keys[i])
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin) return // fonts, YouTube etc: let the browser handle it
  if (url.pathname.startsWith('/media/')) {
    e.respondWith(
      caches.open(MEDIA).then((c) =>
        c.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (res && res.ok && res.type === 'basic') {
                c.put(req, res.clone()).then(trimMedia).catch(() => {})
              }
              return res
            })
        )
      )
    )
    return
  }
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
        caches
          .match(req)
          .then((hit) => hit || caches.match(req, { ignoreSearch: true })) // style.css?v=… offline: any copy will do
          .then((hit) => hit || (req.mode === 'navigate' ? caches.match('/') : undefined))
      )
  )
})
