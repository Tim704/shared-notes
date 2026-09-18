# Roadmap

Written against the code at commit `c75edf8` ("extra features"). Every claim below was
checked in the source, and file:line references point at the real thing.

Sizes: **S** = an afternoon, **M** = a few days, **L** = a week or so, **XL** = weeks.


> **Status (19 Sep 2026).** Everything in sections 0, 2, 4, 5 and the REST half of 6 is
> built, tested and documented in the README. What is left, and why it was skipped in
> this pass, is at the bottom of this file under "Still open".

---

## Where the app actually is

**Architecture.** One `Y.Doc`, one WebSocket at `/ws`, one file `data/board.bin`.
`server.js` is unchanged since the first commit: it is a dumb relay plus a debounced
save. All the intelligence is in the client.

**Shared state** (`src/client.js:237-240`):

| Key | Type | Holds |
| --- | --- | --- |
| `notes` | `Y.Map` | id → note `Y.Map` |
| `order` | `Y.Array` | note ids, newest first |
| `tabs` | `Y.Array` | **plain objects** `{ id, name, kind }` |
| `drawings` | `Y.Map` | tabId → `Y.Array` of strokes and text labels |

A note `Y.Map` carries `title` (`Y.Text`), `body` (`Y.Text` with inline attributes
`b/i/u/s`), `items` (`Y.Array` when it is a checklist), `color`, `created`, `tabId`,
`fontSize`, `size`, `kind`, `x`, `y`, `w`, `h`, `z`.

**Client modules.** `client.js` (~1700 lines: tabs, cards, corkboard drag/resize,
options popover, presence, reconcile), `richbody.js` (a hand-rolled controlled
`contentEditable` over a `Y.Text` with formatting attributes), `draw.js` (canvas sketch
surface in a fixed 1600×1000 logical space), `util.js` (ids, colour maths, favourites).

**Already built, so it is off this list:** tabs with drag-reorder and rename, sketch
tabs with pen/eraser/text/undo, free-positioned notes you drag by the header and resize
by the corner grip, rich text with bold/italic/underline/strikethrough as real CRDT
attributes plus per-note undo, checklists, a full colour picker with saved favourites,
per-note text size and three width presets, search scoped to the tab, presence, Docker
deployment, and two test suites.

---

## 0. Bugs and quick fixes

These are all confirmed present in the current code.

### 0.1 Notes render on top of the top bar and tab bar (S, **do this first**)
This is the "notes overlapping UI" bug and it is a real, reproducible defect.

`.board.free` is `position: relative` with no `z-index`
(`public/style.css:381-384`), so it does **not** create a stacking context. The
absolutely positioned cards therefore compete directly with `.topbar` (`z-index: 50`)
and `.tabbar` (`z-index: 40`) in the root stacking context.

Meanwhile `bringToFront()` (`src/client.js:696-700`) sets `z = maxZ() + 1`, and it runs
on every `focusin`, every header `pointerdown`, every grip `pointerdown` and every gear
click. It does skip the bump when the note is already topmost, so `z` does not grow on
literally every event. But every time you move between two different notes, the newly
focused one takes `maxZ() + 1`, and `createNote` does the same for each new note. So `z`
climbs without bound across a session and nothing ever renormalises it. After roughly
forty of those switches a card outranks the tab bar; after fifty it covers the top bar,
and notes then scroll over the search box and the tab strip.

Two fixes, apply both:
- Give `.board.free` its own `z-index: 1` so the cards are trapped in the board's
  stacking context and can never reach the chrome, whatever `z` grows to.
- Normalise `z` so it stops growing: on `bringToFront`, if `maxZ()` exceeds the note
  count by a wide margin, rewrite every note's `z` to its rank (1..n) in one
  transaction. Cheap, idempotent, and keeps the numbers small for everyone.

### 0.2 Red spell-check underline (S)
`src/richbody.js:24` sets `el.spellcheck = true` explicitly. Flip it to `false`, and
match it on the title input and the checklist item inputs, which inherit the browser
default. `draw.js:30` already sets `spellcheck = false` on the canvas text input, so
that one is fine. Add a per-device setting to turn it back on, default off.

Careful: `richbody.js` has an `onInput` fallback (`richbody.js:342-346`) whose comment
says it exists partly to fold in spellcheck replacements. Turning spell-check off does
not break it, the fallback just fires less often.

