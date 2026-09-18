// Optional shared password. Off unless NOTES_PASSWORD is set, in which case:
//   - GET/POST /login shows and checks a tiny password form
//   - a valid `notes_auth` cookie (HMAC of a fixed string, keyed by the
//     password) is required for everything else, including the WebSocket
//   - `Authorization: Bearer <password>` also works, for scripts and widgets
// The cookie never contains the password itself, and comparisons are
// constant-time.

import crypto from 'crypto'
import express from 'express'

const COOKIE = 'notes_auth'
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60 // one year, seconds
const WRONG_PASSWORD_DELAY_MS = 600

// paths the login page needs (and the health check), always allowed
const OPEN_PATHS = ['/login', '/health', '/site.webmanifest', '/style.css']
const isOpenPath = (p) => OPEN_PATHS.includes(p) || p.startsWith('/favicon')

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}

/** `Cookie:` header -> { name: value }. Only what we need, no dependency. */
function parseCookies(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i === -1) continue
    const k = part.slice(0, i).trim()
    if (!k) continue
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim())
    } catch {
      out[k] = part.slice(i + 1).trim()
    }
  }
  return out
}

const LOGIN_PAGE = (bad) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shared Notes — sign in</title>
<link rel="icon" href="/favicon.svg">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0e1014;
         color: #e6e8ee; font: 15px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  form { width: min(92vw, 340px); padding: 28px 26px; border-radius: 14px; background: #171a21;
         border: 1px solid #262a33; box-shadow: 0 20px 60px rgba(0,0,0,.45); }
  h1 { margin: 0 0 6px; font-size: 20px; font-weight: 600; letter-spacing: .01em; }
  p { margin: 0 0 18px; color: #9aa1ad; font-size: 13px; }
  input { width: 100%; padding: 11px 12px; border-radius: 9px; border: 1px solid #2c313c;
          background: #0e1014; color: #e6e8ee; font: inherit; outline: none; }
  input:focus { border-color: #6c8cff; box-shadow: 0 0 0 3px rgba(108,140,255,.25); }
  button { width: 100%; margin-top: 12px; padding: 11px; border: 0; border-radius: 9px; cursor: pointer;
           background: #6c8cff; color: #0e1014; font: inherit; font-weight: 600; }
  button:hover { background: #82a0ff; }
  .bad { margin: 0 0 12px; padding: 9px 11px; border-radius: 8px; background: rgba(255,107,107,.12);
         border: 1px solid rgba(255,107,107,.35); color: #ff8b8b; font-size: 13px; }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>Shared Notes</h1>
  <p>This board is password protected.</p>
  ${bad ? '<div class="bad">Wrong password</div>' : ''}
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
  <button type="submit">Enter</button>
</form>
</body>
</html>
`

/**
 * Build the auth pieces for a password (or none). Returns:
 *   enabled     whether a password is configured
 *   isAuthed(req)  true when the request carries a valid cookie or bearer token
 *   router      the /login routes (mount before the middleware)
 *   middleware  gate for everything else (mount before static + api)
 */
export function createAuth(password) {
  const enabled = typeof password === 'string' && password.length > 0
  const token = enabled ? crypto.createHmac('sha256', password).update('shared-notes-v1').digest('hex') : ''

  function isAuthed(req) {
    if (!enabled) return true
    const cookie = parseCookies(req.headers.cookie)[COOKIE]
    if (cookie && safeEqual(cookie, token)) return true
    const auth = String(req.headers.authorization || '')
    if (auth.startsWith('Bearer ') && safeEqual(auth.slice(7).trim(), password)) return true
    return false
  }

  const router = express.Router()
  if (enabled) {
    router.get('/login', (req, res) => {
      if (isAuthed(req)) return res.redirect('/')
      res.type('html').send(LOGIN_PAGE(req.query.bad === '1'))
    })
    router.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
      const given = req.body && typeof req.body.password === 'string' ? req.body.password : ''
      if (!safeEqual(given, password)) {
        setTimeout(() => res.redirect('/login?bad=1'), WRONG_PASSWORD_DELAY_MS)
        return
      }
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
      res.setHeader(
        'Set-Cookie',
        `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}${secure}`
      )
      res.redirect('/')
    })
    router.post('/logout', (_req, res) => {
      res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
      res.redirect('/login')
    })
  }

  function middleware(req, res, next) {
    if (!enabled || isOpenPath(req.path) || isAuthed(req)) return next()
    const wantsHtml = String(req.headers.accept || '').includes('text/html')
    if (wantsHtml && req.method === 'GET') return res.redirect('/login')
    res.status(401).json({ error: 'unauthorized' })
  }

  return { enabled, isAuthed, router, middleware }
}
