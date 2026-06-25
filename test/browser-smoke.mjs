// Real-browser smoke test (headless Chrome via the DevTools Protocol). Loads the
// app, captures console errors / uncaught exceptions, and drives the rich-text
// path (type, then bold a selection) to prove the browser-only code runs.
//
// Dev tool, not part of the standard suite. Run: node test/browser-smoke.mjs
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = 3911
const DBG = 9311
const CHROME =
  process.env.CHROME ||
  ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(
    (p) => fs.existsSync(p)
  )

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name)
  if (!cond) failures++
}

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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-cdp-'))
let server, chrome, ws
const watchdog = setTimeout(async () => {
  console.log('FAIL  watchdog: harness exceeded 35s')
  failures++
  await cleanup()
  process.exit(1)
}, 35000)
watchdog.unref?.()
async function cleanup() {
  try { ws && ws.close() } catch {}
  try { chrome && chrome.kill() } catch {}
  try { server && server.kill() } catch {}
  await sleep(200)
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(path.join(process.cwd(), 'data', 'board.bin'), { force: true }) } catch {}
}

try {
  if (!CHROME) throw new Error('No Chrome/Edge found; set CHROME=path')
  fs.rmSync(path.join(process.cwd(), 'data', 'board.bin'), { force: true })
  server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' })
  await sleep(1000)

  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--hide-scrollbars',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${DBG}`,
      '--remote-allow-origins=*',
      `http://127.0.0.1:${PORT}/`,
    ],
    { stdio: 'ignore' }
  )

  // find the page target
  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250)
    try {
      const list = await (await fetch(`http://127.0.0.1:${DBG}/json`)).json()
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes(`:${PORT}`))
    } catch {
      /* chrome not up yet */
    }
  }
  if (!target) throw new Error('Could not attach to a Chrome page target')

  ws = new WebSocket(target.webSocketDebuggerUrl, {
    perMessageDeflate: false,
    maxPayload: 64 * 1024 * 1024,
    headers: { Origin: `http://127.0.0.1:${DBG}` },
  })
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('ws open timeout')), 8000)
    ws.on('open', () => {
      clearTimeout(to)
      res()
    })
    ws.on('error', (e) => {
      clearTimeout(to)
      rej(e)
    })
    ws.on('unexpected-response', (_req, resp) => {
      clearTimeout(to)
      rej(new Error('ws unexpected-response ' + resp.statusCode))
    })
  })
  const c = cdp(ws)

  const errors = []
  c.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'exception')
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('console.error: ' + m.params.args.map((a) => a.value || a.description || '').join(' '))
    }
  })

  await c.send('Runtime.enable')
  await c.send('Page.enable')
  // Headless can't answer the first-run identity window.prompt(); seed an identity
  // before the bundle runs and auto-dismiss any dialog, then reload cleanly.
  c.on((m) => {
    if (m.method === 'Page.javascriptDialogOpening')
      c.send('Page.handleJavaScriptDialog', { accept: true, promptText: 'Tester' })
  })
  await c.send('Page.addScriptToEvaluateOnNewDocument', {
    source:
      "try{localStorage.setItem('notesUser', JSON.stringify({name:'Tester',color:'#3b82f6'}))}catch(e){}",
  })
  await c.send('Page.reload')
  await sleep(2800) // let it reload, connect, sync, and run migrations

  const evaluate = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
    if (r.error) throw new Error(JSON.stringify(r.error))
    return r.result?.result?.value
  }

  const initial = await evaluate(`(() => {
    return {
      tabs: document.querySelectorAll('#tabs .tab').length,
      tabAdd: !!document.querySelector('#tabs .tab-add'),
      hasAdd: !!document.getElementById('add'),
    }
  })()`)
  check('a tab exists after migration', initial.tabs >= 1)
  check('add-tab control rendered', initial.tabAdd === true)

  // create a note and inspect its structure (reconcile runs on a microtask, so
  // wait a beat after clicking before snapshotting the DOM)
  await evaluate(`document.getElementById('add').click()`)
  await sleep(200)
  const made = await evaluate(`(() => {
    const card = document.querySelector('.card')
    const body = card && card.querySelector('.card-body')
    return {
      cards: document.querySelectorAll('.card').length,
      editable: body && body.getAttribute('contenteditable') === 'true',
      fmtBtns: card ? card.querySelectorAll('.card-fmt .fmt-btn').length : 0,
      optBtn: !!(card && card.querySelector('.icon-btn.opt')),
    }
  })()`)
  check('clicking + Note adds a card', made.cards >= 1)
  check('note body is contentEditable', made.editable === true)
  check('format toolbar has 4 buttons', made.fmtBtns === 4)
  check('options (gear) button present', made.optBtn === true)

  // focus the body and type via the controlled beforeinput path
  await evaluate(`document.querySelector('.card-body').focus()`)
  await c.send('Input.insertText', { text: 'hello world' })
  await sleep(120)
  const typed = await evaluate(`document.querySelector('.card-body').textContent`)
  check('typing fills the body through the controlled editor', typed === 'hello world')

  // select all in the body, then Ctrl+B → expect <strong>
  await evaluate(`(() => {
    const b = document.querySelector('.card-body')
    const r = document.createRange(); r.selectNodeContents(b)
    const s = getSelection(); s.removeAllRanges(); s.addRange(r)
  })()`)
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 })
  await sleep(120)
  const afterBold = await evaluate(`(() => {
    const b = document.querySelector('.card-body')
    return { html: b.innerHTML, text: b.textContent, strong: !!b.querySelector('strong') }
  })()`)
  check('Ctrl+B wraps the selection in <strong>', afterBold.strong === true)
  check('bolding preserves the text', afterBold.text === 'hello world')

  // free corkboard layout: the card is absolutely positioned with a resize grip
  const layout = await evaluate(`(() => {
    const card = document.querySelector('.card')
    return {
      boardFree: document.getElementById('board').classList.contains('free'),
      cardFree: !!(card && card.classList.contains('free')),
      grip: !!(card && card.querySelector('.resize-grip')),
      positioned: !!(card && card.style.left !== '' && card.style.width !== ''),
    }
  })()`)
  check('board is in free (corkboard) layout', layout.boardFree === true)
  check('card is absolutely positioned with a grip', layout.cardFree && layout.grip && layout.positioned)

  // open the options popover
  const popover = await evaluate(`(() => {
    document.querySelector('.card .icon-btn.opt').click()
    return !!document.querySelector('.card-pop.open')
  })()`)
  check('options popover opens', popover === true)

  // an outside click closes the popover
  await evaluate(`document.body.click()`)
  await sleep(60)
  const closed = await evaluate(`!document.querySelector('.card-pop.open')`)
  check('outside click closes the popover', closed === true)

  // convert the note into a checklist via the options popover
  const found = await evaluate(`(() => {
    document.querySelector('.card .icon-btn.opt').click()
    const btn = [...document.querySelectorAll('.card-pop .pop-btn')].find(
      (b) => b.textContent.trim() === 'Checklist'
    )
    if (btn) btn.click()
    return !!btn
  })()`)
  check('checklist toggle found in popover', found === true)
  await sleep(250) // rebuildCard runs on a microtask
  const todoState = await evaluate(`(() => {
    const card = document.querySelector('.card.is-todo')
    return {
      isTodo: !!card,
      hasCheck: !!(card && card.querySelector('.todo-item .todo-check')),
      addBtn: !!(card && card.querySelector('.todo-add')),
    }
  })()`)
  check('note converts to a checklist', todoState.isTodo === true)
  check('checklist has a checkbox item and an add control', todoState.hasCheck && todoState.addBtn)

  // '+ Add item' adds a row
  await evaluate(`document.querySelector('.card.is-todo .todo-add').click()`)
  await sleep(120)
  const rows = await evaluate(`document.querySelectorAll('.card.is-todo .todo-item').length`)
  check('add-item adds a checklist row', rows >= 2)

  check('no console errors or uncaught exceptions', errors.length === 0)
  if (errors.length) errors.slice(0, 8).forEach((e) => console.log('   !! ' + e))
} catch (err) {
  console.log('FAIL  harness: ' + err.message)
  failures++
} finally {
  clearTimeout(watchdog)
  await cleanup()
}

console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'))
process.exit(failures === 0 ? 0 : 1)
