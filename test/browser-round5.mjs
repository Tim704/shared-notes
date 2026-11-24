// Round 5 in a real browser, with real mouse events where focus matters:
// pictures pasted straight onto a NotePad, cropping, and the later phases.
import { launch, sleep } from './browser-lib.mjs'

let failures = 0
const check = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name)
  if (!cond) failures++
}

const PORT = 3931
let h
const watchdog = setTimeout(async () => {
  console.log('FAIL  watchdog: harness exceeded 240s')
  await h?.cleanup()
  process.exit(1)
}, 240000)
watchdog.unref?.()

try {
  h = await launch({ port: PORT, debugPort: 9331 })
  const { evaluate, type, key, enter, c } = h
  const mouse = (t, x, y, extra = {}) => c.send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', buttons: t === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra })
  const clickAt = async (x, y) => {
    await mouse('mouseMoved', x, y, { button: 'none', buttons: 0 })
    await mouse('mousePressed', x, y)
    await mouse('mouseReleased', x, y)
    await sleep(120)
  }
  const centre = (sel) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  // a picture on the clipboard, pasted wherever the keyboard focus is
  const pastePicture = () =>
    evaluate(`(async () => {
      const cv = document.createElement('canvas'); cv.width = 120; cv.height = 80
      const g = cv.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 120, 80); g.fillStyle = '#36c'; g.fillRect(Math.random() * 60, 10, 40, 40)
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'))
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'p.png', { type: 'image/png' }))
      const target = document.activeElement || document.body
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })()`)
  const imageCards = () => evaluate(`document.querySelectorAll('#board .card.is-image').length`)

  // ---------------------------------------------------------------- a picture pasted onto the board
  await evaluate(`document.getElementById('add').click()`)
  await sleep(250)
  const noteId = await evaluate(`document.querySelector('#board .card').dataset.id`)
  const body = await centre(`.card[data-id="${noteId}"] .card-body`)
  await clickAt(body.x, body.y)
  await type('typing here')
  check('the note has the keyboard focus', await evaluate(`!!document.activeElement.closest('.card')`))
  const empty = await evaluate(`(() => { const e = document.elementFromPoint(1200, 250); return e && (e.id === 'board' || e.classList.contains('plane')) })()`)
  check('there is empty board to click', empty)
  await clickAt(1200, 250)
  await pastePicture()
  await sleep(900)
  check('a picture pasted after clicking the board becomes its own image card', (await imageCards()) === 1)
  check('and does not land in the note', (await evaluate(`document.querySelector('.card[data-id="${noteId}"] .rb-embed-image')`)) == null)

  // selecting an image card and pasting again makes a second card
  const img = await centre('#board .card.is-image img')
  await clickAt(img.x, img.y)
  await evaluate(`document.querySelector('.lightbox, .media-lightbox')?.click()`)
  await sleep(150)
  await pastePicture()
  await sleep(900)
  check('pasting with an image card selected makes another card', (await imageCards()) === 2)
  check('an image card holds exactly one picture', (await evaluate(`Math.max(...[...document.querySelectorAll('#board .card.is-image')].map((c) => c.querySelectorAll('img').length))`)) === 1)

  // ---------------------------------------------------------------- cropping a picture card
  const cardH = () => evaluate(`document.querySelector('#board .card.is-image').getBoundingClientRect().height`)
  const before = await cardH()
  await evaluate(`document.querySelector('#board .card.is-image .card-tools .crop').click()`)
  await sleep(400)
  check('Crop opens the crop overlay', await evaluate(`!!document.querySelector('.cropper .crop-frame')`))
  // drag the bottom edge up by half the picture, with the real mouse
  const s = await centre('.cropper .crop-s')
  const pic = await evaluate(`(() => { const r = document.querySelector('.cropper .crop-stage img').getBoundingClientRect(); return { top: r.top, h: r.height } })()`)
  await mouse('mouseMoved', s.x, s.y, { button: 'none', buttons: 0 })
  await mouse('mousePressed', s.x, s.y)
  await mouse('mouseMoved', s.x, s.y - pic.h / 2)
  await mouse('mouseReleased', s.x, s.y - pic.h / 2)
  await sleep(100)
  await evaluate(`document.querySelector('.cropper .crop-done').click()`)
  await sleep(400)
  const after = await cardH()
  check('a cropped picture card shows half the picture (' + Math.round(before) + ' → ' + Math.round(after) + ' px)', Math.abs(after - before / 2) < 6)
  check('the crop is drawn through a window, the file untouched', await evaluate(`!!document.querySelector('#board .card.is-image .rb-crop img')`))
  await evaluate(`document.querySelector('#board .card.is-image .card-tools .crop').click()`)
  await sleep(300)
  await evaluate(`document.querySelector('.cropper .crop-reset').click()`)
  await evaluate(`document.querySelector('.cropper .crop-done').click()`)
  await sleep(400)
  check('"Whole picture" takes the crop off again', Math.abs((await cardH()) - before) < 3 && (await evaluate(`document.querySelector('#board .card.is-image .rb-crop')`)) == null)

  // ---------------------------------------------------------------- hide finished lines
  await evaluate(`(() => { const b = document.querySelector('.card[data-id="${noteId}"] .card-body'); b.focus(); const r = document.createRange(); r.selectNodeContents(b); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r) })()`)
  await sleep(120)
  await enter()
  await type('[] buy milk')
  await enter()
  await type('second thing')
  await sleep(100)
  const bodyLines = () => evaluate(`[...document.querySelectorAll('.card[data-id="${noteId}"] .card-body .rb-line')].map((l) => ({ text: l.textContent, hidden: l.classList.contains('rb-hidden') }))`)
  const setting = (label) => evaluate(`(async () => { document.getElementById('settings').click(); await new Promise((r) => setTimeout(r, 120)); const l = [...document.querySelectorAll('.settings-menu .menu-check')].find((x) => x.textContent.includes(${JSON.stringify(label)})); l.querySelector('input').click(); document.body.click() })()`)
  await setting('Hide finished lines')
  await sleep(150)
  check('nothing is hidden while nothing is finished', (await bodyLines()).every((l) => !l.hidden))
  // strike the line being typed: it stays until the caret leaves it
  let BL
  await evaluate(`(() => { const b = document.querySelector('.card[data-id="${noteId}"] .card-body'); const s = getSelection(); s.selectAllChildren([...b.querySelectorAll('.rb-line')].at(-1)) })()`)
  await key('x', 'KeyX', 88, 2 | 8)
  await sleep(150)
  BL = await bodyLines()
  check('a line struck through while the caret is in it stays in view', BL.at(-1).text.includes('second thing') && !BL.at(-1).hidden)
  await evaluate(`document.querySelector('.card[data-id="${noteId}"] .rb-todo .rb-check').click()`)
  await sleep(150)
  BL = await bodyLines()
  check('a box ticked elsewhere in the note is hidden at once', BL[1].hidden && !BL[2].hidden)
  await evaluate(`(() => { const b = document.querySelector('.card[data-id="${noteId}"] .card-body'); const r = document.createRange(); r.setStart(b.querySelector('.rb-line'), 0); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r) })()`)
  await sleep(250)
  BL = await bodyLines()
  check('the struck-through line is hidden once the caret has left it', BL.filter((l) => l.hidden).length === 2 && !BL[0].hidden)
  check('the note says how many lines are hidden', (await evaluate(`document.querySelector('.card[data-id="${noteId}"] .rb-done-note')?.textContent`)) === '2 finished lines hidden')
  await evaluate(`document.querySelector('.card[data-id="${noteId}"] .rb-done-note').click()`)
  await sleep(120)
  check('clicking the count shows them in that note', (await bodyLines()).every((l) => !l.hidden))
  await setting('Hide finished lines')
  await sleep(150)
  check('switching the setting off shows everything and drops the count', (await bodyLines()).every((l) => !l.hidden) && (await evaluate(`document.querySelector('.rb-done-note')`)) == null)

  // ---------------------------------------------------------------- line smoothing
  await evaluate(`(async () => { document.getElementById('settings').click(); await new Promise((r) => setTimeout(r, 120)); const r = document.querySelector('.settings-menu .settings-smooth'); r.value = '80'; r.dispatchEvent(new Event('input', { bubbles: true })); document.body.click() })()`)
  await sleep(100)
  check('the smoothing slider is saved on this device', (await evaluate(`JSON.parse(localStorage.getItem('notesSettings')).inkSmoothing`)) === 0.8)

  // ---------------------------------------------------------------- To-do: the due-date shortcut
  await evaluate(`document.querySelector('#tabs .tab-add').click()`)
  await sleep(60)
  await evaluate(`[...document.querySelectorAll('.menu-item')].find((b) => /To-do/.test(b.textContent)).click()`)
  await sleep(80)
  await evaluate(`(() => { const d = document.querySelector('.dlg'); d.querySelector('.dlg-input').value = 'Homework'; d.querySelector('.dlg-btn.primary').click() })()`)
  await sleep(500)
  await evaluate(`document.querySelector('.task-add').click()`)
  await sleep(200)
  await type('Calculus')
  await evaluate(`(() => { window.__picked = 0; HTMLInputElement.prototype.showPicker = function () { window.__picked++ } })()`)
  await key('?', 'Slash', 191, 2 | 8)
  await sleep(120)
  check('Ctrl+Shift+/ on a task opens its due-date picker', (await evaluate(`window.__picked`)) === 1)

  // ---------------------------------------------------------------- To-do: lists, classes, the week calendar
  const dlg = (text) => evaluate(`(() => { const d = document.querySelector('.dlg'); d.querySelector('.dlg-input').value = ${JSON.stringify(text)}; d.querySelector('.dlg-btn.primary').click() })()`)
  const rows = () => evaluate(`[...document.querySelectorAll('.task-list:not(.task-done-list) .task-row .task-text')].map((i) => i.value)`)
  const pillNames = () => evaluate(`[...document.querySelectorAll('.tasks-lists .tasks-list-name')].map((p) => p.textContent)`)
  check('a tab with one list shows no pills, only "New list"', (await pillNames()).length === 0 && (await evaluate(`!!document.querySelector('.tasks-list-add')`)))
  await evaluate(`document.querySelector('.tasks-list-add').click()`)
  await sleep(150)
  await dlg('Physics')
  await sleep(250)
  check('a second list adds pills: All, the first list, the new one', (await pillNames()).join() === 'All,Tasks,Physics')
  check('the new list is on show and empty', (await rows()).length === 0 && (await evaluate(`document.querySelector('.tasks-list.on .tasks-list-name').textContent`)) === 'Physics')
  await evaluate(`document.querySelector('.task-add').click()`)
  await sleep(200)
  await type('Lab report')
  await sleep(100)
  check('a task added there is in that list', (await rows()).join() === 'Lab report')
  await evaluate(`[...document.querySelectorAll('.tasks-list')].find((p) => p.textContent.startsWith('Tasks')).click()`)
  await sleep(150)
  check('the first list still has only its own task', (await rows()).join() === 'Calculus')
  await evaluate(`document.querySelector('.tasks-list[data-list="*"]').click()`)
  await sleep(150)
  check('"All" shows every list', (await rows()).sort().join() === 'Calculus,Lab report')

  // a class with a colour
  await evaluate(`document.querySelector('.task-row .task-more').click()`)
  await sleep(100)
  await evaluate(`[...document.querySelectorAll('.menu-item')].find((b) => b.textContent.trim() === 'Class…').click()`)
  await sleep(150)
  await evaluate(`[...document.querySelectorAll('.menu-item')].find((b) => /New class/.test(b.textContent)).click()`)
  await sleep(150)
  await dlg('Maths')
  await sleep(250)
  const cls = await evaluate(`(() => { const r = document.querySelector('.task-row.has-cls'); return r && { chip: r.querySelector('.task-cls')?.textContent, color: r.style.getPropertyValue('--cls') } })()`)
  check('a task given a new class shows its name and colour', cls && cls.chip === 'Maths' && cls.color === 'var(--red)')
  // a part inherits it
  await evaluate(`document.querySelector('.task-row.has-cls .task-text').focus()`)
  await enter()
  await type('Part one')
  await key('Tab', 'Tab', 9)
  await sleep(200)
  check('a part takes its task\'s class colour', (await evaluate(`[...document.querySelectorAll('.task-row.has-cls .task-text')].map((i) => i.value).join()`)) === 'Calculus,Part one')

  // the week view is a calendar
  await evaluate(`(() => { const p = document.querySelector('.task-row.has-cls .task-date'); p.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); p.dispatchEvent(new Event('change')) })()`)
  await sleep(150)
  await evaluate(`document.querySelector('.tasks-views .segment[data-value="week"]').click()`)
  await sleep(200)
  const wk = await evaluate(`({ cols: document.querySelectorAll('.task-wgrid .task-wcol').length, first: document.querySelector('.task-wcol .task-wcol-dow').textContent, today: document.querySelector('.task-wcol.today .task-entry-name')?.textContent, coloured: !!document.querySelector('.task-wcol.today .task-entry.has-cls') })`)
  check('Week is a seven-day calendar starting on Monday', wk.cols === 7 && wk.first === 'Mon')
  check('a task due today sits in today\'s column, in its class colour', wk.today === 'Calculus' && wk.coloured)
  const span = await evaluate(`document.querySelector('.task-month-h').textContent`)
  await evaluate(`document.querySelector('.task-nav[title="Next week"]').click()`)
  await sleep(150)
  check('Next week moves the calendar on', (await evaluate(`document.querySelector('.task-month-h').textContent`)) !== span && (await evaluate(`document.querySelector('.task-wcol.today')`)) == null)
  await evaluate(`document.querySelector('.task-nav[title="This week"]').click()`)
  await sleep(150)

  // ---------------------------------------------------------------- a tab's wallpaper
  // the file picker cannot be driven from here: hand it a picture when it opens
  await evaluate(`(() => {
    const click = HTMLInputElement.prototype.click
    HTMLInputElement.prototype.click = function () {
      if (this.type !== 'file') return click.call(this)
      const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64
      const g = cv.getContext('2d'); g.fillStyle = '#0a7'; g.fillRect(0, 0, 64, 64)
      cv.toBlob((blob) => { const dt = new DataTransfer(); dt.items.add(new File([blob], 'wall.png', { type: 'image/png' })); this.files = dt.files; this.dispatchEvent(new Event('change')) }, 'image/png')
    }
  })()`)
  await evaluate(`document.querySelector('#tabs .tab.on .tab-x').click()`)
  await sleep(120)
  await evaluate(`[...document.querySelectorAll('.menu-item')].find((b) => /Wallpaper/.test(b.textContent)).click()`)
  await sleep(200)
  check('the tab menu opens the wallpaper sheet', await evaluate(`!!document.querySelector('.tab-wall .wall-pick')`))
  await evaluate(`document.querySelector('.tab-wall .wall-pick').click()`)
  await sleep(1200)
  const wall = await evaluate(`({ on: document.body.classList.contains('has-wall'), img: document.getElementById('wallpaper').style.backgroundImage, hidden: document.getElementById('wallpaper').hidden })`)
  check('a chosen picture becomes the tab\'s wallpaper', wall.on && !wall.hidden && /\/media\/[a-f0-9]{64}\.png/.test(wall.img))
  await evaluate(`(() => { const r = document.querySelector('.tab-wall .wall-dim'); r.value = '40'; r.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await sleep(150)
  check('Fade washes the wallpaper out', (await evaluate(`document.getElementById('wallpaper').style.getPropertyValue('--wall-dim')`)) === '0.4')
  await evaluate(`document.body.click()`)
  await evaluate(`document.querySelector('#tabs .tab').click()`)
  await sleep(300)
  check('another tab does not show it', !(await evaluate(`document.body.classList.contains('has-wall')`)))

  // ---------------------------------------------------------------- a password lock on a tab
  const tabMenu = async (label) => {
    await evaluate(`document.querySelector('#tabs .tab.on .tab-x').click()`)
    await sleep(120)
    await evaluate(`[...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes(${JSON.stringify(label)})).click()`)
    await sleep(200)
  }
  const pwDlg = async (text) => {
    check('the password field hides what is typed', (await evaluate(`document.querySelector('.dlg .dlg-input').type`)) === 'password')
    await dlg(text)
    await sleep(350)
  }
  const switcherHas = async (q) => {
    await key('k', 'KeyK', 75, 2)
    await sleep(200)
    await type(q)
    await sleep(250)
    const out = await evaluate(`[...document.querySelectorAll('.qs .qs-row')].map((e) => e.textContent).join(' | ')`)
    await key('Escape', 'Escape', 27)
    await sleep(150)
    return out
  }
  // the first tab holds the note typed at the start ("typing here")
  check('before the lock, the switcher finds the note', /typing here/.test(await switcherHas('typing')))
  await tabMenu('Lock with a password')
  await pwDlg('hunter2')
  await pwDlg('hunter2')
  await sleep(500)
  check('a freshly locked tab stays open on the device that locked it', !(await evaluate(`document.body.dataset.tabKind === 'locked'`)) && (await evaluate(`document.querySelectorAll('#board .card').length`)) > 0)
  await tabMenu('Lock now')
  await sleep(300)
  const lk = await evaluate(`({ kind: document.body.dataset.tabKind, shown: !document.getElementById('lock-view').hidden, cards: document.querySelectorAll('#board .card').length, title: document.querySelector('.lock-title').textContent })`)
  check('"Lock now" swaps the tab for a lock screen and takes its notes off the page', lk.kind === 'locked' && lk.shown && lk.cards === 0 && /is locked/.test(lk.title))
  check('the switcher no longer finds a note in the locked tab', !/typing here/.test(await switcherHas('typing')))
  check('the API refuses the locked tab without its password', (await evaluate(`fetch('/api/search?q=typing').then((r) => r.json()).then((d) => d.length)`)) === 0)
  check('and serves it with the password the browser hashed', (await evaluate(`fetch('/api/search?q=typing', { headers: { 'X-Tab-Password': 'hunter2' } }).then((r) => r.json()).then((d) => d.length)`)) === 1)
  const tryPw = async (pw) => {
    await evaluate(`(() => { const i = document.querySelector('.lock-input'); i.value = ${JSON.stringify(pw)}; document.querySelector('.lock-card').requestSubmit() })()`)
    await sleep(600)
  }
  await tryPw('wrong')
  check('a wrong password keeps it locked and says so', (await evaluate(`document.body.dataset.tabKind`)) === 'locked' && !(await evaluate(`document.querySelector('.lock-err').hidden`)))
  await tryPw('hunter2')
  check('the right password opens the tab again', (await evaluate(`document.body.dataset.tabKind`)) === 'notes' && (await evaluate(`document.querySelectorAll('#board .card').length`)) > 0)
  await tabMenu('Remove lock')
  await pwDlg('hunter2')
  await sleep(400)
  check('Remove lock takes the password off', !(await evaluate(`!!document.querySelector('#tabs .tab.on .tab-lock')`)))

  check('no native alert/confirm/prompt dialogs were used', h.dialogs() === 0)
  check('no console errors or uncaught exceptions', h.errors.length === 0)
  if (h.errors.length) h.errors.slice(0, 8).forEach((e) => console.log('   !! ' + e))
} catch (err) {
  console.log('FAIL  harness: ' + err.message)
  failures++
} finally {
  clearTimeout(watchdog)
  await h?.cleanup()
}

console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'))
process.exit(failures === 0 ? 0 : 1)
