// Checking a tab's password on the server (see shared/locks.js for what a lock
// is and is not). Requests name the password in the X-Tab-Password header.

import crypto from 'crypto'
import { lockOf, sameHex, LOCK_ITERATIONS, LOCK_BYTES } from '../shared/locks.js'

export function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), Buffer.from(salt, 'hex'), LOCK_ITERATIONS, LOCK_BYTES, 'sha256').toString('hex')
}

/** A new lock for `password`: { salt, hash }. */
export function makeLock(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  return { salt, hash: hashPassword(password, salt) }
}

// hashing is slow on purpose; remember the answers for the locks we have seen
const seen = new Map() // salt:hash:sha256(password) -> boolean
export function verifyLock(lock, password) {
  if (!lock || !password) return false
  const key = lock.salt + ':' + lock.hash + ':' + crypto.createHash('sha256').update(String(password)).digest('hex')
  if (seen.has(key)) return seen.get(key)
  const ok = sameHex(hashPassword(password, lock.salt), lock.hash)
  if (seen.size > 200) seen.clear()
  seen.set(key, ok)
  return ok
}

/** The ids of the tabs this request may not read: locked, and no matching X-Tab-Password. */
export function closedTabs(ydoc, req) {
  const pw = req ? String(req.headers['x-tab-password'] || '') : ''
  const out = new Set()
  ydoc.getArray('tabs').forEach((t) => {
    const id = t && typeof t.get === 'function' ? t.get('id') : t && t.id
    const lock = lockOf(t)
    if (id != null && lock && !verifyLock(lock, pw)) out.add(String(id))
  })
  return out
}