### 0.3 Tab key leaves the note (S)
There is no Tab handler anywhere in the codebase. In the `contentEditable` body and in
the checklist item inputs, Tab does the browser default and moves focus to the next
control, so the caret jumps out of the note.

Handle `Tab` and `Shift+Tab` in `richbody.js`'s `onKeyDown`, routing through the same
`replaceRange` path everything else uses so it stays one CRDT operation:
- Tab inserts two spaces at the caret. With a multi-line selection, indent every line.
- Shift+Tab strips up to two leading spaces from the affected lines.
- In a checklist, Tab and Shift+Tab should mean indent and outdent once nesting exists
  (section 3). Until then, make Tab move to the next item, which is at least useful.
- Leave a real Escape-then-Tab path so keyboard users can still escape the field.

### 0.4 Browser dialogs everywhere (S)
There are now **three** `window.confirm`, **four** `window.prompt` and one
`window.alert`:

| Call | Where |
| --- | --- |
| confirm, delete tab | `client.js:404` |
| confirm, delete note | `client.js:763` |
| confirm, clear sketch | `client.js:1522` |
| prompt, first-run name | `client.js:260` |
| prompt, name new tab | `client.js:374` |
| prompt, rename tab | `client.js:387` |
| prompt, display name | `client.js:1686` |
| alert, keep one tab | `client.js:398` |

Replace all of them:
- Build one small in-app modal and one toast, both plain DOM in the existing style.
- Make destructive things **undoable instead of confirmed**. Deleting a note sets
  `deleted: <timestamp>` rather than removing it, the card disappears, and a toast
  offers Undo for about six seconds. A per-tab Trash lists deleted notes with Restore
  and Delete forever. The server purges anything deleted more than thirty days ago.
- Same treatment for clearing a sketch: keep the stroke array, mark a clear point,
  offer Undo.
- Tab rename and the name prompt become inline editing: double-click the tab name and
  type in place, which is better than a modal anyway.

### 0.5 Tab rename and reorder can lose or duplicate a tab (S)
Tabs are plain JavaScript objects in a `Y.Array` (`client.js:239`), so renaming is
delete-then-insert (`client.js:383-396`) and reordering is the same
(`client.js:423-435`). That is not CRDT-safe. Two people renaming the same tab at once
produce two tabs; a rename racing a reorder can drop one. The notes inside survive
because they reference `tabId`, but the tab entry itself is fragile.

Fix: make each tab a `Y.Map` inside the array, so `name` is a mutable field and renaming
never touches array structure. Keep ordering as the array position, and migrate the
existing plain objects on load the same way `ensureDefaultTab` already migrates
(`client.js:323-336`). Even better for ordering: store an `order` float on each tab and
sort by it, so a reorder is a single field write with no structural edit at all.

### 0.6 Arrows that look good (S)
Auto-replace as you type, Google Docs style: `->` becomes →, `<-` becomes ←, `=>`
becomes ⇒, `<->` becomes ↔, `--` becomes —. Do it in `richbody.js` right after the
insert lands, so it goes through Yjs and every client sees the same character.
Backspace immediately after a replacement restores the typed characters. Add a setting
to turn it off.

Curved connector arrows between notes are a different feature and live in section 8.

### 0.7 Custom scroll bars (S)
`public/style.css` only styles two: `scrollbar-width: thin` on the tab bar
(`style.css:240`) and a WebKit thumb on the note body (`style.css:572-579`). The main
page scrollbar and the sketch view are unstyled, so they render as bright system bars
against the dark UI. Add `scrollbar-width` and `scrollbar-color` on `html`, the board
and the draw view, keeping the existing `::-webkit-scrollbar` rules for older WebKit.

### 0.8 Auto-extending note, opt in (S)
In stacked layout the body is capped at `max-height: 50vh` (`style.css:563`); in free
layout the card has an explicit pixel height and the body scrolls inside it. Add
`autoGrow: true` on the note, toggled from the gear popover. When set, the card's height
follows its content and the stored `h` is ignored until you drag the grip again, which
turns it back off. Needs a `ResizeObserver` on the body so remote edits grow the card
too.

