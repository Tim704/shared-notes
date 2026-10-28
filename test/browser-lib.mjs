// A headless-Chrome harness over the DevTools Protocol (no Puppeteer): starts a
// server on a throwaway data dir and a browser on its page, and hands back
// evaluate / key / type helpers plus the console errors seen. Used by the
// browser suites other than the original smoke test.
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

function cdp(ws) {
  let id = 0
  const pending = new Map()
  const handlers = []
  ws.on('message', (d) => {
    const m = JSON.parse(d)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else handlers.forEach((h) => h(m))
  })
  return {
    send: (method, params = {}) =>
      new Promise((res, rej) => {
        const i = ++id
        const to = setTimeout(() => {
          pending.delete(i)
          rej(new Error('CDP timeout: ' + method))
        }, 8000)
        pending.set(i, (m) => {
          clearTimeout(to)
          res(m)
        })
        ws.send(JSON.stringify({ id: i, method, params }))
      }),
    on: (h) => handlers.push(h),
  }
}

export async function launch({ port, debugPort, env = {} }) {
  const CHROME = process.env.CHROME || CHROMES.find((p) => fs.existsSync(p))
  if (!CHROME) throw new Error('No Chrome/Edge found; set CHROME=path')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-browser-data-'))
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-cdp-'))
  const server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), NOTES_DATA_DIR: dataDir, NOTES_MIRROR_MS: '300', NOTES_COMMIT_MS: '1000', ...env },
    stdio: 'ignore',
  })
  await sleep(1000)
  const chrome = spawn(
    CHROME,
    ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars', '--window-size=1400,900', `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, '--remote-allow-origins=*', `http://127.0.0.1:${port}/`],
    { stdio: 'ignore' }
  )
  let ws = null
  const cleanup = async () => {
    try { ws && ws.close() } catch { /* gone */ }
    try { chrome.kill() } catch { /* gone */ }
    try { server.kill() } catch { /* gone */ }
    await sleep(200)
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* gone */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* gone */ }
  }
  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250)
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes(`:${port}`))
    } catch {
      /* chrome not up yet */
    }
  }
  if (!target) {
    await cleanup()
    throw new Error('Could not attach to a Chrome page target')
  }
  ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024, headers: { Origin: `http://127.0.0.1:${debugPort}` } })
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('ws open timeout')), 8000)
    ws.on('open', () => (clearTimeout(to), res()))
    ws.on('error', (e) => (clearTimeout(to), rej(e)))
  })
  const c = cdp(ws)
  const errors = []
  let nativeDialogs = 0
  c.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'exception')
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map((a) => a.value || a.description || '').join(' '))
    if (m.method === 'Page.javascriptDialogOpening') {
      nativeDialogs++
      c.send('Page.handleJavaScriptDialog', { accept: true, promptText: 'Tester' })
    }
  })
  await c.send('Runtime.enable')
  await c.send('Page.enable')
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: "try{localStorage.setItem('notesUser', JSON.stringify({name:'Tester',color:'#3b82f6'}))}catch(e){}" })
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await c.send('Page.reload')
  await sleep(2800)

  const evaluate = async (expr) => {
    // userGesture: clicks made here count as the user's (history entries, popups, permissions)
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
    if (r.error) throw new Error(JSON.stringify(r.error))
    return r.result?.result?.value
  }
  const rawKey = async (key, code, vk, modifiers = 0, text) => {
    const down = { type: text ? 'keyDown' : 'rawKeyDown', modifiers, key, code, windowsVirtualKeyCode: vk }
    if (text) {
      down.text = text
      down.unmodifiedText = text
    }
    await c.send('Input.dispatchKeyEvent', down)
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key, code, windowsVirtualKeyCode: vk })
  }
  // modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift
  const key = (k, code, vk, modifiers = 0) => rawKey(k, code, vk, modifiers)
  const type = async (text) => {
    for (const ch of text) await c.send('Input.insertText', { text: ch })
    await sleep(40)
  }
  const paste = async (text) => {
    await c.send('Input.insertText', { text })
    await sleep(40)
  }
  const enter = async () => {
    await rawKey('Enter', 'Enter', 13, 0, '\r')
    await sleep(60)
  }
  const backspace = async () => {
    await key('Backspace', 'Backspace', 8)
    await sleep(60)
  }
  return { c, evaluate, key, rawKey, type, paste, enter, backspace, errors, dialogs: () => nativeDialogs, cleanup }
}
