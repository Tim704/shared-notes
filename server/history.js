// Git history for the markdown mirror.
//
// If git is installed (and NOTES_HISTORY is not '0'), the export folder is
// turned into a git repo and committed a little while after each mirror
// write. That gives every note a free version history, which the API exposes
// via listVersions() / readVersion(). All git work is async (execFile) and
// serialised through one queue, so nothing here blocks the server.

import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { parseNoteMarkdown } from './mirror.js'

let exportDir = null
let available = false
let commitMs = 60000
let commitTimer = null
let committedOnce = false // the first commit after startup happens sooner
let queue = Promise.resolve() // serialises git invocations

const NOTE_ID_RE = /^[A-Za-z0-9_-]+$/
const COMMIT_RE = /^[0-9a-f]{7,40}$/

/** Run git in the export dir. Resolves with stdout; rejects on non-zero exit. */
function git(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      // safe.directory: the bind-mounted data dir may be owned by another uid (Docker)
      ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args],
      {
        cwd: opts.cwd || exportDir,
        timeout: opts.timeout || 30000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout)))
    )
  })
}

/** Queue a git job so two never run at once (git holds an index lock anyway). */
function enqueue(job) {
  const p = queue.then(job, job)
  queue = p.catch(() => {})
  return p
}

/**
 * Set up the repo. Safe to call once at startup; never throws.
 * opts: { exportDir, enabled (default true), commitMs (default 60000) }
 */
export async function initHistory(opts) {
  exportDir = opts.exportDir
  commitMs = Number(opts.commitMs) > 0 ? Number(opts.commitMs) : 60000
  available = false
  if (opts.enabled === false) {
    console.log('History: disabled (NOTES_HISTORY=0)')
    return false
  }
  try {
    await git(['--version'], { cwd: process.cwd() })
  } catch {
    console.log('History: git not found, note versions are disabled')
    return false
  }
  try {
    fs.mkdirSync(exportDir, { recursive: true })
    if (!fs.existsSync(path.join(exportDir, '.git'))) {
      await git(['init', '-q'])
      await git(['config', 'user.name', 'Shared Notes'])
      await git(['config', 'user.email', 'notes@localhost'])
      console.log('History: initialised git repo in', exportDir)
    }
    available = true
    console.log('History: enabled, committing', exportDir, 'at most every', commitMs / 1000, 's')
  } catch (err) {
    console.error('History: could not set up git repo:', err.message)
  }
  return available
}

export function historyAvailable() {
  return available
}

/** Commit whatever is in the export dir now. Silent when there is nothing to commit. */
async function commitNow() {
  await git(['add', '-A'])
  try {
    await git(['diff', '--cached', '--quiet']) // exit 0: nothing staged
    return false
  } catch {
    /* exit 1: there are staged changes, fall through and commit */
  }
  await git(['commit', '-q', '-m', new Date().toISOString()])
  committedOnce = true
  return true
}

/**
 * Called by the mirror after it writes. Debounced: one commit per burst of
 * edits. The very first commit after startup is made after a short delay
 * so a fresh install gets a baseline quickly.
 */
export function scheduleCommit() {
  if (!available) return
  const delay = committedOnce ? commitMs : Math.min(commitMs, 5000)
  if (commitTimer) clearTimeout(commitTimer)
  commitTimer = setTimeout(() => {
    commitTimer = null
    enqueue(commitNow).then(
      (did) => did && console.log('History: committed'),
      (err) => console.error('History: commit failed:', err.message)
    )
  }, delay)
}

/** Versions of one note, newest first: [{ commit, ts (ms), subject }]. */
export async function listVersions(noteId) {
  if (!available || !NOTE_ID_RE.test(String(noteId))) return []
  try {
    const out = await enqueue(() =>
      git(['log', '--format=%H%x09%ct%x09%s', '--', `:(glob)**/*--${noteId}.md`])
    )
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [commit, ct, ...rest] = line.split('\t')
        return { commit, ts: Number(ct) * 1000, subject: rest.join('\t') }
      })
  } catch (err) {
    // a repo with no commits yet makes `git log` exit 128; that is just "no versions"
    if (!/does not have any commits|bad default revision/i.test(err.message)) {
      console.error('History: log failed:', err.message)
    }
    return []
  }
}

/**
 * The note as it was at `commit`, parsed with parseNoteMarkdown, or null
 * if the note did not exist in that commit.
 */
export async function readVersion(noteId, commit) {
  if (!available) return null
  if (!NOTE_ID_RE.test(String(noteId)) || !COMMIT_RE.test(String(commit))) return null
  try {
    return await enqueue(async () => {
      const tree = await git(['ls-tree', '-r', '--name-only', commit])
      const file = tree.split('\n').find((p) => p.endsWith(`--${noteId}.md`))
      if (!file) return null
      const raw = await git(['show', `${commit}:${file}`])
      return { ...parseNoteMarkdown(raw), file }
    })
  } catch (err) {
    // an unknown commit is a plain "not found", not something to log
    if (!/not a valid object name|bad object/i.test(err.message)) {
      console.error('History: read failed:', err.message)
    }
    return null
  }
}
