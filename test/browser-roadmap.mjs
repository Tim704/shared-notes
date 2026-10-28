// Roadmap 2 in a real browser: links that follow renames, backlinks and
// mentions, the quick switcher, hover previews, Back, the slash menu, dates,
// moving lines, labelled links, tags and search, highlights, callouts, checkbox
// states, templates and daily notes, extract and merge, aliases, heading links,
// the document outline, to-dos from notes and the Board view, share links.
import { launch, sleep } from './browser-lib.mjs'

let failures = 0
const check = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name)
  if (!cond) failures++
}

const PORT = 3921
let h
const watchdog = setTimeout(async () => {
  console.log('FAIL  watchdog: harness exceeded 240s')
  await h?.cleanup()
  process.exit(1)
}, 240000)
watchdog.unref?.()

try {
  h = await launch({ port: PORT, debugPort: 9321 })
  const { evaluate, key, type, enter, c } = h
  const S = (id, rest = '') => `document.querySelector('.card[data-id="${id}"]${rest ? ' ' + rest : ''}')`
  const newNote = async (title) => {
    await evaluate(`document.getElementById('add').click()`)
    await sleep(200)
    const id = await evaluate(`document.activeElement.closest('.card')?.dataset.id || document.querySelector('#board .card').dataset.id`)
    if (title) await setTitle(id, title)
    return id
  }
  const setTitle = async (id, title) => {
    await evaluate(`(() => { const t = ${S(id, '.card-title')}; t.focus(); t.value = ${JSON.stringify(title)}; t.dispatchEvent(new Event('input', { bubbles: true })); t.blur() })()`)
    await sleep(120)
  }
  const focusEnd = (id, sel = '.card-body') =>
    evaluate(`(() => {
      const b = ${S(id, sel)}
      b.focus()
      const ts = b.querySelectorAll('.rb-text'); const t = ts[ts.length - 1]
      const r = document.createRange(); r.selectNodeContents(t); r.collapse(false)
      const s = getSelection(); s.removeAllRanges(); s.addRange(r)
    })()`)
  const bodyText = (id) => evaluate(`${S(id, '.card-body')}.textContent`)
  const noteBody = (id) => evaluate(`(async () => (await (await fetch('/api/notes/${id}')).json()).body)()`)
  const selectText = (id, text) =>
    evaluate(`(() => {
      const b = ${S(id, '.card-body')}
      b.focus()
      const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT)
      let n
      while ((n = w.nextNode())) {
        const i = n.nodeValue.indexOf(${JSON.stringify(text)})
        if (i >= 0) {
          const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + ${text.length})
          const s = getSelection(); s.removeAllRanges(); s.addRange(r)
          return true
        }
      }
      return false
    })()`)
  const blurAll = async () => {
    await evaluate(`document.activeElement && document.activeElement.blur()`)
    await evaluate(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
    await sleep(80)
  }

  // ---------------------------------------------------------------- [[ picker, rename, backlinks
  const R = await newNote('Recipes')
  await focusEnd(R)
  await type('Soup')
  await evaluate(`document.querySelector('#ribbon .fmt-list').click()`)
  await sleep(60)
  await evaluate(`[...document.querySelectorAll('.menu-item')].find((b) => /Heading/.test(b.textContent)).click()`)
  await sleep(60)
  const G = await newNote('Groceries')
  await focusEnd(G)
  await type('see [[Rec')
  await sleep(120)
  const pick = await evaluate(`[...document.querySelectorAll('.rb-picker .rb-pick')].map((r) => r.textContent)`)
  check('typing [[ offers matching notes', pick.some((t) => t.startsWith('Recipes')))
  await enter()
  await sleep(100)
  check('Enter puts the [[link]] in', (await bodyText(G)).includes('see [[Recipes]]'))
  await type(' and cookbook ideas')
  await setTitle(R, 'Cookbook')
  await sleep(200)
  check('renaming a note rewrites the links to it', (await bodyText(G)).includes('[[Cookbook]]'))
  check('…and says so', await evaluate(`[...document.querySelectorAll('.toast')].some((t) => /Updated 1 link/.test(t.textContent))`))

  await evaluate(`${S(R, '.expand')}.click()`)
  await sleep(500)
  const back = await evaluate(`(() => { const l = document.querySelector('.full-back .full-links'); return l ? l.textContent : '' })()`)
  check('full screen shows "Linked from" with the linking note and line', /Linked from · 1/.test(back) && /Groceries/.test(back))
  check('…and unlinked mentions of the title', /Unlinked mentions · 1/.test(back))
  await evaluate(`document.querySelector('.full-back .links-link').click()`)
  await sleep(200)
  check('"Link" turns the mention into [[Cookbook]]', /\[\[Cookbook\]\] ideas/.test(await noteBody(G)))
  await key('Escape', 'Escape', 27)
  await sleep(500)

  // ---------------------------------------------------------------- heading links, hover preview
  await focusEnd(G)
  await enter()
  await type('[[Cookbook#S')
  await sleep(120)
  const heads = await evaluate(`[...document.querySelectorAll('.rb-picker .rb-pick')].map((r) => r.textContent)`)
  check('[[Note# offers that note’s headings', heads.some((t) => /Soup/.test(t)))
  await enter()
  await sleep(100)
  check('…and links to the heading', (await bodyText(G)).includes('[[Cookbook#Soup]]'))
  await blurAll()
  await evaluate(`[...${S(G)}.querySelectorAll('a.rb-wiki')][0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`)
  await sleep(700)
  const pv = await evaluate(`document.querySelector('.link-preview')?.textContent || ''`)
  check('resting on a link shows a preview of the note', /Cookbook/.test(pv) && /Soup/.test(pv))
  await evaluate(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)

  // ---------------------------------------------------------------- dead link → create it
  await focusEnd(G)
  await enter()
  await type('[[Nowhere yet]]')
  await blurAll()
  await evaluate(`[...${S(G)}.querySelectorAll('a.rb-wiki')].find((a) => /Nowhere/.test(a.textContent)).click()`)
  await sleep(150)
  const deadToast = await evaluate(`[...document.querySelectorAll('.toast')].find((t) => /Nowhere yet/.test(t.textContent))?.querySelector('.toast-act')?.textContent`)
  check('a link to nothing offers to create the note', deadToast === 'Create it')
  await evaluate(`[...document.querySelectorAll('.toast')].find((t) => /Nowhere yet/.test(t.textContent)).querySelector('.toast-act').click()`)
  await sleep(500)
  check('…which makes it and opens it large', await evaluate(`document.querySelector('.full-back .full-title')?.value === 'Nowhere yet'`))
  await key('Escape', 'Escape', 27)
  await sleep(500)

  // ---------------------------------------------------------------- quick switcher, create on a miss
  await blurAll()
  await key('k', 'KeyK', 75, 2)
  await sleep(150)
  check('Ctrl+K opens the quick switcher', await evaluate(`!!document.querySelector('.qs-back .qs-input')`))
  await type('cook')
  await sleep(80)
  check('…ranked by where the letters start a word', (await evaluate(`document.querySelector('.qs-row.on .qs-label').textContent`)) === 'Cookbook')
  await enter()
  await sleep(300)
  check('…and Enter goes to the note', (await evaluate(`location.hash`)) === '#note=' + R)
  await key('k', 'KeyK', 75, 2)
  await sleep(150)
  await type('Fresh idea')
  await enter()
  await sleep(500)
  check('Enter with no match creates the note and opens it', await evaluate(`document.querySelector('.full-back .full-title')?.value === 'Fresh idea'`))
  await key('Escape', 'Escape', 27)
  await sleep(500)

  // ---------------------------------------------------------------- slash menu, dates, move lines
  const W = await newNote('Writing')
  await focusEnd(W)
  await type('first line')
  await enter()
  await type('/divi')
  await sleep(100)
  check('/ opens the slash menu, filtered', await evaluate(`[...document.querySelectorAll('.rb-picker.rb-slash .rb-pick')].map((r) => r.textContent).join('|').includes('Divider')`))
  await enter()
  await sleep(100)
  check('…and Divider draws a line', await evaluate(`!!${S(W, '.rb-line.rb-hr')}`))
  await type('/tip')
  await sleep(80)
  await enter()
  await type('A tip')
  await sleep(80)
  check('/tip makes a callout', await evaluate(`!!${S(W, '.rb-line.rb-callout.co-tip.co-first')}`))
  await enter()
  await enter() // Enter on an empty callout line leaves it
  await type('pay rent @tomorrow ')
  await sleep(100)
  const tmr = await evaluate(`(() => { const d = new Date(); d.setDate(d.getDate() + 1); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) })()`)
  check('"@tomorrow " becomes a date chip', (await bodyText(W)).includes('pay rent @' + tmr) && (await evaluate(`!!${S(W, '.rb-date')}`)))
  await h.backspace()
  await sleep(80)
  check('Backspace straight after puts the words back', (await bodyText(W)).includes('pay rent @tomorrow'))
  await type(' ')
  await enter()
  await type('line B')
  await key('ArrowUp', 'ArrowUp', 38, 1 + 8)
  await sleep(120)
  const order = await evaluate(`[...${S(W, '.card-body')}.querySelectorAll('.rb-text')].map((t) => t.textContent)`)
  check('Alt+Shift+↑ moves the line up past its neighbour', order.indexOf('line B') >= 0 && order.indexOf('line B') < order.findIndex((t) => t.startsWith('pay rent')))

  // ---------------------------------------------------------------- labelled links, paste on selection, highlight
  await selectText(W, 'first')
  await key('k', 'KeyK', 75, 2)
  await sleep(150)
  check('Ctrl+K on selected text asks for a link (not the switcher)', await evaluate(`!!document.querySelector('.dlg .dlg-input') && !document.querySelector('.qs-back')`))
  await evaluate(`(() => { const i = document.querySelector('.dlg .dlg-input'); i.value = 'example.com/a'; document.querySelector('.dlg .dlg-btn.primary').click() })()`)
  await sleep(150)
  check('…and links it (https:// added)', await evaluate(`${S(W, 'a.rb-href')}?.dataset.href === 'https://example.com/a' && ${S(W, 'a.rb-href')}.textContent === 'first'`))
  await selectText(W, 'line')
  await evaluate(`(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'https://example.org/b')
    const ev = new InputEvent('beforeinput', { inputType: 'insertFromPaste', dataTransfer: dt, bubbles: true, cancelable: true })
    ${S(W, '.card-body')}.dispatchEvent(ev)
  })()`)
  await sleep(150)
  check('pasting an address onto selected text links it', await evaluate(`[...${S(W)}.querySelectorAll('a.rb-href')].some((a) => a.dataset.href === 'https://example.org/b')`))
  await selectText(W, 'rent')
  await key('h', 'KeyH', 72, 2 + 8)
  await sleep(120)
  check('Ctrl+Shift+H highlights', await evaluate(`${S(W, 'mark.rb-hl')}?.textContent === 'rent'`))
  const md = await evaluate(`(async () => (await (await fetch('/api/export.md')).text()))()`)
  check('the Markdown has [label](url), ==highlight==, *** and callouts', md.includes('[first](https://example.com/a)') && md.includes('==rent==') && md.includes('***') && md.includes('> [!tip] A tip'))

  // ---------------------------------------------------------------- checkbox states
  await focusEnd(W)
  await enter()
  await type('[] laundry')
  await sleep(60)
  await evaluate(`(() => { const ch = [...${S(W)}.querySelectorAll('.rb-check')].pop(); ch.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); ch.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true })) })()`)
  await sleep(120)
  await evaluate(`[...document.querySelectorAll('.todo-state-menu .menu-item')].find((b) => /In progress/.test(b.textContent)).click()`)
  await sleep(120)
  check('Alt+click on a checkbox sets "in progress" ([/])', await evaluate(`!!${S(W, '.rb-todo.ts-doing')}`) && (await noteBody(W)).includes('- [/] laundry'))

  // ---------------------------------------------------------------- tags and search operators
  await focusEnd(W)
  await enter()
  await type('#travel/japan plans')
  await blurAll()
  check('#tags show as chips', await evaluate(`${S(W, '.rb-tag')}?.dataset.tag === 'travel/japan'`))
  await evaluate(`(() => { const s = document.getElementById('search'); s.value = 'tag:travel'; s.dispatchEvent(new Event('input')) })()`)
  await sleep(100)
  const visible = await evaluate(`[...document.querySelectorAll('#board .card:not(.hidden)')].map((c) => c.dataset.id)`)
  check('search understands tag: (parents match children)', visible.length === 1 && visible[0] === W)
  await evaluate(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')) })()`)
  await evaluate(`(() => { const t = ${S(W, '.rb-tag')}; t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); t.click() })()`)
  await sleep(300)
  const home = await evaluate(`({ q: document.querySelector('.home-search')?.value, hits: document.querySelectorAll('.home-hit').length })`)
  check('clicking a tag lists its notes across every tab', home.q === 'tag:travel/japan' && home.hits === 1)
  await evaluate(`(() => { const s = document.querySelector('.home-search'); s.value = ''; s.dispatchEvent(new Event('input')) })()`)
  await sleep(100)
  check('Home has a tag list with counts', await evaluate(`[...document.querySelectorAll('.tag-chip')].some((b) => /#travel/.test(b.textContent) && b.querySelector('.tag-count').textContent === '1')`))
  await key('Escape', 'Escape', 27)
  await sleep(200)

  // ---------------------------------------------------------------- aliases
  await evaluate(`${S(R, '.card-body')}.focus()`)
  await evaluate(`document.querySelector('#ribbon .rib-more').click()`)
  await sleep(120)
  await evaluate(`(() => { const i = document.querySelector('.card-pop.open .pop-aka'); i.value = 'Kitchen book'; i.dispatchEvent(new Event('change')) })()`)
  await evaluate(`document.body.click()`)
  await sleep(100)
  await focusEnd(G)
  await enter()
  await type('[[Kitchen book]]')
  await blurAll()
  await evaluate(`[...${S(G)}.querySelectorAll('a.rb-wiki')].find((a) => /Kitchen/.test(a.textContent)).click()`)
  await sleep(300)
  check('an alias resolves to its note', (await evaluate(`location.hash`)) === '#note=' + R)

  // ---------------------------------------------------------------- extract and merge
  await evaluate(`(() => {
    const t = ${S(G, '.rb-line .rb-text')}
    ${S(G, '.card-body')}.focus()
    const r = document.createRange(); r.selectNodeContents(t)
    const s = getSelection(); s.removeAllRanges(); s.addRange(r)
  })()`)
  await evaluate(`document.querySelector('#ribbon .rib-extract').click()`)
  await sleep(150)
  await evaluate(`(() => { const i = document.querySelector('.dlg .dlg-input'); i.value = 'Pulled out'; document.querySelector('.dlg .dlg-btn.primary').click() })()`)
  await sleep(300)
  const ex = await evaluate(`(async () => { const tabs = await (await fetch('/api/tabs')).json(); const t = await (await fetch('/api/tabs/' + tabs[0].id)).json(); const n = t.notes.find((x) => x.title === 'Pulled out'); return { body: n && n.body, src: (await (await fetch('/api/notes/${G}')).json()).body } })()`)
  check('"Selection → new note" moves the text and leaves a [[link]]', ex.body && ex.body.includes('[[Cookbook]]') && ex.src.startsWith('[[Pulled out]]'))
  const F = await evaluate(`(async () => { const tabs = await (await fetch('/api/tabs')).json(); const t = await (await fetch('/api/tabs/' + tabs[0].id)).json(); return t.notes.find((x) => x.title === 'Fresh idea').id })()`)
  await evaluate(`${S(F, '.card-body')}.focus()`)
  await evaluate(`document.querySelector('#ribbon .rib-more').click()`)
  await sleep(120)
  await evaluate(`[...document.querySelectorAll('.card-pop.open .pop-btn')].find((b) => /Merge/.test(b.textContent)).click()`)
  await sleep(150)
  await type('Writing')
  await enter()
  await sleep(300)
  const merged = await evaluate(`(async () => ({ dst: (await (await fetch('/api/notes/${W}')).json()).body, src: (await (await fetch('/api/notes/${F}?x')).json()) }))()`)
  check('merging appends the note under its title and trashes it', merged.dst.includes('Fresh idea') && typeof merged.src.deleted === 'number')

  // ---------------------------------------------------------------- templates and today's journal
  await evaluate(`document.getElementById('today').click()`)
  await sleep(600)
  const today = await evaluate(`(() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) })()`)
  check('Today opens a journal note named for the day', (await evaluate(`document.querySelector('.full-back .full-title')?.value`)) === today && (await evaluate(`document.querySelector('#tabs .tab.on .tab-name')?.textContent`)) === 'Journal')
  await key('Escape', 'Escape', 27)
  await sleep(400)

  // ---------------------------------------------------------------- Back and Forward retrace tab switches
  const tabNames = () => evaluate(`document.querySelector('#tabs .tab.on .tab-name')?.textContent`)
  await evaluate(`[...document.querySelectorAll('#tabs .tab')].find((t) => t.querySelector('.tab-name')?.textContent !== 'Journal').click()`)
  await sleep(200)
  const firstTab = await tabNames()
  await evaluate(`[...document.querySelectorAll('#tabs .tab')].find((t) => t.querySelector('.tab-name')?.textContent === 'Journal').click()`)
  await sleep(200)
  await evaluate(`history.back()`)
  await sleep(300)
  const afterBack = await tabNames()
  await evaluate(`history.forward()`)
  await sleep(300)
  check('browser Back and Forward retrace tab switches', afterBack === firstTab && (await tabNames()) === 'Journal')
  // leaving full screen by jumping to a tab: Back returns to the tab, not to the closed note
  await evaluate(`document.getElementById('today').click()`)
  await sleep(500)
  await key('k', 'KeyK', 75, 2)
  await sleep(150)
  await type(firstTab)
  await enter()
  await sleep(400)
  const jumped = await evaluate(`({ full: !!document.querySelector('.full-back'), tab: document.querySelector('#tabs .tab.on .tab-name')?.textContent })`)
  await evaluate(`history.back()`)
  await sleep(400)
  const backed = await evaluate(`({ full: !!document.querySelector('.full-back'), tab: document.querySelector('#tabs .tab.on .tab-name')?.textContent })`)
  check('going to a tab from a note opened large closes it; Back returns to the tab, not the note', !jumped.full && jumped.tab === firstTab && !backed.full && backed.tab === 'Journal')
  // following links between notes opened large: closing ends on the board
  await evaluate(`[...document.querySelectorAll('#tabs .tab')].find((t) => t.querySelector('.tab-name')?.textContent === ${JSON.stringify(firstTab)}).click()`)
  await sleep(300)
  await evaluate(`${S(G, '.expand')}.click()`)
  await sleep(500)
  await evaluate(`(() => { const a = [...document.querySelectorAll('.full-back a.rb-wiki')].find((x) => x.textContent === '[[Kitchen book]]'); a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })) })()`)
  await sleep(500)
  const chained = await evaluate(`document.querySelector('.full-back .card.full')?.dataset.id`)
  await key('Escape', 'Escape', 27)
  await sleep(600)
  check('a link from a note opened large opens the next one; Esc then closes to the board', chained === R && !(await evaluate(`!!document.querySelector('.full-back')`)))

  // no templates yet: offer to make the tab
  const tplMade = await evaluate(`(async () => {
    const home = document.querySelector('.tab-home'); home.click(); await new Promise((r) => setTimeout(r, 200))
    ;[...document.querySelectorAll('.home-quick .pop-btn')].find((b) => /template/.test(b.textContent)).click()
    await new Promise((r) => setTimeout(r, 150))
    document.querySelector('.dlg .dlg-btn.primary').click()
    await new Promise((r) => setTimeout(r, 400))
    return document.querySelector('#tabs .tab.on .tab-name')?.textContent
  })()`)
  check('"From template" with none yet makes a Templates tab with a Daily template', tplMade === 'Templates' && (await evaluate(`[...document.querySelectorAll('#board .card-title')].some((t) => t.value === 'Daily')`)))
  // a second day uses the template
  const tplNote = await evaluate(`(async () => {
    document.querySelector('.tab-home').click(); await new Promise((r) => setTimeout(r, 200))
    ;[...document.querySelectorAll('.home-quick .pop-btn')].find((b) => /template/.test(b.textContent)).click()
    await new Promise((r) => setTimeout(r, 150))
    return [...document.querySelectorAll('.qs-row .qs-label')].map((l) => l.textContent)
  })()`)
  check('templates are offered in a picker', tplNote.includes('Daily'))
  await enter()
  await sleep(500)
  check('a note from a template fills {{date}}, and lands outside the Templates tab', (await evaluate(`[...document.querySelectorAll('.full-back .rb-h .rb-text')].map((t) => t.textContent).join()`)) === today && (await evaluate(`document.querySelector('#tabs .tab.on .tab-name')?.textContent`)) !== 'Templates')
  await key('Escape', 'Escape', 27)
  await sleep(400)

  // ---------------------------------------------------------------- document outline + share link
  await evaluate(`document.querySelector('#tabs .tab-add').click()`)
  await sleep(60)
  await evaluate(`[...document.querySelectorAll('.menu-item')].find((b) => /Document/.test(b.textContent)).click()`)
  await sleep(80)
  await evaluate(`(() => { const d = document.querySelector('.dlg'); d.querySelector('.dlg-input').value = 'Essay'; d.querySelector('.dlg-btn.primary').click() })()`)
  await sleep(300)
  await evaluate(`document.querySelector('.page-body').focus()`)
  await type('# Intro')
  await enter()
  await type('one two three four five')
  await sleep(400)
  const outline = await evaluate(`({ items: [...document.querySelectorAll('.page-outline .outline-item')].map((b) => b.textContent), stats: document.querySelector('.outline-stats')?.textContent })`)
  check('a document shows its headings and word count', outline.items[0] === 'Intro' && /^6 words · 1 min read$/.test(outline.stats))

  // ---------------------------------------------------------------- To-do: from notes, board view
  await evaluate(`document.querySelector('#tabs .tab-add').click()`)
  await sleep(60)
  await evaluate(`[...document.querySelectorAll('.menu-item')].find((b) => /To-do/.test(b.textContent)).click()`)
  await sleep(80)
  await evaluate(`(() => { const d = document.querySelector('.dlg'); d.querySelector('.dlg-input').value = 'Tasks'; d.querySelector('.dlg-btn.primary').click() })()`)
  await sleep(500)
  const from = await evaluate(`[...document.querySelectorAll('.task-from .from-note .task-entry-name')].map((e) => e.textContent)`)
  check('the To-do tab lists checkboxes from notes ("From notes")', from.includes('laundry'))
  await evaluate(`[...document.querySelectorAll('.task-from .from-note')].find((r) => /laundry/.test(r.textContent)).querySelector('.task-check').click()`)
  await sleep(300)
  check('ticking one there ticks it in its note', (await noteBody(W)).includes('- [x] laundry'))
  await evaluate(`document.querySelector('.tasks-views .segment[data-value="board"]').click()`)
  await sleep(100)
  check('the Board view has To do / Doing / Done columns', (await evaluate(`[...document.querySelectorAll('.task-col-h')].map((h) => h.firstChild.textContent).join()`)) === 'To do,Doing,Done')

  // ---------------------------------------------------------------- settings: reminders, import, zip
  await evaluate(`document.getElementById('settings').click()`)
  await sleep(100)
  const st = await evaluate(`({ rem: !!document.querySelector('.settings-menu .remind-on'), imp: !!document.querySelector('.settings-menu .import-btn'), zip: [...document.querySelectorAll('.settings-menu a')].some((a) => a.getAttribute('href') === '/api/export.zip') })`)
  check('settings offer reminders, import and the ZIP download', st.rem && st.imp && st.zip)
  await evaluate(`document.body.click()`)

  check('no native alert/confirm/prompt dialogs were used', h.dialogs() === 0)
  check('no console errors or uncaught exceptions', h.errors.length === 0)
  if (h.errors.length) h.errors.slice(0, 8).forEach((e) => console.log('   !! ' + e))
  void c
} catch (err) {
  console.log('FAIL  harness: ' + err.message)
  failures++
} finally {
  clearTimeout(watchdog)
  await h?.cleanup()
}

console.log('\n' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'))
process.exit(failures === 0 ? 0 : 1)
