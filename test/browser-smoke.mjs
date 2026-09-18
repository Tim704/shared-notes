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
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find((p) => fs.existsSync(p))
// The server under test gets its own throwaway data dir; the real board is never touched.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-smoke-data-'))

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
  console.log('FAIL  watchdog: harness exceeded 90s')
  failures++
  await cleanup()
  process.exit(1)
}, 90000)
watchdog.unref?.()
async function cleanup() {
  try { ws && ws.close() } catch {}
  try { chrome && chrome.kill() } catch {}
  try { server && server.kill() } catch {}
  await sleep(200)
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch {}
}

try {
  if (!CHROME) throw new Error('No Chrome/Edge found; set CHROME=path')
  server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), NOTES_DATA_DIR: DATA_DIR, NOTES_MIRROR_MS: '300', NOTES_COMMIT_MS: '1000' },
    stdio: 'ignore',
  })
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
  let nativeDialogs = 0
  c.on((m) => {
    if (m.method === 'Page.javascriptDialogOpening') {
      nativeDialogs++
      c.send('Page.handleJavaScriptDialog', { accept: true, promptText: 'Tester' })
    }
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

  // ---------------------------------------------------------------- new features
  const key = async (key, code, vk, modifiers = 0) => {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, key, code, windowsVirtualKeyCode: vk })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key, code, windowsVirtualKeyCode: vk })
  }

  // a second, prose note for the editor checks
  await evaluate(`document.getElementById('add').click()`)
  await sleep(200)
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.card:not(.is-todo) .card-body')][0]
    b.focus()
  })()`)
  await c.send('Input.insertText', { text: 'a' })
  await key('Tab', 'Tab', 9)
  await sleep(80)
  await c.send('Input.insertText', { text: 'b' })
  await sleep(80)
  const tabbed = await evaluate(`(() => {
    const b = document.querySelector('.card:not(.is-todo) .card-body')
    return { text: b.textContent, focused: document.activeElement === b }
  })()`)
  check('Tab inserts two spaces and keeps focus in the note', tabbed.text === 'a  b' && tabbed.focused === true)

  // smart arrows: "-" then ">" becomes →, Backspace restores "->"
  await c.send('Input.insertText', { text: ' ' })
  await c.send('Input.insertText', { text: '-' })
  await c.send('Input.insertText', { text: '>' })
  await sleep(80)
  const arrow = await evaluate(`document.querySelector('.card:not(.is-todo) .card-body').textContent`)
  check('typing -> becomes →', arrow === 'a  b →')
  await key('Backspace', 'Backspace', 8)
  await sleep(80)
  const unarrow = await evaluate(`document.querySelector('.card:not(.is-todo) .card-body').textContent`)
  check('Backspace right after restores ->', unarrow === 'a  b ->')

  // spell-check is off by default
  const spell = await evaluate(`document.querySelector('.card:not(.is-todo) .card-body').spellcheck`)
  check('spellcheck is off on the body', spell === false)

  // [[ opens the link picker with the other note's title
  await evaluate(`(() => {
    const t = document.querySelector('.card.is-todo .card-title'); t.focus(); t.value = 'Groceries'
    t.dispatchEvent(new Event('input', { bubbles: true }))
    const b = document.querySelector('.card:not(.is-todo) .card-body')
    b.focus()
    const r = document.createRange(); r.selectNodeContents(b); r.collapse(false)
    const s = getSelection(); s.removeAllRanges(); s.addRange(r)
  })()`)
  await sleep(200)
  await c.send('Input.insertText', { text: ' [[gro' })
  await sleep(120)
  const picker = await evaluate(`(() => {
    const p = document.querySelector('.rb-picker')
    const b = document.querySelector('.card:not(.is-todo) .card-body')
    return { open: !!p, first: p ? p.querySelector('.rb-pick')?.textContent : '', text: b.textContent, focused: document.activeElement === b, titles: [...document.querySelectorAll('.card-title')].map((t) => t.value) }
  })()`)
  check('[[ opens the note picker with a matching title', picker.open && /Groceries/.test(picker.first))
  if (!picker.open) console.log('   debug:', JSON.stringify(picker))
  await key('Enter', 'Enter', 13)
  await sleep(120)
  const linked = await evaluate(`(() => {
    const b = document.querySelector('.card:not(.is-todo) .card-body')
    return { text: b.textContent, link: !!b.querySelector('a.rb-wiki') }
  })()`)
  check('Enter inserts [[Groceries]] rendered as a link', /\[\[Groceries\]\]$/.test(linked.text) && linked.link)
  if (!linked.link) console.log('   debug:', JSON.stringify(linked), 'picker still open:', await evaluate(`!!document.querySelector('.rb-picker')`))

  // delete = soft delete with an Undo toast; no native confirm
  const before = await evaluate(`document.querySelectorAll('.card').length`)
  await evaluate(`document.querySelector('.card:not(.is-todo) .icon-btn.del').click()`)
  await sleep(150)
  const afterDel = await evaluate(`(() => ({
    cards: document.querySelectorAll('.card').length,
    toast: !!document.querySelector('.toast'),
    undo: !!document.querySelector('.toast .toast-act'),
    hiddenBtn: [...document.querySelectorAll('.tab-tool')].some((b) => /trash/.test(b.textContent)),
  }))()`)
  check('delete hides the card and shows an Undo toast', afterDel.cards === before - 1 && afterDel.toast && afterDel.undo)
  check('tab bar shows the trash count', afterDel.hiddenBtn === true)
  await evaluate(`document.querySelector('.toast .toast-act').click()`)
  await sleep(150)
  const restored = await evaluate(`document.querySelectorAll('.card').length`)
  check('Undo brings the note back', restored === before)

  // collapse to title (per device)
  await evaluate(`document.querySelector('.card:not(.is-todo) .icon-btn.fold').click()`)
  await sleep(80)
  const folded = await evaluate(`(() => {
    const cd = document.querySelector('.card.collapsed')
    return { on: !!cd, bodyHidden: cd ? getComputedStyle(cd.querySelector('.card-bodyhost')).display === 'none' : false }
  })()`)
  check('chevron collapses the note to its title', folded.on && folded.bodyHidden)
  await evaluate(`document.querySelector('.card.collapsed .icon-btn.fold').click()`)

  // options popover: book layout + title size + archive live there
  const popNew = await evaluate(`(() => {
    document.querySelector('.card:not(.is-todo) .icon-btn.opt').click()
    const pop = document.querySelector('.card-pop.open')
    const labels = [...pop.querySelectorAll('.pop-btn')].map((b) => b.textContent.trim())
    const book = labels.includes('Book')
    const btn = [...pop.querySelectorAll('.pop-btn')].find((b) => b.textContent.trim() === 'Book')
    btn && btn.click()
    return { book, archive: labels.includes('Archive'), history: labels.includes('History'), move: !!pop.querySelector('.pop-select') }
  })()`)
  check('popover offers Book, Archive, History and Move-to-tab', popNew.book && popNew.archive && popNew.history && popNew.move)
  await sleep(250)
  const bookState = await evaluate(`(() => {
    const cd = document.querySelector('.card.book')
    return { on: !!cd, pages: cd ? cd.querySelectorAll('.card-body.page').length : 0 }
  })()`)
  check('Book layout renders two pages', bookState.on && bookState.pages === 2)
  await evaluate(`document.body.click()`)

  // home page overlay with cross-tab search
  await evaluate(`document.querySelector('#tabs .tab-home').click()`)
  await sleep(120)
  const home = await evaluate(`(() => ({
    open: !document.getElementById('overlay').hidden,
    tabs: document.querySelectorAll('.home-tab').length,
    search: !!document.querySelector('.home-search'),
  }))()`)
  check('home overlay lists the tabs', home.open && home.tabs >= 1 && home.search)
  await evaluate(`(() => { const s = document.querySelector('.home-search'); s.value = 'groc'; s.dispatchEvent(new Event('input')) })()`)
  await sleep(80)
  const hits = await evaluate(`document.querySelectorAll('.home-hit').length`)
  check('home search finds the note across tabs', hits >= 1)
  await evaluate(`document.querySelector('.home-hit').click()`)
  await sleep(150)
  const navigated = await evaluate(`(() => ({ closed: document.getElementById('overlay').hidden, flash: !!document.querySelector('.card.flash') }))()`)
  check('clicking a result closes home and flashes the note', navigated.closed && navigated.flash)

  // inline tab rename (double-click) instead of window.prompt
  await evaluate(`document.querySelector('#tabs .tab.on').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await sleep(80)
  const renameBox = await evaluate(`!!document.querySelector('#tabs .tab-rename')`)
  check('double-click renames a tab inline', renameBox === true)
  await evaluate(`(() => { const i = document.querySelector('#tabs .tab-rename'); i.value = 'Renamed'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`)
  await sleep(120)
  const renamed = await evaluate(`document.querySelector('#tabs .tab.on .tab-name').textContent`)
  check('Enter saves the new tab name', renamed === 'Renamed')

  // settings menu + export links
  await evaluate(`document.getElementById('settings').click()`)
  await sleep(80)
  const settings = await evaluate(`(() => {
    const m = document.querySelector('.settings-menu')
    return { open: !!m, checks: m ? m.querySelectorAll('input[type=checkbox]').length : 0, md: !!(m && m.querySelector('a[href="/api/export.md"]')) }
  })()`)
  check('settings menu shows switches and export links', settings.open && settings.checks >= 4 && settings.md)
  await evaluate(`document.body.click()`)

  // history panel reaches the server (git may or may not have committed yet)
  await evaluate(`(() => {
    document.querySelector('.card:not(.is-todo) .icon-btn.opt').click()
    ;[...document.querySelectorAll('.card-pop.open .pop-btn')].find((b) => b.textContent.trim() === 'History').click()
  })()`)
  await sleep(900)
  const hist = await evaluate(`(() => {
    const p = document.querySelector('.panel-history')
    return { open: !!p, text: p ? p.querySelector('.panel-hint').textContent : '' }
  })()`)
  check('history panel opens and talks to the server', hist.open && !/Could not reach/.test(hist.text))
  await key('Escape', 'Escape', 27)

  // notes stay under the chrome: the board is its own stacking context
  const stacking = await evaluate(`getComputedStyle(document.getElementById('board')).zIndex`)
  check('free board has its own z-index (notes cannot cover the top bar)', stacking === '1')

  // the service worker registered
  const sw = await evaluate(`navigator.serviceWorker.getRegistration().then((r) => !!r)`)
  check('service worker registered', sw === true)

  // add a sketch tab through the in-app dialog, clear it, get an Undo toast
  await evaluate(`document.querySelector('#tabs .tab-add').click()`)
  await sleep(60)
  await evaluate(`[...document.querySelectorAll('.menu-item')].find((b) => /Sketch/.test(b.textContent)).click()`)
  await sleep(80)
  const dlg = await evaluate(`(() => {
    const d = document.querySelector('.dlg')
    if (!d) return { open: false }
    const i = d.querySelector('.dlg-input'); i.value = 'Doodles'
    d.querySelector('.dlg-btn.primary').click()
    return { open: true }
  })()`)
  await sleep(200)
  const sketch = await evaluate(`(() => ({
    tabName: document.querySelector('#tabs .tab.on .tab-name')?.textContent,
    drawShown: getComputedStyle(document.getElementById('draw-view')).display !== 'none',
    clearBtn: [...document.querySelectorAll('.draw-btn')].some((b) => b.textContent === 'Clear'),
  }))()`)
  check('new sketch tab via the in-app dialog', dlg.open && sketch.tabName === 'Doodles' && sketch.drawShown && sketch.clearBtn)

  check('no native alert/confirm/prompt dialogs were used', nativeDialogs === 0)
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
