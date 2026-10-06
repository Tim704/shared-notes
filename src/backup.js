// This device's own backup of the board, built in the browser from the local
// copy of the document, so it works with the Pi switched off:
//   - Download now: one Markdown or JSON file.
//   - Auto-save to a folder (Chromium desktop, File System Access API): the same
//     layout as the Pi's data/export mirror, rewritten a few seconds after each
//     change, plus the pictures the notes use in media/.
// Tabs can be left out of this device's backups (a per-device choice); the Pi's
// own mirror and git history always keep everything.

import { buildMirror, exportMarkdown, exportJson } from '../shared/serialise.js'
import { getSettings, setSetting } from './settings.js'

// ---- which tabs this device leaves out -------------------------------------
export function excludedTabs() {
  const v = getSettings().backupExclude
  return new Set(Array.isArray(v) ? v : [])
}
export function isExcluded(tabId) {
  return excludedTabs().has(tabId)
}
export function setExcluded(tabId, on) {
  const s = excludedTabs()
  if (on) s.add(tabId)
  else s.delete(tabId)
  setSetting('backupExclude', Array.from(s))
}

const datestamp = () => new Date().toISOString().slice(0, 10)

// ---- download now ---------------------------------------------------------
export function download(doc, kind) {
  const ex = excludedTabs()
  let content
  let type
  if (kind === 'json') {
    content = JSON.stringify(exportJson(doc, { excludeTabs: ex }), null, 2)
    type = 'application/json'
  } else {
    content = exportMarkdown(doc, { excludeTabs: ex, mediaPrefix: location.origin + '/media/' })
    type = 'text/markdown'
  }
  const blob = new Blob([content], { type: type + ';charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `notes-${datestamp()}.${kind === 'json' ? 'json' : 'md'}`
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    URL.revokeObjectURL(a.href)
    a.remove()
  }, 1000)
  return content.length
}

// ---- tiny IndexedDB key/value store (directory handles can't go in localStorage)
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('shared-notes-backup', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('kv')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function kv(mode, fn) {
  const db = await idb()
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction('kv', mode)
      const r = fn(t.objectStore('kv'))
      t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined)
      t.onerror = () => reject(t.error)
    })
  } finally {
    db.close()
  }
}
const kvGet = (k) => kv('readonly', (s) => s.get(k))
const kvSet = (k, v) => kv('readwrite', (s) => s.put(v, k))
const kvDel = (k) => kv('readwrite', (s) => s.delete(k))

// ---- auto-save to a folder ---------------------------------------------------
export const folderSupported = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'

const MEDIA_RE = /\/media\/([a-f0-9]{64}\.(?:png|jpg|webp|gif|avif))/g

/**
 * createFolderBackup(doc, { onStatus }) → { choose, resume, stop, schedule, status }
 * status: { state: 'off' | 'on' | 'paused' | 'error', folder, lastSaved, error }
 */
