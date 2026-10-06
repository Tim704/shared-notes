// The optional password (NOTES_PASSWORD) guards everything, pictures included.
// Run against a server started with NOTES_PASSWORD=test-pass (see run.mjs).
const PORT = process.env.PORT || 3809
const HTTP = `http://127.0.0.1:${PORT}`
const PASS = process.env.NOTES_PASSWORD || 'test-pass'

let failures = 0
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name)
  if (!cond) failures++
}

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
const bearer = { Authorization: 'Bearer ' + PASS }

check('the API refuses without the password', (await fetch(HTTP + '/api/tabs')).status === 401)
check('uploads refuse without the password', (await fetch(HTTP + '/api/media', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).status === 401)
const page = await fetch(HTTP + '/', { headers: { Accept: 'text/html' }, redirect: 'manual' })
check('the page redirects to the login form', page.status === 302 && /\/login/.test(page.headers.get('location') || ''))
check('the install icons load before login', (await fetch(HTTP + '/icon-192.png')).status === 200)
check('a bearer token works for scripts and the widget', (await fetch(HTTP + '/api/tabs', { headers: bearer })).status === 200)
const up = await fetch(HTTP + '/api/media', { method: 'POST', headers: { ...bearer, 'Content-Type': 'image/png' }, body: png })
const { url } = await up.json()
check('an authorised upload works', up.status === 201 && /^\/media\//.test(url))
check('pictures refuse without the password', (await fetch(HTTP + url)).status === 401)
check('pictures load with it', (await fetch(HTTP + url, { headers: bearer })).status === 200)
// the login form sets a cookie that then opens everything
const login = await fetch(HTTP + '/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'password=' + encodeURIComponent(PASS),
  redirect: 'manual',
})
const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
check('logging in sets a cookie', login.status === 302 && /^notes_auth=/.test(cookie))
check('the cookie opens pictures too', (await fetch(HTTP + url, { headers: { Cookie: cookie } })).status === 200)

console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'))
// exitCode rather than exit(): exiting with fetch sockets still open trips a libuv assert on Windows
process.exitCode = failures === 0 ? 0 : 1
