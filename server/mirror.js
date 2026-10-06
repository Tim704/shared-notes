// Markdown mirror: keeps a human-readable copy of the board on disk.
//
// After the board changes we wait a bit (debounced) and then regenerate
// <exportDir>/ from scratch (the layout is built by shared/serialise.js, which
// the browser's own offline backup uses too):
//   <tab-slug>/<title-slug>--<id>.md   one file per note (trash excluded)
//   <tab-slug>/sketch.svg               one file per sketch tab
//   index.json                          what is where
//   README.md                           what this folder is
// Anything else in the folder (except .git, which server/history.js owns) is
// removed, so the folder always reflects the live board.

import fs from 'fs'
import path from 'path'
import { buildMirror } from '../shared/serialise.js'

// re-exported for server/api.js, server/history.js and the tests
export {
  tabRec,
  text,
  slugify,
  deltaToMarkdown,
  noteToMarkdown,
  parseNoteMarkdown,
  sketchToSvg,
  buildMirror,
} from '../shared/serialise.js'

/**
 * Write the file set to exportDir and remove anything else (never `.git`).
 * Files whose content is unchanged are left alone (kinder to SD cards, and
 * keeps git diffs honest). Returns the number of files written.
 */
export async function writeMirror(exportDir, files) {
  const fsp = fs.promises
  await fsp.mkdir(exportDir, { recursive: true })
  const wanted = new Set(Object.keys(files))
  const wantedDirs = new Set()
  for (const rel of wanted) {
    for (let d = path.dirname(rel); d && d !== '.'; d = path.dirname(d)) wantedDirs.add(d)
  }

  let written = 0
  for (const rel of wanted) {
    const abs = path.join(exportDir, rel)
    let current = null
    try {
      current = await fsp.readFile(abs, 'utf8')
    } catch {
      /* new file */
    }
    if (current === files[rel]) continue
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, files[rel])
    written++
  }

  // sweep: delete anything we did not just want
  const sweep = async (relDir) => {
    const abs = path.join(exportDir, relDir)
    let entries
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const rel = relDir ? relDir + '/' + e.name : e.name
      if (rel === '.git') continue
      if (e.isDirectory()) {
        if (wantedDirs.has(rel)) await sweep(rel)
        else await fsp.rm(abs + '/' + e.name, { recursive: true, force: true })
      } else if (!wanted.has(rel)) {
        await fsp.rm(abs + '/' + e.name, { force: true })
      }
    }
  }
  await sweep('')
  return written
}

/**
 * Wire the mirror to a doc. Returns { schedule, flush, stop }.
 *   schedule(): call on every doc change; regenerates `debounceMs` after the last call
 *   flush():    regenerate now (returns a promise)
 *   onWritten(): called after each successful write (history hooks its commit here)
 */
export function createMirror({ ydoc, exportDir, debounceMs = 3000, onWritten = null, mediaPrefix = '' }) {
  let timer = null
  let running = false
  let dirty = false

  async function run() {
    if (running) {
      dirty = true
      return
    }
    running = true
    try {
      const files = buildMirror(ydoc, { mediaPrefix, onError: (m) => console.error('Mirror:', m) }) // sync snapshot of the doc
      const n = await writeMirror(exportDir, files)
      if (n > 0 && onWritten) onWritten(n)
    } catch (err) {
      console.error('Mirror write failed:', err.message)
    } finally {
      running = false
      if (dirty) {
        dirty = false
        schedule()
      }
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      run()
    }, debounceMs)
  }

  return {
    schedule,
    flush: run,
    stop: () => {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
