// Password locks on tabs, shared by the browser, the server and the tests.
// Pure JS, no imports.
//
// A locked tab carries `lock = { salt, hash }` (hex): the PBKDF2-SHA-256 of its
// password. The lock is a privacy screen, not encryption: the board is one
// shared document that every browser holds in full, so the app hides a locked
// tab's contents until the password is typed on that device, and the REST API
// refuses them without it. Anyone on the board who digs through their own
// browser's storage could still read the tab.

export const LOCK_ITERATIONS = 100000
export const LOCK_BYTES = 32
const HEX = /^[0-9a-f]+$/

const get = (t, k) => (t && typeof t.get === 'function' ? t.get(k) : t ? t[k] : undefined)

/** A tab entry's lock as { salt, hash }, or null when it has none (or a broken one). */
export function lockOf(tab) {
  const l = get(tab, 'lock')
  if (!l || typeof l !== 'object') return null
  const salt = String(l.salt || '')
  const hash = String(l.hash || '')
  return salt.length >= 16 && hash.length === LOCK_BYTES * 2 && HEX.test(salt) && HEX.test(hash) ? { salt, hash } : null
}

/** The ids of every tab that has a lock. */
export function lockedTabIds(ydoc) {
  const out = new Set()
  ydoc.getArray('tabs').forEach((t) => {
    const id = get(t, 'id')
    if (id != null && lockOf(t)) out.add(String(id))
  })
  return out
}

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
export const fromHex = (hex) => new Uint8Array((hex.match(/../g) || []).map((h) => parseInt(h, 16)))

/** Compare two hex strings without stopping at the first difference. */
export function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