### 0.9 Title and body sizes, opt in (S)
One `fontSize` drives both today: the title is hard-wired to body size plus one pixel
(`style.css:551`). Add an optional `titleSize`; when absent, keep the current
plus-one behaviour so nothing changes for existing notes. Expose it as a second stepper
in the gear popover, shown only after you tick "size title separately".

### 0.10 The app is on the public internet with no authentication (S, but urgent)
`docker-compose.yml:1` says cloudflared routes `notes.timhufnagel.org` to this
container, while `README.md:202` still tells you never to expose it because anyone who
reaches it can read and edit everything. Both cannot be true.

Decide and then make the code match:
- **Cloudflare Access** in front of the tunnel is the least work and needs no code. Add
  an allow-list of the handful of people who should get in.
- Or add a shared passphrase: a cookie-gated static handler and a check in the
  WebSocket upgrade in `server.js`. Perhaps thirty lines, no new dependencies, and it
  keeps the no-accounts feel.

Either way, update the safety section of the README so it stops contradicting the deploy.

---

## 1. Phones (M)

Below 560px `freeLayout` goes false (`client.js:662-663`) and `x/y/w/h` are ignored
entirely (`client.js:665-684`). Cards fall back to a flex-wrap flow at 46vw, 47vw or
96vw (`style.css`, mobile block). So a board you carefully arranged on the laptop is a
different board on the phone, which is the "phone app changes sticky note layout"
complaint, and it is deliberate rather than a bug.

Better: keep the arrangement and change the viewport instead.
- Render the same positioned corkboard, wrapped in a pan-and-zoom container. Pinch to
  zoom, drag the background to pan, double-tap a note to zoom it to fit and open it.
- Keep the current stacked flow as an explicit "list view" toggle, remembered per
  device, because it is genuinely nicer for a shopping list.
- Drag and resize already use Pointer Events so they work with touch once enabled; the
  gate is only the `freeLayout` flag.
- This shares all its machinery with infinite canvas (section 8), so do them together
  if you would rather build once.

---

## 2. Local backup, offline, and version history (the "Pi dies" requirement)

Today the only copy is `data/board.bin`, a Yjs binary blob that nothing but this app can
read. Three layers, cheapest first.

### 2a. Readable mirror plus git on the Pi (M)
Server-side, debounced a few seconds after the last change, write a plain-text mirror
next to the binary:

```
data/export/<tab name>/<note title or id>.md
data/export/index.json
```

Each file gets front matter (id, tab, colour, created, position) then the title and
body. Checklists serialise as `- [ ]` and `- [x]` lines. Sketches export as SVG, which
is easy because `draw.js` already stores strokes as point arrays in a fixed logical
space.

Then make `data/export` a git repo and auto-commit every ten minutes when something
changed. That single move buys three things at once: a plain-text backup you can `rsync`
anywhere, a complete version history for free, and the data source for the history UI
below.

Needs a `Y.Text`-delta to Markdown serialiser, about a hundred lines, since the body
carries `b/i/u/s` attributes.

### 2b. Offline-first client (M)
- Add a service worker. There is a `site.webmanifest` already
  (`public/site.webmanifest`) but **no service worker at all**, so the app is not
  actually installable-and-offline, it just has icons.
- Persist the doc in the browser with `y-indexeddb`. Then the app opens instantly, works
  fully offline, and the CRDT merges your offline edits whenever the Pi comes back.
- **Per-tab opt-out**, your "nuance" point: a "keep a copy on this device" toggle in the
  tab menu, default on, stored per device. This is awkward today because everything is
  one `Y.Doc`, so opting a tab out means filtering it out of the local persistence
  rather than simply not syncing it. If per-tab isolation matters a lot, see the note on
  splitting documents below.

### 2c. Readable files on each device (S)
An Export button that downloads a zip of the same Markdown layout, or a single JSON.
On Android it can go straight to Drive through the share sheet. Desktop Chrome can also
do continuous folder sync through the File System Access API: pick a folder once and the
app rewrites changed notes after every edit. Firefox, Safari and Android Chrome do not
support that, which is one more argument for the native app in section 6.

### 2d. Version history UI (M, needs 2a)
- Per note: History in the gear menu opens a panel listing versions from that file's git
  log, with an inline diff and a Restore that writes the old text back as a normal edit,
  so it is itself undoable.