export function createFolderBackup(doc, { onStatus = () => {}, debounceMs = 5000 } = {}) {
  let handle = null
  let timer = null
  let running = false
  let again = false
  let written = new Map() // path -> content we last wrote (so unchanged files are skipped)
  let status = { state: 'off', folder: '', lastSaved: 0, error: '' }
  const setStatus = (patch) => {
    status = { ...status, ...patch }
    onStatus(status)
  }

  const onUpdate = () => schedule()

  async function init() {
    if (!folderSupported) return
    try {
      handle = await kvGet('dir')
    } catch {
      handle = null
    }
    if (!handle) return
    let perm = 'prompt'
    try {
      perm = await handle.queryPermission({ mode: 'readwrite' })
    } catch {
      perm = 'denied'
    }
    if (perm === 'granted') start()
    else setStatus({ state: 'paused', folder: handle.name, error: '' })
  }

  function start() {
    setStatus({ state: 'on', folder: handle.name, error: '' })
    doc.off('update', onUpdate)
    doc.on('update', onUpdate)
    run()
  }

  function schedule() {
    if (!handle || status.state !== 'on') return
    clearTimeout(timer)
    timer = setTimeout(run, debounceMs)
  }

  async function dirFor(root, parts, create) {
    let d = root
    for (const p of parts) d = await d.getDirectoryHandle(p, { create })
    return d
  }

  async function writeFile(root, rel, data) {
    const parts = rel.split('/')
    const name = parts.pop()
    const d = await dirFor(root, parts, true)
    const fh = await d.getFileHandle(name, { create: true })
    const w = await fh.createWritable()
    await w.write(data)
    await w.close()
  }

  async function removeFile(root, rel) {
    const parts = rel.split('/')
    const name = parts.pop()
    try {
      const d = await dirFor(root, parts, false)
      await d.removeEntry(name)
      // tidy an emptied tab folder
      if (parts.length) {
        let empty = true
        for await (const _ of d.keys()) {
          empty = false
          break
        }
        if (empty) {
          const parent = await dirFor(root, parts.slice(0, -1), false)
          await parent.removeEntry(parts[parts.length - 1])
        }
      }
    } catch {
      /* already gone */
    }
  }

  async function hasFile(root, rel) {
    const parts = rel.split('/')
    const name = parts.pop()
    try {
      const d = await dirFor(root, parts, false)
      await d.getFileHandle(name)
      return true
    } catch {
      return false
    }
  }

  async function run() {
    if (!handle || status.state !== 'on') return
    if (running) {
      again = true
      return
    }
    running = true
    try {
      const files = buildMirror(doc, { excludeTabs: excludedTabs(), mediaPrefix: '../media/' })
      const prevPaths = new Set((await kvGet('paths').catch(() => null)) || [])
      for (const [rel, content] of Object.entries(files)) {
        if (rel === 'index.json') continue // its timestamp changes every time; write it last, and only when something else did
        if (written.get(rel) === content) continue
        await writeFile(handle, rel, content)
        written.set(rel, content)
      }
      const indexBody = files['index.json'].replace(/"generatedAt": "[^"]*",?\n\s*/, '')
      if (written.get('index.json') !== indexBody) {
        await writeFile(handle, 'index.json', files['index.json'])
        written.set('index.json', indexBody)
      }
      // files we wrote before that are no longer wanted (deleted / excluded notes)
      const now = new Set(Object.keys(files))
      for (const rel of prevPaths) {
        if (!now.has(rel)) {
          await removeFile(handle, rel)
          written.delete(rel)
        }
      }
      await kvSet('paths', Array.from(now))
      // pictures the notes use, so the folder works without the Pi
      const want = new Set()
      for (const c of Object.values(files)) {
        let m
        MEDIA_RE.lastIndex = 0
        while ((m = MEDIA_RE.exec(c))) want.add(m[1])
      }
      for (const name of want) {
        const rel = 'media/' + name
        if (written.has(rel) || (await hasFile(handle, rel))) {
          written.set(rel, true)
          continue
        }
        try {
          const r = await fetch('/media/' + name)
          if (r.ok) {
            await writeFile(handle, rel, await r.blob())
            written.set(rel, true)
          }
        } catch {
          /* Pi unreachable: picked up next time */
        }
      }
      setStatus({ lastSaved: Date.now(), error: '' })
    } catch (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) setStatus({ state: 'paused', error: '' })
      else setStatus({ error: (err && err.message) || 'write failed' })
    } finally {
      running = false
      if (again) {
        again = false
        schedule()
      }
    }
  }

  async function choose() {
    if (!folderSupported) return false
    let h
    try {
      h = await window.showDirectoryPicker({ id: 'shared-notes-backup', mode: 'readwrite' })
    } catch {
      return false // cancelled
    }
    handle = h
    written = new Map()
    await kvSet('dir', h)
    await kvSet('paths', [])
    start()
    return true
  }

  // permission has to be re-granted from a click after a reload
  async function resume() {
    if (!handle) return false
    let perm = 'denied'
    try {
      perm = await handle.requestPermission({ mode: 'readwrite' })
    } catch {
      perm = 'denied'
    }
    if (perm === 'granted') {
      start()
      return true
    }
    return false
  }

  async function stop() {
    clearTimeout(timer)
    doc.off('update', onUpdate)
    handle = null
    written = new Map()
    await kvDel('dir').catch(() => {})
    await kvDel('paths').catch(() => {})
    setStatus({ state: 'off', folder: '', lastSaved: 0, error: '' })
  }

  init()
  return { choose, resume, stop, schedule, runNow: run, status: () => status }
}
