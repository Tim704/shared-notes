// Runs every suite against a throwaway server (fresh data dir, free port).
// Usage: npm test            (all node suites)
//        npm test -- --browser   (also the headless-Chrome smoke test)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const withBrowser = process.argv.includes('--browser')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(cmd, args, env, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit', ...opts })
    p.on('exit', (code) => resolve(code ?? 1))
  })
}

async function startServer(port, dataDir, extraEnv = {}) {
  const p = spawn('node', ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), NOTES_DATA_DIR: dataDir, NOTES_COMMIT_MS: '2000', NOTES_MIRROR_MS: '500', ...extraEnv },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((resolve) => {
    p.stdout.on('data', (d) => {
      process.stdout.write(d)
      if (String(d).includes('running')) resolve()
    })
  })
  return p
}
const stop = (p) =>
  new Promise((resolve) => {
    if (!p || p.exitCode != null) return resolve()
    p.on('exit', resolve)
    p.kill('SIGTERM')
  })

let failed = 0
let port = 3900 + Math.floor(Math.random() * 500)
for (const suite of ['e2e', 'features', 'api']) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-test-'))
  const srv = await startServer(port, dataDir)
  console.log(`\n=== ${suite} (port ${port}) ===`)
  const code = await run('node', [`test/${suite}.mjs`], { PORT: String(port), NOTES_EXPORT_DIR: path.join(dataDir, 'export') })
  if (code !== 0) failed++
  await stop(srv)
  port++
}

// password protection (a server started with NOTES_PASSWORD)
{
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-test-'))
  const srv = await startServer(port, dataDir, { NOTES_PASSWORD: 'test-pass' })
  console.log(`\n=== auth (port ${port}) ===`)
  const code = await run('node', ['test/auth.mjs'], { PORT: String(port), NOTES_PASSWORD: 'test-pass' })
  if (code !== 0) failed++
  await stop(srv)
  port++
}

// persistence: write, restart the server, read
{
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-test-'))
  console.log(`\n=== persist (port ${port}) ===`)
  let srv = await startServer(port, dataDir)
  let code = await run('node', ['test/persist.mjs', 'write'], { PORT: String(port) })
  await stop(srv)
  srv = await startServer(port, dataDir)
  await sleep(200)
  code = code || (await run('node', ['test/persist.mjs', 'read'], { PORT: String(port) }))
  await stop(srv)
  if (code !== 0) failed++
  port++
}

if (withBrowser) {
  console.log('\n=== browser smoke ===')
  const code = await run('node', ['test/browser-smoke.mjs'])
  if (code !== 0) failed++
}

console.log('\n' + (failed === 0 ? 'ALL SUITES PASSED' : failed + ' SUITE(S) FAILED'))
process.exit(failed === 0 ? 0 : 1)