- Per tab: "restore this tab to <time>", which recreates deleted notes from that commit.
- **Who changed what:** identity today is `{ name, color }` in localStorage
  (`client.js:253-266`) with no stable id, so history cannot attribute anything. Add a
  random persistent `id`, and stamp `lastEditedBy` and `lastEditedAt` on the note on
  local edits, debounced. That also lets the card footer say "edited 2m ago by Sam"
  instead of only showing creation time.

Note that `richbody.js` already has a `Y.UndoManager` per note body
(`richbody.js:35`), but it is in-memory, per-session and per-note. It is not history.

### Should the document be split per tab?
Per-tab documents would make the opt-out, archiving and the widget much cleaner, and a
phone would only download the tab it is looking at. But it means rewriting `server.js`
into rooms, changing the WebSocket path to `/ws/<tabId>`, adding a separate meta
document for the tab list, and migrating `board.bin`. That is a solid week.

Recommendation: **do not split yet.** One board on a LAN is small. Revisit it only if
the file grows past a few megabytes or if the per-tab opt-out turns out to matter more
than convenience.

---

## 3. Lists and richer formatting (L)

Today formatting is four inline marks (`richbody.js:15`) and a checklist is a **whole
note mode**: flipping a note to a list converts the body into items and back
(`client.js:579-619`), and the README admits the round trip drops bold and italic.

What you asked for needs block structure, which `Y.Text` with inline attributes cannot
express.

**Recommendation: add a block layer rather than replacing the editor.** Change the body
from one `Y.Text` to a `Y.Array` of block `Y.Map`s:

```
{ id, type: 'p' | 'li' | 'todo' | 'h2', text: Y.Text, indent: 0..5,
  done?: bool, marker?: 'disc'|'square'|'arrow'|'dash'|'decimal'|'alpha'|'roman',
  align?: 'left'|'center'|'right', collapsed?: never (per-device) }
```

Each block's `text` keeps the existing `b/i/u/s` attributes, so `richbody.js` is reused
per block almost unchanged. This is more work than a `Y.Text` but far less than adopting
ProseMirror, and it respects the hard constraint of pure JS with no new dependencies.

What it unlocks, all at once:
- **Bullet styles:** discs, squares, arrows, dashes, `1. 2. 3.`, `a. b. c.`, roman.
  `marker` on the list block, rendered with `list-style-type` and a `::marker` rule for
  arrows and dashes. Typing `- `, `* `, `1. `, `a. ` or `-> ` at the start of a line
  converts the block.
- **Checkboxes mixed with normal text**, which is your explicit ask and is impossible in
  today's whole-note model. A `todo` block sits between paragraphs; ticking it is a
  field write so friends see it tick.
- **Indentation** via `indent`, which makes Tab and Shift+Tab meaningful (section 0.3).
- **Collapsible bullets:** a chevron on any block with more deeply indented blocks under
  it. Keep the collapsed set **per device** in localStorage, keyed by block id, so one
  person folding does not hide content for everyone.
- **Alignment:** `align` per block, left, centre, right. Buttons on the existing
  `.card-fmt` toolbar, plus Ctrl+Shift+L/E/R.
- **Headings** inside the body, a second answer to the title-versus-body size question.

**Migration:** on load, a note with a `Y.Text` body and no block array becomes one `p`
block per line; a `kind: 'todo'` note becomes one `todo` block per item. Keep the old
keys for one release, then drop them.

**Cost to be honest about:** the checklist code (`client.js:1065-1194`), the popover's
type switch, `noteHay` search and `setNoteKind` all get rewritten, and the tests in
`test/features.mjs` need updating. Budget a full week and do it in one go rather than
half-migrating.

---

## 4. Navigation: home page, archive, collapse, links (M each, after tabs harden)

### Home page
A route at `/` showing a grid of tab cards: name, kind, note count, who is on it right
now, recently edited. Pinned tabs first. A search box that searches every tab, not just
the open one, which the current search cannot do (`client.js:1665-1678` filters only
mounted cards). Since everything is in one document, cross-tab search is easy: iterate
`yNotes` and group by `tabId`. A per-device setting decides whether launching opens the
home page or the last tab.

### Archive
Add `archived: true` to the tab record and to individual notes. Archived tabs drop out
of the tab strip and the home grid, and live under an Archived section, still fully
editable when opened. Archiving a note hides it from the board without deleting it,
which gives people something to do other than press ×.

