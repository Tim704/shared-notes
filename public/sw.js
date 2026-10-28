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
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/login' || url.pathname === '/share' || url.pathname.startsWith('/s/')) return
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

// Reminders: the Pi sends one push a day per device (see server/push.js) as
// { title, body, url }; tapping it opens (or focuses) the board at that place.
self.addEventListener('push', (e) => {
  let msg = {}
  try {
    msg = e.data ? e.data.json() : {}
  } catch {
    msg = { title: 'Shared Notes', body: e.data ? e.data.text() : '' }
  }
  e.waitUntil(
    self.registration.showNotification(msg.title || 'Shared Notes', {
      body: msg.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'notes-reminder',
      data: { url: msg.url || '/' },
    })
  )
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const target = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => new URL(c.url).origin === self.location.origin)
      if (open) return open.navigate(target).then((c) => (c || open).focus()).catch(() => open.focus())
      return self.clients.openWindow(target)
    })
  )
})
