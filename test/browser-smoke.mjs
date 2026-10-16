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
  console.log('FAIL  watchdog: harness exceeded 150s')
  failures++
  await cleanup()
  process.exit(1)
}, 150000)
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

  // ---------------------------------------------------------------- helpers
  const rawKey = async (key, code, vk, modifiers = 0, text) => {
    const down = { type: text ? 'keyDown' : 'rawKeyDown', modifiers, key, code, windowsVirtualKeyCode: vk }
    if (text) {
      down.text = text
      down.unmodifiedText = text
    }
    await c.send('Input.dispatchKeyEvent', down)
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key, code, windowsVirtualKeyCode: vk })
  }
  const key = (k, code, vk, modifiers = 0) => rawKey(k, code, vk, modifiers)
  const type = async (text) => {
    await c.send('Input.insertText', { text })
    await sleep(40)
  }
  const enter = async () => {
    await rawKey('Enter', 'Enter', 13, 0, '\r')
    await sleep(60)
  }
  const tab = async (shift) => {
    await key('Tab', 'Tab', 9, shift ? 8 : 0)
    await sleep(60)
  }
  const backspace = async () => {
    await key('Backspace', 'Backspace', 8)
    await sleep(60)
  }
  const newNote = async () => {
    await evaluate(`document.getElementById('add').click()`)
    await sleep(200)
    return evaluate(`document.querySelector('.card').dataset.id`)
  }
  const sel = (id, rest = '') => `document.querySelector('.card[data-id="${id}"]${rest ? ' ' + rest : ''}')`
  const focusEnd = (id) =>
    evaluate(`(() => {
      const b = ${sel(id, '.card-body')}
      b.focus()
      const ts = b.querySelectorAll('.rb-text'); const t = ts[ts.length - 1]
      const r = document.createRange(); r.selectNodeContents(t); r.collapse(false)
      const s = getSelection(); s.removeAllRanges(); s.addRange(r)
    })()`)
  // the ribbon acts on the note last focused; its More button opens the note's options
  const openOpts = (id) =>
    evaluate(`(() => {
      ${sel(id, '.card-body')}.focus()
      document.querySelector('#ribbon .rib-more').click()
      return !!document.querySelector('.card-pop.open')
    })()`)
  const lines = (id) =>
    evaluate(`[...${sel(id, '.card-body')}.querySelectorAll(':scope > .rb-line')].map((l) => ({
      cls: l.className, text: l.querySelector('.rb-text').textContent, mark: (l.querySelector('.rb-mark') || {}).textContent || '',
    }))`)

  // ---------------------------------------------------------------- basics
  const initial = await evaluate(`(() => ({
    tabs: document.querySelectorAll('#tabs .tab').length,
    tabAdd: !!document.querySelector('#tabs .tab-add'),
  }))()`)
  check('a tab exists after migration', initial.tabs >= 1)
  check('add-tab control rendered', initial.tabAdd === true)

  const A = await newNote()
  const made = await evaluate(`(() => {
    const card = ${sel(A)}
    const body = card && card.querySelector('.card-body')
    return {
      cards: document.querySelectorAll('.card').length,
      editable: body && body.getAttribute('contenteditable') === 'true',
      fmtBtns: document.querySelectorAll('#ribbon .rib-fmt .fmt-btn').length,
      noChin: !!card && !card.querySelector('.card-fmt') && !card.querySelector('.icon-btn.opt'),
      ribbon: !document.getElementById('ribbon').hidden,
      grows: !!card && card.classList.contains('autogrow'),
    }
  })()`)
  check('clicking + Note adds a card', made.cards >= 1)
  check('note body is contentEditable', made.editable === true)
  check('the ribbon has marks, lists, checkbox, align and picture buttons', made.ribbon && made.fmtBtns >= 8)
  check('notes carry no toolbar or settings button of their own', made.noChin)
  check('a new note grows with its content', made.grows)

  await evaluate(`document.activeElement && document.activeElement.blur()`)
  await evaluate(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
  check('with no note being edited the ribbon is greyed out', await evaluate(`document.querySelector('#ribbon .rib-note').classList.contains('disabled') && document.querySelector('#ribbon .fmt-b').disabled`))
  await evaluate(`${sel(A, '.card-body')}.focus()`)
  check('clicking into a note enables the ribbon', await evaluate(`!document.querySelector('#ribbon .rib-note').classList.contains('disabled') && !document.querySelector('#ribbon .fmt-b').disabled`))
  check('a focused note shows no focus ring', (await evaluate(`getComputedStyle(${sel(A, '.card-body')}).outlineStyle`)) === 'none')
  await type('hello world')
  const typed = await evaluate(`${sel(A, '.card-body')}.textContent`)
  check('typing fills the body through the controlled editor', typed === 'hello world')

  await evaluate(`(() => {
    const b = ${sel(A, '.card-body .rb-text')}
    const r = document.createRange(); r.selectNodeContents(b)
    const s = getSelection(); s.removeAllRanges(); s.addRange(r)
  })()`)
  await key('b', 'KeyB', 66, 2)
  await sleep(120)
  const afterBold = await evaluate(`(() => {
    const b = ${sel(A, '.card-body')}
    return { text: b.textContent, strong: !!b.querySelector('strong') }
  })()`)
  check('Ctrl+B wraps the selection in <strong>', afterBold.strong === true)
  check('bolding preserves the text', afterBold.text === 'hello world')
  await evaluate(`document.querySelector('#ribbon .fmt-b').click()`) // the ribbon keeps the selection: unbold
  await sleep(100)
  check('the ribbon Bold button works on the selection', await evaluate(`!${sel(A, '.card-body')}.querySelector('strong') && ${sel(A, '.card-body')}.textContent === 'hello world'`))
  await key('b', 'KeyB', 66, 2)
  await sleep(80)

  const layout = await evaluate(`(() => {
    const card = ${sel(A)}
    return {
      boardFree: document.getElementById('board').classList.contains('free'),
      cardFree: !!(card && card.classList.contains('free')),
      grip: !!(card && card.querySelector('.resize-grip')),
      positioned: !!(card && card.style.left !== '' && card.style.width !== ''),
    }
  })()`)
  check('board is in free (corkboard) layout', layout.boardFree === true)
  check('card is absolutely positioned with a grip', layout.cardFree && layout.grip && layout.positioned)

  const popover = await openOpts(A)
  check('the ribbon opens the note options popover', popover === true)
  await evaluate(`document.body.click()`)
  await sleep(60)
  check('outside click closes the popover', await evaluate(`!document.querySelector('.card-pop.open')`))

  // ---------------------------------------------------------------- lists
  await focusEnd(A)
  await enter()
  await type('-')
  await type(' ')
  await type('milk')
  await enter()
  await type('eggs')
  let L = await lines(A)
  check('"- " starts a bullet list and Enter continues it', L.length === 3 && /rb-li/.test(L[1].cls) && /rb-li/.test(L[2].cls) && L[2].text === 'eggs' && L[1].mark === '•')
  await tab()
  L = await lines(A)
  check('Tab nests a list item', /rb-li/.test(L[2].cls) && /--ind|ind/.test(await evaluate(`${sel(A, '.card-body')}.querySelectorAll('.rb-line')[2].getAttribute('style') || ''`)))
  check('a nested item gets a dash, its parent keeps the disc', L[2].mark === '–' && L[1].mark === '•')
  await tab(true)
  L = await lines(A)
  check('Shift+Tab brings the disc back', L[2].mark === '•')
  await enter()
  await enter() // Enter on an empty item leaves the list
  L = await lines(A)
  check('Enter on an empty item leaves the list', L.length === 4 && /rb-p/.test(L[3].cls))
  await type('1')
  await type('.')
  await type(' ')
  await type('one')
  await enter()
  await type('two')
  await enter()
  await tab()
  await type('sub')
  L = await lines(A)
  check('"1. " numbers, nesting switches to letters', L[3].mark === '1.' && L[4].mark === '2.' && L[5].mark === 'a.')
  await enter()
  await enter()
  await enter()
  await type('[')
  await type(']')
  await type(' ')
  await type('buy bread')
  L = await lines(A)
  const todoIdx = L.length - 1
  check('"[] " makes a checkbox line between other lines', /rb-todo/.test(L[todoIdx].cls) && L[todoIdx].text === 'buy bread')
  await evaluate(`${sel(A, '.card-body')}.querySelectorAll('.rb-line')[${todoIdx}].querySelector('.rb-check').click()`)
  await sleep(100)
  L = await lines(A)
  check('clicking the box ticks it', /done/.test(L[todoIdx].cls))
  await key('E', 'KeyE', 69, 2 | 8)
  await sleep(80)
  L = await lines(A)
  check('Ctrl+Shift+E centres the line', /al-center/.test(L[todoIdx].cls))
  await key('L', 'KeyL', 76, 2 | 8)
  await sleep(60)
  // fold: "hello world" owns the bullets after it
  const foldable = await evaluate(`!!${sel(A, '.card-body')}.querySelector('.rb-line .rb-fold')`)
  check('a line with bullets under it gets a fold arrow', foldable)
  check('the fold arrow takes no room: the editor has no gutter and a bullet with children keeps its marker in place', await evaluate(`(() => {
    const b = ${sel(A, '.card-body')}
    if (parseFloat(getComputedStyle(b).paddingLeft) > 0) return false
    const f = b.querySelector('.rb-line.rb-li.has-kids > .rb-mark.has-fold > .rb-fold')
    if (!f) return true // only non-list owners here
    const m = f.parentNode.getBoundingClientRect(), r = f.getBoundingClientRect()
    return Math.abs(m.left + m.width / 2 - (r.left + r.width / 2)) < 1 && Math.abs(m.top + m.height / 2 - (r.top + r.height / 2)) < 1 // the arrow is centred over the bullet (it is rotated, so compare centres)
  })()`))
  await evaluate(`${sel(A, '.card-body')}.querySelector('.rb-line .rb-fold').click()`)
  await sleep(80)
  const folded = await evaluate(`(() => {
    const b = ${sel(A, '.card-body')}
    return { hidden: b.querySelectorAll('.rb-hidden').length, more: !!b.querySelector('.rb-more') }
  })()`)
  check('folding hides the lines below and shows a count', folded.hidden >= 2 && folded.more)
  await evaluate(`${sel(A, '.card-body')}.querySelector('.rb-more').click()`)
  await sleep(80)
  check('clicking the count unfolds', (await evaluate(`${sel(A, '.card-body')}.querySelectorAll('.rb-hidden').length`)) === 0)
  // toolbar list menu
  await focusEnd(A)
  await evaluate(`document.querySelector('#ribbon .fmt-list').click()`)
  await sleep(60)
  const menuItems = await evaluate(`[...document.querySelectorAll('.fmt-menu .menu-item')].map((b) => b.textContent)`)
  check('list menu offers bullets, squares, arrows, numbers, letters, roman, heading', menuItems.length >= 8 && menuItems.some((t) => /Roman/.test(t)))
  await evaluate(`[...document.querySelectorAll('.fmt-menu .menu-item')].find((b) => /Squares/.test(b.textContent)).click()`)
  await sleep(80)
  L = await lines(A)
  check('choosing Squares turns the line into a square bullet', /rb-li/.test(L[L.length - 1].cls) && L[L.length - 1].mark === '▪')
  await evaluate(`document.body.click()`)

  // ---------------------------------------------------------------- editor basics on a second note
  const B = await newNote()
  await evaluate(`${sel(B, '.card-body')}.focus()`)
  await type('a')
  await tab()
  await type('b')
  const tabbed = await evaluate(`(() => {
    const b = ${sel(B, '.card-body')}
    return { text: b.textContent, focused: document.activeElement === b }
  })()`)
  check('Tab inserts two spaces in plain text and keeps focus in the note', tabbed.text === 'a  b' && tabbed.focused === true)

  await type(' ')
  await type('-')
  await type('>')
  const arrow = await evaluate(`${sel(B, '.card-body')}.textContent`)
  check('typing -> becomes →', arrow === 'a  b →')
  await backspace()
  const unarrow = await evaluate(`${sel(B, '.card-body')}.textContent`)
  check('Backspace right after restores ->', unarrow === 'a  b ->')
  check('spellcheck is off on the body', (await evaluate(`${sel(B, '.card-body')}.spellcheck`)) === false)

  // [[ opens the link picker with the other note's title
  await evaluate(`(() => {
    const t = ${sel(A, '.card-title')}; t.focus(); t.value = 'Groceries'
    t.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await focusEnd(B)
  await sleep(100)
  await type(' [[gro')
  await sleep(80)
  const picker = await evaluate(`(() => {
    const p = document.querySelector('.rb-picker')
    return { open: !!p, first: p ? p.querySelector('.rb-pick')?.textContent : '' }
  })()`)
  check('[[ opens the note picker with a matching title', picker.open && /Groceries/.test(picker.first))
  await key('Enter', 'Enter', 13)
  await sleep(120)
  const linked = await evaluate(`(() => {
    const b = ${sel(B, '.card-body')}
    return { text: b.textContent, link: !!b.querySelector('a.rb-wiki') }
  })()`)
  check('Enter inserts [[Groceries]] rendered as a link', /\[\[Groceries\]\]$/.test(linked.text) && linked.link)

  // delete = soft delete with an Undo toast; no native confirm
  const before = await evaluate(`document.querySelectorAll('.card').length`)
  await evaluate(`${sel(B, '.icon-btn.del')}.click()`)
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
  check('Undo brings the note back', (await evaluate(`document.querySelectorAll('.card').length`)) === before)

  // collapse to title (per device)
  await evaluate(`${sel(B, '.icon-btn.fold')}.click()`)
  await sleep(80)
  const foldedCard = await evaluate(`(() => {
    const cd = ${sel(B)}
    return { on: cd.classList.contains('collapsed'), bodyHidden: getComputedStyle(cd.querySelector('.card-bodyhost')).display === 'none' }
  })()`)
  check('chevron collapses the note to its title', foldedCard.on && foldedCard.bodyHidden)
  await evaluate(`${sel(B, '.icon-btn.fold')}.click()`)

  // options popover: view, book layout, title size, archive, history, move
  await openOpts(B)
  const popNew = await evaluate(`(() => {
    const pop = document.querySelector('.card-pop.open')
    const labels = [...pop.querySelectorAll('.pop-btn')].map((b) => b.textContent.trim())
    const btn = [...pop.querySelectorAll('.pop-btn')].find((b) => b.textContent.trim() === 'Book')
    btn && btn.click()
    return { labels, move: !!pop.querySelector('.pop-select') }
  })()`)
  check(
    'popover offers Book, Archive, History and Move-to-tab (no per-note mind map)',
    ['Book', 'Archive', 'History'].every((l) => popNew.labels.includes(l)) && !popNew.labels.includes('Mind map') && popNew.move
  )
  await sleep(250)
  const bookState = await evaluate(`(() => {
    const cd = ${sel(B)}
    return { on: cd.classList.contains('book'), pages: cd.querySelectorAll('.card-body.page').length }
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
  check('home search finds the note across tabs', (await evaluate(`document.querySelectorAll('.home-hit').length`)) >= 1)
  await evaluate(`document.querySelector('.home-hit').click()`)
  await sleep(150)
  const navigated = await evaluate(`(() => ({ closed: document.getElementById('overlay').hidden, flash: !!document.querySelector('.card.flash') }))()`)
  check('clicking a result closes home and flashes the note', navigated.closed && navigated.flash)

  // inline tab rename (double-click) instead of window.prompt
  await evaluate(`document.querySelector('#tabs .tab.on').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await sleep(80)
  check('double-click renames a tab inline', await evaluate(`!!document.querySelector('#tabs .tab-rename')`))
  await evaluate(`(() => { const i = document.querySelector('#tabs .tab-rename'); i.value = 'Renamed'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`)
  await sleep(120)
  check('Enter saves the new tab name', (await evaluate(`document.querySelector('#tabs .tab.on .tab-name').textContent`)) === 'Renamed')

  // history panel reaches the server (git may or may not have committed yet)
  await openOpts(B)
  await evaluate(`[...document.querySelectorAll('.card-pop.open .pop-btn')].find((b) => b.textContent.trim() === 'History').click()`)
  await sleep(900)
  const hist = await evaluate(`(() => {
    const p = document.querySelector('.panel-history')
    return { open: !!p, text: p ? p.querySelector('.panel-hint').textContent : '' }
  })()`)
  check('history panel opens and talks to the server', hist.open && !/Could not reach/.test(hist.text))
  await key('Escape', 'Escape', 27)
  await sleep(60)

  // notes stay under the chrome: the board is its own stacking context
  check('free board has its own z-index (notes cannot cover the top bar)', (await evaluate(`getComputedStyle(document.getElementById('board')).zIndex`)) === '1')
  check('service worker registered', await evaluate(`navigator.serviceWorker.getRegistration().then((r) => !!r)`))

  // ---------------------------------------------------------------- mouse helpers
  const mouse = (type, x, y, modifiers = 0, buttons = 1) =>
    c.send('Input.dispatchMouseEvent', { type, x, y, modifiers, button: 'left', buttons: type === 'mouseReleased' ? 0 : buttons, clickCount: 1 })
  const dragMouse = async (x1, y1, x2, y2, modifiers = 0, steps = 8) => {
    await mouse('mouseMoved', x1, y1, modifiers, 0)
    await mouse('mousePressed', x1, y1, modifiers)
    for (let i = 1; i <= steps; i++) await mouse('mouseMoved', x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps, modifiers)
    await mouse('mouseReleased', x2, y2, modifiers)
    await sleep(120)
  }
  const clickAt = async (x, y, modifiers = 0) => {
    await mouse('mouseMoved', x, y, modifiers, 0)
    await mouse('mousePressed', x, y, modifiers)
    await mouse('mouseReleased', x, y, modifiers)
    await sleep(100)
  }
  const rectOf = (expr) => evaluate(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)

  // ---------------------------------------------------------------- full screen
  await evaluate(`${sel(A, '.icon-btn.expand')}.click()`)
  await sleep(250)
  const fs1 = await evaluate(`(() => {
    const f = document.querySelector('.full-back .card.full')
    return { open: !!f, hash: location.hash, lines: f ? f.querySelectorAll('.rb-line').length : 0, title: f ? f.querySelector('.full-title').value : '' }
  })()`)
  check('⤢ opens the note full screen, with a #note=…&full link', fs1.open && /#note=.+&full/.test(fs1.hash) && fs1.title === 'Groceries' && fs1.lines >= 5)
  await evaluate(`(() => {
    const b = document.querySelector('.card.full .card-body'); b.focus()
    const ts = b.querySelectorAll('.rb-text'); const t = ts[ts.length - 1]
    const r = document.createRange(); r.selectNodeContents(t); r.collapse(false)
    const s = getSelection(); s.removeAllRanges(); s.addRange(r)
  })()`)
  await type(' FS')
  check('typing full screen updates the card behind it live', await evaluate(`${sel(A, '.card-body')}.textContent.includes('FS')`))
  await key('Escape', 'Escape', 27)
  await sleep(500)
  check('Escape closes full screen', await evaluate(`!document.querySelector('.full-back')`))
  await evaluate(`${sel(A, '.card-top')}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await sleep(200)
  check('double-clicking the header opens full screen too', await evaluate(`!!document.querySelector('.full-back')`))
  await evaluate(`history.back()`)
  await sleep(500)
  check('the back button closes full screen', await evaluate(`!document.querySelector('.full-back')`))

  // ---------------------------------------------------------------- pictures and videos
  const picUrl = await evaluate(`(async () => {
    const cv = document.createElement('canvas'); cv.width = 40; cv.height = 30
    const g = cv.getContext('2d'); g.fillStyle = '#e8590c'; g.fillRect(0, 0, 40, 30)
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'))
    const res = await fetch('/api/media', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob })
    return (await res.json()).url
  })()`)
  check('a picture uploads to the Pi', /^\/media\/[a-f0-9]{64}\.png$/.test(picUrl || ''))
  const C = await newNote()
  await evaluate(`${sel(C, '.card-body')}.focus()`)
  await type(picUrl)
  await enter()
  await type('https://youtu.be/dQw4w9WgXcQ')
  await enter()
  await type('caption')
  const emb = await evaluate(`(() => {
    const b = ${sel(C, '.card-body')}
    return { img: !!b.querySelector('.rb-embed img[src="${picUrl}"]'), yt: !!b.querySelector('.rb-play') }
  })()`)
  check('a line holding just a picture path shows the picture', emb.img)
  check('a YouTube link on its own line shows a click-to-load player', emb.yt)
  await evaluate(`${sel(C, '.rb-play')}.click()`)
  await sleep(100)
  check(
    'clicking the player loads the privacy-friendly embed',
    await evaluate(`!!${sel(C, 'iframe.rb-frame')} && ${sel(C, 'iframe.rb-frame')}.src.includes('youtube-nocookie.com/embed/dQw4w9WgXcQ')`)
  )
  await type(' more')
  check('typing elsewhere in the note keeps the playing video', await evaluate(`!!${sel(C, 'iframe.rb-frame')}`))
  // a friend adds a note meanwhile (via the API): the board re-renders around us
  await evaluate(`fetch('/api/tabs/' + localStorage.getItem('notesActiveTab') + '/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'From a friend' }) })`)
  await sleep(500)
  const kept = await evaluate(`({ focus: document.activeElement === ${sel(C, '.card-body')}, video: !!${sel(C, 'iframe.rb-frame')}, n: [...document.querySelectorAll('.card-title')].some((t) => t.value === 'From a friend') })`)
  check('a friend adding a note keeps your caret and your video', kept.n && kept.focus && kept.video)
  await evaluate(`${sel(C, '.rb-embed img')}.click()`)
  await sleep(100)
  check('clicking a picture opens it full size', await evaluate(`!!document.querySelector('.lightbox img')`))
  await key('Escape', 'Escape', 27)
  await sleep(80)
  check('Escape closes the picture', await evaluate(`!document.querySelector('.lightbox')`))
  await evaluate(`document.activeElement && document.activeElement.blur()`)

  // ---------------------------------------------------------------- moving notes apart (drag with the mouse)
  const moveCard = async (id, tx, ty) => {
    const r = await rectOf(sel(id, '.card-top'))
    await dragMouse(r.x + 30, r.y + r.h / 2, tx, ty, 0, 10)
  }
  await moveCard(C, 760, 140)
  await moveCard(B, 470, 140)
  const posC = await evaluate(`({ l: parseFloat(${sel(C)}.style.left), t: parseFloat(${sel(C)}.style.top) })`)
  check('dragging a note by its header moves it', posC.l > 500)

  // ---------------------------------------------------------------- ink between the notes
  check('notes have no arrow handle any more', await evaluate(`!document.querySelector('.link-handle')`))
  await evaluate(`document.activeElement && document.activeElement.blur()`)
  const inkSpot = await evaluate(`(() => {
    const b = document.getElementById('board').getBoundingClientRect()
    for (let y = Math.max(b.top, 260) + 20; y < Math.min(b.bottom, innerHeight) - 80; y += 15)
      for (let x = b.left + 20; x < b.right - 200; x += 15) {
        const ok = [0, 60, 120].every((d) => document.elementFromPoint(x + d, y + d / 3)?.id === 'board')
        if (ok) return { x, y }
      }
    return null
  })()`)
  await evaluate(`[...document.querySelectorAll('#ribbon .rib-draw .rib-btn')].find((b) => b.title.startsWith('Draw')).click()`)
  await sleep(80)
  check('Draw in the ribbon turns on ink mode', await evaluate(`document.getElementById('board').classList.contains('inking') && !document.querySelector('.ink-capture').hidden`))
  if (inkSpot) await dragMouse(inkSpot.x, inkSpot.y, inkSpot.x + 120, inkSpot.y + 40, 0, 10)
  await sleep(150)
  check('dragging on the board draws a stroke under the notes', !!inkSpot && (await evaluate(`document.querySelectorAll('.ink .ink-stroke').length`)) === 1)
  const inkSaved = await evaluate(`fetch('/api/export.json').then((r) => r.ok)`)
  check('the board still exports with ink on it', inkSaved)
  await evaluate(`[...document.querySelectorAll('#ribbon .rib-btn')].find((b) => /Eraser/.test(b.title)).click()`)
  if (inkSpot) await dragMouse(inkSpot.x + 60, inkSpot.y - 20, inkSpot.x + 60, inkSpot.y + 50, 0, 8)
  await sleep(150)
  check('the eraser removes the whole stroke', (await evaluate(`document.querySelectorAll('.ink .ink-stroke').length`)) === 0)
  await key('z', 'KeyZ', 90, 2)
  await sleep(150)
  check('Ctrl+Z in ink mode brings the erased stroke back', (await evaluate(`document.querySelectorAll('.ink .ink-stroke').length`)) === 1)
  await evaluate(`[...document.querySelectorAll('#ribbon .rib-btn')].find((b) => /Eraser/.test(b.title)).click()`)
  await key('Escape', 'Escape', 27)
  await sleep(80)
  check('Escape leaves ink mode and the ink stays', await evaluate(`!document.getElementById('board').classList.contains('inking') && document.querySelectorAll('.ink .ink-stroke').length === 1`))

  // ---------------------------------------------------------------- multi-select + align + layout undo
  await evaluate(`document.activeElement && document.activeElement.blur()`)
  const tA = await rectOf(sel(A, '.card-top'))
  await clickAt(tA.x + 30, tA.y + tA.h / 2, 8)
  const tB = await rectOf(sel(B, '.card-top'))
  await clickAt(tB.x + 30, tB.y + tB.h / 2, 8)
  check('Shift-click selects several notes and shows the align bar', await evaluate(`document.querySelectorAll('.card.sel').length === 2 && !document.querySelector('.align-bar').hidden`))
  const tops0 = await evaluate(`[${sel(A)}.style.top, ${sel(B)}.style.top]`)
  await evaluate(`[...document.querySelectorAll('.align-bar .align-btn')].find((b) => b.title === 'Align top edges').click()`)
  await sleep(150)
  const tops1 = await evaluate(`[${sel(A)}.style.top, ${sel(B)}.style.top]`)
  check('Align top edges lines them up', tops1[0] === tops1[1] && tops0[0] !== tops0[1])
  await evaluate(`document.activeElement && document.activeElement.blur()`)
  await key('z', 'KeyZ', 90, 2)
  await sleep(150)
  const tops2 = await evaluate(`[${sel(A)}.style.top, ${sel(B)}.style.top]`)
  check('Ctrl+Z undoes the alignment as one step', tops2[0] === tops0[0] && tops2[1] === tops0[1])
  await key('Escape', 'Escape', 27)
  check('Escape clears the selection', await evaluate(`document.querySelectorAll('.card.sel').length === 0`))

  // ---------------------------------------------------------------- canvas view (pan & zoom)
  await evaluate(`document.querySelector('#tabs .tab.on .tab-x').click()`)
  await sleep(60)
  await evaluate(`[...document.querySelectorAll('.menu .menu-item')].find((b) => /Canvas view/.test(b.textContent)).click()`)
  await sleep(300)
  const cv1 = await evaluate(`({
    canvas: document.getElementById('board').classList.contains('canvas'),
    inPlane: !!document.querySelector('.plane .card'),
    ctrls: !!document.querySelector('.vp-ctrls'), map: !!document.querySelector('.vp-map'),
  })`)
  check('Canvas view puts the notes on a pan & zoom plane with controls and a minimap', cv1.canvas && cv1.inPlane && cv1.ctrls && cv1.map)
  const br = await rectOf(`document.getElementById('board')`)
  // an empty spot of the plane, away from the zoom controls and minimap
  const emptyPoint = () =>
    evaluate(`(() => {
      const b = document.getElementById('board').getBoundingClientRect()
      for (let y = b.top + 20; y < b.bottom - 140; y += 15)
        for (let x = b.left + 20; x < b.right - 220; x += 15) {
          const t = document.elementFromPoint(x, y)
          if (t && (t.id === 'board' || t.classList.contains('plane'))) return { x, y }
        }
      return null
    })()`)
  // zoom out first so there is room, then pan right by dragging empty space
  await evaluate(`[...document.querySelectorAll('.vp-btn')].find((b) => b.title === 'Zoom out').click()`)
  await sleep(60)
  check('zoom out changes the scale', /scale\(0\.[0-9]+\)/.test(await evaluate(`document.querySelector('.plane').style.transform`)))
  const pt0 = await evaluate(`document.querySelector('.plane').style.transform`)
  const ep = await emptyPoint()
  if (ep) await dragMouse(ep.x, ep.y, ep.x + 200, ep.y)
  const pt1 = await evaluate(`document.querySelector('.plane').style.transform`)
  check('dragging the background pans', !!ep && pt0 !== pt1)
  // drag a note to the left of where the old board started: x goes negative
  // notes grow with their content, so raise C above any neighbour that now overlaps its header
  await evaluate(`${sel(C, '.card-title')}.focus(); document.activeElement.blur()`)
  await sleep(100)
  const tC = await rectOf(sel(C, '.card-top'))
  await dragMouse(tC.x + 30, tC.y + tC.h / 2, br.x + 12, tC.y + tC.h / 2, 0, 12)
  const cx = await evaluate(`parseFloat(${sel(C)}.style.left)`)
  check('on the canvas a note can go left of zero (no clamping)', cx < 0)
  await evaluate(`[...document.querySelectorAll('.vp-btn')].find((b) => b.title === 'Fit every note').click()`)
  await sleep(60)
  const fitOk = await evaluate(`(() => {
    const b = document.getElementById('board').getBoundingClientRect()
    return [...document.querySelectorAll('.plane .card')].every((c) => { const r = c.getBoundingClientRect(); return r.left >= b.left - 1 && r.right <= b.right + 1 })
  })()`)
  check('Fit brings every note into view', fitOk)
  // back to the board: offer to bring outside notes in
  await evaluate(`document.querySelector('#tabs .tab.on .tab-x').click()`)
  await sleep(60)
  await evaluate(`[...document.querySelectorAll('.menu .menu-item')].find((b) => /board view/.test(b.textContent)).click()`)
  await sleep(400)
  const back = await evaluate(`({ canvas: document.getElementById('board').classList.contains('canvas'), offer: [...document.querySelectorAll('.toast .toast-act')].some((b) => /Bring/.test(b.textContent)) })`)
  check('back to the board view, with an offer to bring stray notes in', !back.canvas && back.offer)
  await evaluate(`[...document.querySelectorAll('.toast .toast-act')].find((b) => /Bring/.test(b.textContent)).click()`)
  await sleep(250)
  check('bringing notes in gives them x ≥ 0', (await evaluate(`parseFloat(${sel(C)}.style.left)`)) >= 0)

  // ---------------------------------------------------------------- this device's backup
  await evaluate(`document.querySelector('#tabs .tab.on .tab-x').click()`)
  await sleep(60)
  await evaluate(`[...document.querySelectorAll('.menu .menu-item')].find((b) => /Backed up on this device/.test(b.textContent)).click()`)
  await sleep(100)
  await evaluate(`document.querySelector('#tabs .tab-home').click()`)
  await sleep(150)
  check('a tab left out of this device’s backups is flagged on the home page', await evaluate(`!!document.querySelector('.home-tab .home-tab-flag')`))
  await key('Escape', 'Escape', 27)
  await evaluate(`document.getElementById('settings').click()`)
  await sleep(80)
  const st = await evaluate(`(() => {
    const m = document.querySelector('.settings-menu')
    return {
      md: !!m.querySelector('.backup-md'), json: !!m.querySelector('.backup-json'), pi: !!m.querySelector('a[href="/api/export.md"]'),
      note: m.textContent.includes('Left out here'), checks: m.querySelectorAll('input[type=checkbox]').length,
    }
  })()`)
  check('settings offer on-device Markdown/JSON backups, Pi downloads and snapping switches', st.md && st.json && st.pi && st.note && st.checks >= 6)
  // the on-device export is built in the browser: intercept the download link
  const exp = await evaluate(`(async () => {
    let href = null
    const orig = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () { href = this.href; this.download = '' }
    document.querySelector('.settings-menu .backup-md').click()
    HTMLAnchorElement.prototype.click = orig
    const text = href ? await (await fetch(href)).text() : ''
    return { blob: !!href && href.startsWith('blob:'), text }
  })()`)
  check('the device backup is built locally and leaves out the excluded tab', exp.blob && exp.text.includes('Shared Notes export') && !exp.text.includes('Groceries'))

  // ---------------------------------------------------------------- appearance
  await evaluate(`document.querySelector('.settings-menu') || document.getElementById('settings').click()`)
  await sleep(80)
  const theme = await evaluate(`(async () => {
    const seg = (v) => document.querySelector('.settings-menu .segmented .segment[data-value="' + v + '"]')
    const card = document.querySelector('#board .card[data-id]')
    const stored = async () => (await (await fetch('/api/notes/' + card.dataset.id)).json()).color
    const before = { bg: card.style.background, color: await stored() }
    seg('dark').click()
    await new Promise((r) => setTimeout(r, 50))
    const dark = { theme: document.documentElement.dataset.theme, bg: card.style.background, pressed: seg('dark').getAttribute('aria-pressed'), color: await stored() }
    seg('light').click()
    await new Promise((r) => setTimeout(r, 50))
    const light = { theme: document.documentElement.dataset.theme, bg: card.style.background }
    seg('system').click()
    return { before, dark, light, saved: JSON.parse(localStorage.getItem('notesSettings')).theme }
  })()`)
  check('the Dark theme switches the page and renders paper in a dark shade', theme.dark.theme === 'dark' && theme.dark.pressed === 'true' && theme.dark.bg !== theme.before.bg)
  check('the theme never rewrites a note’s stored colour', !!theme.before.color && theme.dark.color === theme.before.color)
  check('the Light theme restores the original paper, and Automatic is remembered', theme.light.theme === 'light' && theme.light.bg === theme.before.bg && theme.saved === 'system')
  const sw = await evaluate(`(async () => {
    const box = [...document.querySelectorAll('.settings-menu .menu-check')].find((l) => /Spell-check/.test(l.textContent)).querySelector('input.switch')
    const read = () => JSON.parse(localStorage.getItem('notesSettings') || '{}').spellcheck
    const was = box.checked
    box.click()
    const flipped = read()
    box.click()
    return { role: box.getAttribute('role'), was, flipped, back: read() }
  })()`)
  check('settings switches are role=switch and toggle their setting', sw.role === 'switch' && sw.flipped === !sw.was && sw.back === sw.was)
  await evaluate(`document.body.click()`)
  await evaluate(`document.querySelector('#tabs .tab.on .tab-x').click()`)
  await sleep(60)
  await evaluate(`[...document.querySelectorAll('.menu .menu-item')].find((b) => /Back up on this device/.test(b.textContent)).click()`)
  await sleep(80)

  // ---------------------------------------------------------------- phone layout (Keep style)
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(500)
  const ph = await evaluate(`({
    phone: document.body.classList.contains('phone'),
    grid: document.getElementById('board').classList.contains('phone-grid'),
    fab: getComputedStyle(document.getElementById('fab')).display !== 'none',
    bar: getComputedStyle(document.getElementById('phone-bar')).display !== 'none',
    tabs: getComputedStyle(document.getElementById('tabs')).display === 'none',
    readonly: ${sel(A, '.card-body')}.getAttribute('contenteditable') === 'false',
  })`)
  check('a phone gets the Keep-style grid, bottom bar and + button', ph.phone && ph.grid && ph.fab && ph.bar && ph.tabs)
  check('phone cards are previews (edit full screen)', ph.readonly)
  const pr = await rectOf(sel(A))
  await clickAt(pr.x + pr.w / 2, pr.y + 20)
  await sleep(250)
  check('tapping a note opens it full screen', await evaluate(`!!document.querySelector('.full-back .card.full')`))
  await evaluate(`document.querySelector('.full-x').click()`)
  await sleep(500)
  check('the back arrow closes it', await evaluate(`!document.querySelector('.full-back')`))
  const pr2 = await rectOf(sel(A))
  await mouse('mouseMoved', pr2.x + pr2.w / 2, pr2.y + 20, 0, 0)
  await mouse('mousePressed', pr2.x + pr2.w / 2, pr2.y + 20)
  await sleep(650)
  await mouse('mouseReleased', pr2.x + pr2.w / 2, pr2.y + 20)
  await sleep(120)
  const selp = await evaluate(`({ bar: !document.getElementById('sel-bar').hidden, text: document.getElementById('sel-bar').textContent, picked: !!${sel(A)}.classList.contains('picked') })`)
  check('long-press selects a note and shows the action bar', selp.bar && selp.picked && /1 selected/.test(selp.text))
  await evaluate(`[...document.querySelectorAll('#sel-bar .sel-btn')].find((b) => b.title === 'Pin to the top').click()`)
  await sleep(200)
  check('pinning from the action bar puts the note first', await evaluate(`document.querySelector('#board .card').dataset.id === '${A}' && ${sel(A)}.classList.contains('pinned')`))
  await evaluate(`document.querySelector('#phone-bar [data-act="tabs"]').click()`)
  await sleep(250)
  check('the tabs drawer lists the tabs', await evaluate(`!document.getElementById('drawer').hidden && document.querySelectorAll('.drawer-item').length >= 4`))
  await evaluate(`document.getElementById('drawer').click()`)
  await sleep(250)
  check('the bottom bar has Home, Tabs and Settings and no search button', await evaluate(`[...document.querySelectorAll('#phone-bar button')].map((b) => b.dataset.act).join() === 'home,tabs,settings'`))
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true })
  const swipe = async (x1, y1, x2, y2) => {
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1 }] })
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: (x1 + x2) / 2, y: (y1 + y2) / 2 }] })
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x2, y: y2 }] })
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(350)
  }
  const barY = 844 - 24
  await swipe(60, barY, 320, barY)
  check('swiping right opens Home and highlights it in the bar', await evaluate(`!document.getElementById('overlay').hidden && !!document.querySelector('.panel-home') && document.querySelector('#phone-bar [data-act="home"]').classList.contains('on')`))
  await swipe(320, 400, 60, 400)
  check('swiping left on Home comes back to the notes', await evaluate(`document.getElementById('overlay').hidden && document.querySelector('#phone-bar [data-act="tabs"]').classList.contains('on')`))
  await swipe(320, barY, 60, barY)
  check('swiping left opens Settings', await evaluate(`!!document.querySelector('.settings-menu') && document.querySelector('#phone-bar [data-act="settings"]').classList.contains('on')`))
  await swipe(60, 500, 320, 500)
  check('swiping right on Settings comes back to the notes', await evaluate(`!document.querySelector('.settings-menu') && document.querySelector('#phone-bar [data-act="tabs"]').classList.contains('on')`))
  // the pages form one strip: Home, every tab in order, Settings
  const firstName = await evaluate(`document.getElementById('phone-title').textContent`)
  await evaluate(`document.querySelector('#phone-bar [data-act="tabs"]').click()`)
  await sleep(250)
  await evaluate(`[...document.querySelectorAll('.drawer-item')].find((b) => /New list/.test(b.textContent)).click()`)
  await sleep(150)
  await evaluate(`(() => { const i = document.querySelector('.dlg .dlg-input'); i.value = 'Second'; document.querySelector('.dlg .dlg-btn.primary').click() })()`)
  await sleep(400)
  check('a new list from the drawer becomes the current tab', await evaluate(`document.getElementById('phone-title').textContent === 'Second' && document.getElementById('drawer').hidden`))
  await swipe(60, barY, 320, barY)
  check('swiping right on the second tab goes to the first tab, not Home', await evaluate(`document.getElementById('phone-title').textContent === ${JSON.stringify(firstName)} && document.getElementById('overlay').hidden`))
  await swipe(320, barY, 60, barY)
  check('swiping left on the first tab goes to the second tab', await evaluate(`document.getElementById('phone-title').textContent === 'Second' && !document.querySelector('.settings-menu')`))
  await swipe(320, barY, 60, barY)
  check('swiping left on the last tab opens Settings', await evaluate(`!!document.querySelector('.settings-menu')`))
  await swipe(60, 500, 320, 500)
  await swipe(60, barY, 320, barY)
  check('two swipes right from Settings land on the first tab again', await evaluate(`document.getElementById('phone-title').textContent === ${JSON.stringify(firstName)} && document.getElementById('overlay').hidden`))
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await c.send('Emulation.clearDeviceMetricsOverride')
  await sleep(500)
  check('back on a wide screen the corkboard returns', await evaluate(`!document.body.classList.contains('phone') && document.getElementById('board').classList.contains('free') && ${sel(A, '.card-body')}.getAttribute('contenteditable') === 'true'`))

  // ---------------------------------------------------------------- deep link straight into full screen
  await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/#note=${A}&full` })
  await sleep(2500)
  check('#note=<id>&full opens that note full screen on load', await evaluate(`!!document.querySelector('.full-back .card.full[data-id="${A}"]')`))
  await key('Escape', 'Escape', 27)
  await sleep(300)


  // add a sketch tab through the in-app dialog
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

  // ---------------------------------------------------------------- document and mind map tabs
  const newTab = async (label, name) => {
    await evaluate(`document.querySelector('#tabs .tab-add').click()`)
    await sleep(60)
    await evaluate(`[...document.querySelectorAll('.menu-item')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
    await sleep(80)
    await evaluate(`(() => { const i = document.querySelector('.dlg .dlg-input'); i.value = ${JSON.stringify(name)}; document.querySelector('.dlg .dlg-btn.primary').click() })()`)
    await sleep(250)
  }
  await newTab('Document', 'Essay')
  const docTab = await evaluate(`({
    shown: !document.getElementById('page-view').hidden && !!document.querySelector('.page-sheet .page-body[contenteditable="true"]'),
    board: getComputedStyle(document.getElementById('board')).display === 'none',
    ribbon: !document.getElementById('ribbon').hidden && document.querySelector('#ribbon .rib-note').hidden,
  })`)
  check('a Document tab shows one full page to write on, with the ribbon for formatting', docTab.shown && docTab.board && docTab.ribbon)
  const phBefore = await evaluate(`getComputedStyle(document.querySelector('.page-body.rb-empty .rb-text[data-ph]'), '::before').content`)
  await evaluate(`document.querySelector('.page-body').focus()`)
  await sleep(100)
  const phFocused = await evaluate(`getComputedStyle(document.querySelector('.page-body.rb-empty .rb-text[data-ph]'), '::before').content`)
  check('the "Start writing…" hint shows on an empty page and goes when you click in', /Start writing/.test(phBefore) && phFocused === 'none')
  await type('Dear diary')
  await evaluate(`(() => {
    const t = document.querySelector('.page-body .rb-text'); const r = document.createRange(); r.selectNodeContents(t)
    const s = getSelection(); s.removeAllRanges(); s.addRange(r)
  })()`)
  await evaluate(`document.querySelector('#ribbon .fmt-i').click()`)
  await sleep(100)
  check('the ribbon formats the document', await evaluate(`!!document.querySelector('.page-body em')`))
  const docTabId = await evaluate(`localStorage.getItem('notesActiveTab')`)

  await newTab('Mind map', 'Plans')
  const mmTab = await evaluate(`(() => {
    const w = document.querySelector('#page-view .mm-wrap')
    return { on: !!w, root: w ? w.querySelector('.mm-root text')?.textContent : '', ribbon: document.getElementById('ribbon').hidden }
  })()`)
  check('a Mind map tab draws a map around its name', mmTab.on && mmTab.root === 'Plans' && mmTab.ribbon)
  await evaluate(`(() => {
    const n = document.querySelector('#page-view .mm-root')
    const o = { bubbles: true, cancelable: true, pointerId: 9, button: 0, clientX: 1, clientY: 1 }
    n.dispatchEvent(new PointerEvent('pointerdown', o)); n.dispatchEvent(new PointerEvent('pointerup', o))
  })()`)
  await sleep(100)
  await key('Tab', 'Tab', 9)
  await sleep(150)
  await type('Holiday')
  await evaluate(`document.activeElement.blur()`)
  await sleep(250)
  check('Tab on the centre adds a branch', await evaluate(`[...document.querySelectorAll('#page-view .mm-node text')].some((t) => t.textContent === 'Holiday')`))

  // both survive a reload (shared doc)
  await evaluate(`localStorage.setItem('notesActiveTab', '${docTabId}')`)
  await c.send('Page.reload')
  await sleep(2500)
  check('the document keeps its text after a reload', await evaluate(`document.querySelector('.page-body')?.textContent === 'Dear diary'`))
  const mirror = await evaluate(`fetch('/api/export.md').then((r) => r.text())`)
  check('the Markdown export includes the document and the mind map', /Dear diary/.test(mirror) && /# Plans/.test(mirror) && /Holiday/.test(mirror))

  // the toolbar can hide until something is being edited
  await evaluate(`(() => {
    const t = [...document.querySelectorAll('#tabs .tab')].find((x) => x.querySelector('.tab-name')?.textContent === 'Renamed')
    t && t.click()
  })()`)
  await sleep(300)
  await evaluate(`document.getElementById('settings').click()`)
  await sleep(80)
  await evaluate(`document.querySelector('.settings-menu .segmented[aria-label="Toolbar"] .segment[data-value="editing"]').click()`)
  await evaluate(`document.body.click()`)
  await evaluate(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
  await sleep(250)
  const hiddenRib = await evaluate(`getComputedStyle(document.getElementById('ribbon')).visibility`)
  await evaluate(`document.querySelector('#board .card .card-body')?.focus()`)
  await sleep(250)
  const shownRib = await evaluate(`getComputedStyle(document.getElementById('ribbon')).visibility`)
  check('"While editing" hides the ribbon until a note is focused', hiddenRib === 'hidden' && shownRib === 'visible')

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