### Collapse a note to its title
A chevron on the card header, plus "collapse all" in the tab bar. Per device, stored in
localStorage. In free layout a collapsed card keeps its `x` and `y` and shrinks to header
height, so the board stays readable when it is crowded. Collapsing bullets is section 3.

### Hyperlinks between notes and tabs
- Auto-linkify URLs in the body and make them clickable.
- Typing `[[` opens a picker over note titles and tab names. Choosing one inserts a link
  whose target is `note://<id>` or `tab://<id>` and whose text is the target's title.
- Clicking navigates: switch tab, scroll the note into view, flash it. Deep links like
  `/t/<tabId>#<noteId>` are also what the Android widget will need.
- Show a "linked from" list at the bottom of each note. Cheap here, because one document
  means every note is already in memory.
- If a target is renamed the link text follows it, because you store the id and look the
  title up at render time. A deleted target renders struck through.

---

## 5. Two-part "book style" notes (M, easier after section 3)

Opt in per note with `layout: 'single' | 'book'`. A book note holds two bodies, left and
right, side by side with a faint spine. Good for question and answer, a translation, or
plan against notes.

- Converting to a book moves the existing body to the left page. Converting back joins
  them with a rule between.
- In free layout a book note simply defaults to a wider `w`; no special layout code is
  needed, which is a nice consequence of the corkboard already being positioned.
- On a phone the two pages become two small tabs at the top of the card.
- A flip card, front and back with an animation, is the same data model with different
  presentation, so it can be a third `layout` value later if you want flashcards.

---

## 6. Android app and home-screen widget (XL)

Android has no widget API for web apps, so a widget means a real app. Keep it thin.

- **App:** a Kotlin WebView pointing at your tunnel URL, with the URL configurable and
  mDNS discovery of the Pi for LAN use. Handle deep links so a widget tap opens the
  right tab or note.
- **Widgets, using Jetpack Glance:** a tab widget that lists one tab's notes with
  tappable checkboxes, a single-note widget, and a quick-add button. Refresh through
  WorkManager, which allows about fifteen minutes minimum, plus an immediate refresh
  when the app opens or a widget action fires. Not live character by character, which is
  fine for a widget.
- **Server side (S, and worth building regardless):** a small REST layer so the widget
  never has to speak Yjs. `GET /api/tabs`, `GET /api/tabs/:id`, `POST /api/tabs/:id/notes`,
  `PATCH /api/notes/:id/check`. Each one applies its change through the server's existing
  `ydoc`, so it merges exactly like a browser edit and persists through the existing save
  path. This also gives you a scripting interface and a way to test without a browser.
- **Do the REST layer first.** It is a day's work, it is useful on its own, and it makes
  the widget mostly a UI exercise.
- Build after section 3, so checkbox state is a block the widget can address.

---

## 7. Infinite canvas, alignment, mind maps (XL, last)

Today the board grows downward only. `updateBoardExtent` (`client.js:702-715`) sets a
minimum height from the lowest note, and both drag and resize clamp `x` to the board
width (`client.js:864`, `client.js:914`), so there is deliberately **no horizontal
room at all**. Your "infinite horizontal scroll" ask is not a small change to this, it
is a different viewport model.

Treat these three as one feature, a Canvas view mode per tab:

- **Infinite pan and zoom.** Drop the `x` clamp, wrap the board in a transformed
  container, pan with space-drag or middle mouse, zoom with wheel or pinch. Replace the
  scroll bar with a minimap, since an endless plane has no meaningful scroll extent.
  Shares everything with the phone work in section 1.
- **Align mechanism.** While dragging, snap to the edges and centres of nearby notes and
  optionally to a grid, with thin guide lines. Add marquee multi-select, then an
  align-and-distribute toolbar and a tidy command. Positions are already shared and
  already throttled to one animation frame (`client.js:841-842`), so multiplayer
  alignment comes almost free.
- **Mind maps**, in two stages:
  1. **Outline to mind map (M).** Once bodies are indented blocks (section 3), render
     any note as a radial tree: the title is the root, each block a node. Automatic
     layout, always tidy, edited by editing the bullets. This covers most of what people
     want from a mind map and reuses section 3 entirely.
  2. **Freeform connectors (L).** Drag from a note's edge to another note to create an
     edge. Store edges in a new `edges` `Y.Array` as `{ from, to, label, style, color }`
     and draw them as an SVG layer of smooth cubic curves with real arrowheads,
     rerouting as notes move. This is where the good-looking arrows finally pay off.

The sketch tab is not the answer here, by the way: `draw.js` is a fixed 1600×1000
logical space scaled to fit (`draw.js:14-15`), so it is a whiteboard, not a canvas.

---

## Suggested order

1. **Section 0**, all of it. Roughly two days, and it removes every bug on your list.
   Start with 0.1 (the overlap bug) and 0.10 (the open tunnel).
2. **Section 2a**, the readable mirror plus git. It is the backup you asked for and it
   quietly delivers version history.
3. **Section 3**, the block model. Everything about lists, checkboxes, alignment and
   folding is gated behind it, so it is the highest-leverage week available.
4. **Section 2b and 2c**, the service worker and offline persistence.
5. **Section 4**, home page, archive, collapse and links.
6. **Section 2d**, the history UI.
7. **Section 1**, phone pan and zoom, or fold it into section 7.
8. **Section 6**, the REST layer first, then the Android app.
9. **Sections 5 and 7**, book notes and the canvas.

```
section 0 ─── section 2a ─── section 2d
    │              │
    │         section 2b/2c
    │
section 0.5 ── section 4
    │
section 3 ─┬── section 5
           ├── section 6
           └── section 7
```

## Housekeeping worth doing along the way

- **There is no `test` script** in `package.json`, though `test/features.mjs`,
  `test/e2e.mjs` and `test/browser-smoke.mjs` all exist. Add one so the suites are
  runnable without remembering paths.
- **`test/browser-smoke.mjs` hard-codes Windows Chrome paths** (`browser-smoke.mjs:14-19`).
  Add the macOS and Linux locations, since you are developing on a Mac and deploying to a Pi.
- **`public/bundle.js` is committed.** That is deliberate so the Pi need not build, but
  it will conflict on every branch. Consider building in the Dockerfile and ignoring it.
- **The two `FEATURE_PROMPT` files still say `C:\Users\Tim\...`.** Harmless, but they
  will mislead anyone reading them next.

## Open questions

- Per-tab documents or keep one document? My recommendation is to keep one until the
  file gets large, and accept that the per-tab backup opt-out is a filter rather than
  true isolation.
- Collapsed state, per device or shared? I recommend per device for both notes and
  bullets.
- Git on the Pi for history, or timestamped binary snapshots? Git gives readable diffs
  and per-note history for free; snapshots are simpler but opaque.
- The block model in section 3 is the biggest single commitment on this list. Worth
  confirming you want mixed checkboxes and indented bullets badly enough, because
  without them most of the formatting asks cannot be built.
- Is the public tunnel intentional? The answer changes whether section 0.10 is urgent or
  can wait.

---

## Still open

Done in this pass (see the README for how each works): every bug and quick fix in
section 0 including the opt-in password; the Markdown mirror, git history, offline copy,
export and the History panel from section 2; the home page, archive, collapse and note
links from section 4; book notes from section 5; and the REST layer from section 6. The
test runner (`npm test`), the Chrome paths in the smoke test and `.gitignore` housekeeping
are also done.

Deliberately not done, because each one either rewrites working code or is a separate
project:

- **Section 3, the block model** (mixed checkboxes and text, `a. b. c.` and arrow
  bullets, per-paragraph alignment, foldable bullets). This replaces the editor's data
  model and the checklist code and needs a migration of every existing body. It is the
  biggest single change on the list and the one most likely to break live boards, so it
  should be its own branch with its own round of testing.
- **Section 1, phone pan-and-zoom.** A viewport rewrite; the current stacked phone layout
  keeps working.
- **Section 6, the Android app and widget.** Native Kotlin, a separate repository. The
  REST endpoints it needs are in place.
- **Section 7, the infinite canvas, align guides and mind maps.** Depends on section 3
  for the outline-to-mind-map view and is weeks of work on its own.
- **Per-tab documents** (the "should the document be split" question). Still recommended
  against until the board file gets large.
- **Per-tab offline opt-out.** With one document the offline copy is all-or-nothing; the
  switch in settings covers the whole board.
