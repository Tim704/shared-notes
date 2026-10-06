# Feature build prompts — Shared Notes, round 3

> **Status (6 Oct 2026): all twelve are built.** See README.md for how each works and
> ROADMAP.md → "Still open" for where the build differs from these prompts. Most notably,
> prompt 3's block model became line attributes on the `'\n'` of one `Y.Text`, and the
> Android app (prompt 12, phase 2) is written but not compiled. These prompts are kept as
> the spec.

One prompt per open item on the wishlist, in build order. Each prompt is meant to be pasted
into a **fresh session together with the "Shared context" section below**. Line numbers are
against commit `90d5ba9`; treat them as pointers and re-find the code if it has moved.

Already done and therefore not here: readable local backups (Markdown mirror + git on the Pi,
IndexedDB offline copy, Markdown/JSON download), typed arrows (`->` → →), the Tab / overlap /
native-dialog / spell-check bugs, version history, home page, archived tabs, collapsing a note
to its title, separate title size, links between notes and tabs, book notes, custom scroll
bars and grow-with-content notes.

| # | Prompt | Size | Needs |
| --- | --- | --- | --- |
| 1 | Per-tab backup opt-out + offline device backup | M | — |
| 2 | Click a note to open it full screen | S–M | — |
| 3 | Bullet styles (and the block model under them) | L | — |
| 4 | Checklist items mixed into normal text | M | 3 |
| 5 | Collapse / expand bullet points | S–M | 3 |
| 6 | Left / centre / right alignment | S | 3 |
| 7 | Embed images and videos | M–L | (3 preferred) |
| 8 | Keep-style phone UI | L | 2 |
| 9 | Infinite horizontal scroll (pan & zoom canvas) | L | — |
| 10 | Align mechanism (snap, multi-select, distribute) | M | 9 |
| 11 | Mind maps | XL | 3, 9 |
| 12 | Android app + home-screen widget | XL | 4 |

---

## Shared context (paste with every prompt)

You are working in the `shared-notes` repo: a self-hosted, real-time collaborative sticky-note
board that runs on a Raspberry Pi in Docker. **Read `README.md` and `ROADMAP.md` first**, then
the files named in the prompt, before changing anything.

- **Stack.** Vanilla JS, no framework. `src/*.js` is bundled by esbuild (`npm run build`) into
  `public/bundle.js`. Server is Express + `ws` (`server.js`, `server/api.js`, `server/mirror.js`,
  `server/history.js`, `server/auth.js`).
- **Data.** One shared `Y.Doc` synced over `/ws`, saved to `data/board.bin`, mirrored to
  Markdown in `data/export/` (git-committed). Notes are `Y.Map`s in `doc.getMap('notes')`
  (`title`/`body`/`body2` are `Y.Text`, body carries inline attributes `b/i/u/s`; checklist notes
  have `items`). Tabs are `Y.Map`s in `doc.getArray('tabs')`. The browser also keeps the doc in
  IndexedDB (`y-indexeddb`) and a service worker (`public/sw.js`) caches the shell.
- **Hard rules.** Pure-JS dependencies only (arm64 Pi, Docker); prefer none. Keep one `Y.Doc`.
  Every data-model change must be **backward-compatible** with existing `board.bin`: new fields
  optional with sensible defaults, migrations idempotent and safe when two clients run them at
  once. Shared edits go through Yjs so peers see them live.
- **House style.** Plain DOM, small modules, the existing dark UI and paper cards. Use
  `src/ui.js` (`dialog`, `confirm`, `prompt`, `toast`), never native browser dialogs. Per-device
  preferences go in `src/settings.js` (`getSettings`/`setSetting`/`onSettingChange`).
  Destructive actions are undoable rather than confirmed.
- **Done means:** `npm run build`, `npm test` and `npm run test:browser` all pass; new behaviour
  has tests in `test/features.mjs` (shared state) and/or `test/browser-smoke.mjs` (UI); you have
  checked with two browser windows that it syncs live and survives a server restart; the
  Markdown mirror (`server/mirror.js`) and REST API (`server/api.js`) still represent the data
  sensibly; `README.md` is updated and the item is ticked off in `ROADMAP.md`. Do not commit
  unless asked.

---

## 1. Per-tab backup opt-out, and a device backup that works with the Pi down

**Goal.** "Notes are backed up locally, constantly, in an accessible file format — allow for
nuance: opt out of specific tabs. Point being if the Pi fails you still have access to your
notes."

**Where it is today.** ⚙ settings → Backup is two links to `/api/export.md` and
`/api/export.json` (`src/client.js` ~2867, built in `server/api.js` `/export.md` / `/export.json`
using `grouped`, `bodyMarkdown`, `noteView`). Those need the Pi, so the one moment you need a
backup most, it fails. The pure serialisers (`deltaToMarkdown`, `noteToMarkdown`,
`sketchToSvg`, `buildMirror`, `tabRec`, `slugify`) live in `server/mirror.js` next to `fs` code.

**Build.**
1. Move the pure, `fs`-free serialisation (the functions above plus the export builders from
   `api.js`) into a shared module, e.g. `shared/serialise.js`, imported by `server/mirror.js`,
   `server/api.js` and the client. No behaviour change on the server; existing tests stay green.
2. Client-side export: the Backup menu builds Markdown / JSON (and a zip-free "folder" layout
   if you do step 4) from the **local** doc, so it works offline. Keep the server links as a
   secondary "Download from the Pi" option.
3. Opt-out: a tab-menu item (`openTabMenu`, `src/client.js` ~680) "Include in this device's
   backups", checked by default, stored **per device** as a set of excluded tab ids in
   `settings.js`. Excluded tabs are skipped in every device backup. Show a small indicator in the
   tab menu / home page for excluded tabs. The Pi's own mirror and git history stay complete,
   and the IndexedDB offline copy stays whole (this is deliberately a filter, not isolation).
4. "Constantly": on Chromium desktop, an opt-in **Auto-save to a folder** using the File
   System Access API. Pick a folder once; persist the handle in IndexedDB; re-request
   permission on load (needs a user gesture, so show a toast with a button); rewrite changed
   files debounced (~5 s) after edits, same layout as `data/export/` (one `.md` per note,
   `sketch.svg` per sketch tab, `index.json`), deleting files for notes that went away.
   Where the API is missing (Firefox, Safari, Android), hide the option and keep the download.
   Show "last saved to folder: 2 min ago" in settings.

**Edge cases.** Renamed tabs/notes (old files removed, not duplicated); trash and archive
(match the server mirror's choices); permission revoked mid-session; very large boards (don't
rewrite unchanged files — compare content hashes).

**Tests.** Unit-test the shared serialiser against the server mirror output (identical for the
same doc). Browser test: exclude a tab, run the client export, assert its notes are absent and
others present; export still works with the server stopped.

---

## 2. Click a note to open it full screen

**Goal.** "Click note to full screen."

**Where it is today.** Cards are built in `createCard` (`src/client.js` ~1171) with header tools
`fold`, `optBtn`, `del`. There is an overlay/panel system (`openPanel`, `closeOverlay`, ~2286)
used by home, trash and history. Bodies are bound with `bindRichText` (`src/richbody.js`) and
titles with `bindInput`; checklists via `bindTodo`; book notes have `body2`. Deep links use
`#note=<id>` (~2898).

**Build.**
- An expand button (⤢) in `.card-tools`, plus double-click on the card header (not the title
  input), opens the note in a large centred editor over a dimmed board; on narrow screens it
  is truly full screen.
- It edits the **same** Y types live. Either bind a second `bindRichText`/`bindInput` to the
  same `Y.Text`s (check two bindings coexist: each has its own `Y.UndoManager` with the
  `LOCAL` origin — make sure undo in one doesn't replay the other's edits), or move the card's
  DOM into the overlay and back. Pick one, justify it in a comment.
- Supports everything a card does: formatting toolbar, links and `[[` picker, checklists, book
  layout (two pages side by side, stacked on phones), colour as the background, presence
  ("Sam is editing"), the gear popover.
- Close with ✕, Esc, clicking the backdrop and the browser/Android back gesture (push a
  history entry `#note=<id>&full`; popstate closes). Loading that URL opens it full screen.
- If the note is deleted or moved to another tab by someone else while open, close with a
  toast.

**Tests.** Browser: open via button and double-click, type, close, assert the card shows the
text; second client sees edits live; Esc and back close it; the deep link opens it.

---

## 3. Bullet point styles (builds the block model)

**Goal.** "Bullet point options: a, b, c… 1. 2. 3… bullet points, squares, arrows."

**Why this is big.** A body is one `Y.Text` with inline marks (`src/richbody.js`, `MARKS`), so
there is nowhere to store a line's type, marker or indent. Read **ROADMAP.md section 3** — it is
the design for this prompt. Do this on its **own branch**.

**Build.**
- New body representation: `blocks: Y.Array<Y.Map>` on the note, each block
  `{ id, type: 'p' | 'li' | 'h', text: Y.Text, indent: 0..5, marker?: 'disc' | 'square' |
  'arrow' | 'dash' | 'decimal' | 'alpha' | 'roman' }`. Reserve (but do not implement) `todo`,
  `done` and `align` — prompts 4 and 6 add them.
- Editor: reuse `bindRichText` per block's `Y.Text`, or extend it to manage a block list; keep
  every current behaviour (marks and shortcuts, per-note undo across blocks, smart arrows, Tab
  indent, links, `[[` picker, paste, IME). Enter splits a block, Backspace at start merges,
  arrow keys cross blocks, selection across blocks can at least be deleted and formatted.
- Markers: render with `list-style-type` / `::marker` (arrow → `→`, dash → `–`, square →
  `■`). Numbering restarts per run and per indent level (1. → a. → i. when nested by default).
  Typing `- `, `* `, `1. `, `a. `, `i. ` or `-> ` at the start of a paragraph converts it; a
  list button on `.card-fmt` with a marker menu; Tab / Shift+Tab change `indent`; Enter on an
  empty list item outdents, then turns it back into a paragraph.
- **Migration:** a note with `body` and no `blocks` gets one `p` block per line (keep the inline
  marks) the first time it is touched/loaded; book notes do the same for `body2` (`blocks2`).
  Keep `body` readable (and written as a plain-text shadow if cheap) for one release so older
  clients and the mirror don't break; guard against two clients migrating the same note at once
  (deterministic block ids or a migration flag inside one transaction).
- Update everything that reads bodies: `noteHay` search (~915), `setNoteKind` (~851, leave whole-
  note checklists alone for now), `server/mirror.js` (`- `, `1. `, `a. ` Markdown, two-space
  indents), `server/api.js` `noteView`/create note, history restore (`restoreVersion`),
  the home page snippets (`noteSnippet`) and link resolution.

**Tests.** Migration of an old `board.bin` fixture; concurrent typing in two blocks; split/merge
under concurrency; markers and nested numbering render; Markdown round trip; all existing suites
green.

---

## 4. Checklist items mixed into normal text

**Needs prompt 3.**

**Goal.** "Check list integrated with normal text."

**Where it is today.** Checklists are a whole-note mode: `kind: 'todo'` with an `items`
`Y.Array` rendered by `bindTodo` (`src/client.js` ~1575); `setNoteKind` (~851) converts back and
forth and drops formatting.

**Build.**
- A `todo` block type with `done: boolean`, rendered as a checkbox + text in the normal body.
  Ticking writes only `done`. Done items are greyed/struck (style choice, per device toggle to
  hide done items is a bonus).
- Create with `[] ` or `[ ] ` at the start of a line, a ☑ button on `.card-fmt`, or Ctrl+Shift+9.
  Enter on a todo makes another todo; Enter on an empty todo turns it into a paragraph; Tab
  indents (sub-tasks).
- Retire the whole-note mode: migrate `kind: 'todo'` notes to `todo` blocks (keep `items` for one
  release), remove the type switch from the gear popover, delete `bindTodo` when nothing uses it.
- Mirror as `- [ ]` / `- [x]`. `PATCH /api/notes/:id/check` takes a block id (`{ blockId, done }`;
  keep accepting `itemId` for migrated notes). `GET /api/tabs/:id` returns todo blocks so the
  widget (prompt 12) can address them.

**Tests.** Tick syncs between clients; migration of a checklist note; mixed note round-trips
through Markdown; REST tick works.

---

## 5. Collapse and expand bullet points

**Needs prompt 3.**

**Goal.** "Drop-down: compress a bullet point and expand whenever." (Collapsing a whole note to
its title is already done.)

**Build.**
- A chevron beside any block followed by more-indented blocks; clicking hides that subtree and
  shows "… 3 hidden". Also Ctrl+. on the caret's block, and "expand all" in the note's gear menu.
- Collapsed state is **per device**, like the existing note `collapsed` set (`saveCollapsed`,
  `src/client.js` ~949): a localStorage set of block ids. Never written to the doc.
- A hidden block that a peer edits stays hidden; a caret can never land inside a hidden block
  (arrow keys skip it, deleting the parent's text doesn't delete children).
- Searching for text inside a collapsed subtree expands it temporarily.

**Tests.** Collapse persists across reload but not to a second client; children stay intact when
editing the parent; search reveals.

---

## 6. Left / centre / right alignment

**Needs prompt 3.**

**Goal.** "Formatting: all left / right / centre."

**Build.**
- `align: 'left' | 'center' | 'right'` on blocks (absent = left). Three buttons on `.card-fmt`
  that apply to every block in the selection, plus Ctrl+Shift+L / E / R. Buttons show the active
  state through the existing `onState` path.
- A per-note `titleAlign` set from the gear popover.
- Markers and checkboxes stay attached to their text when centred or right-aligned.
- Mirror: Markdown has no alignment, so drop it there but keep it in `index.json` / front matter
  so nothing is lost.

**Tests.** Alignment syncs and survives restart; mixed alignments in one note; Markdown export
unchanged apart from front matter.

---

## 7. Embed images and videos for inspiration

**Goal.** "Embed images / videos (YouTube, Instagram) for inspiration."

**Where it is today.** Nothing; the body is text only. `server/api.js` uses
`express.json({ limit: '1mb' })`; auth is `server/auth.js` (cookie or `Authorization: Bearer`);
the service worker skips `/api/`.

**Build.**
- **Images:** paste, drop or pick a file. The client downscales anything large (canvas, max
  ~2000 px, WebP/JPEG) then uploads to `POST /api/media` (raw body, image MIME types only, size
  cap ~8 MB, configurable `NOTES_MEDIA_MAX_MB`). Store as `data/media/<sha256>.<ext>` (content-
  addressed, so duplicates are free), served at `/media/<file>` behind the same auth. Never put
  image bytes in the `Y.Doc`.
- **Videos:** a YouTube (`youtube.com/watch?v=`, `youtu.be/`, `/shorts/`) or Instagram
  (`/p/`, `/reel/`) URL pasted on its own line becomes an embed: a thumbnail/placeholder card
  that loads the iframe only on click (`youtube-nocookie.com/embed/<id>`,
  `instagram.com/p/<id>/embed`). Other URLs stay links.
- **Storage:** if prompt 3 is done, an `embed` block `{ type: 'embed', kind: 'image' | 'youtube'
  | 'instagram', src, w?, alt? }`; otherwise a note-level `media` `Y.Array`. Say which you chose.
- Click an image for a lightbox; drag a handle to resize within the note; delete is undoable.
- Offline: the service worker caches `/media/*` (cache-first, they are immutable).
- Backup: the mirror writes `![alt](../media/<file>)` and video links; `data/media/` is included
  in the README's backup advice; the git history either commits media or ignores it (decide,
  given the Pi's SD card, and document it). A server job deletes media no note references after
  the trash window (`NOTES_TRASH_DAYS`).

**Tests.** API: upload accepted / wrong type rejected / oversized rejected / auth required.
Browser: paste an image, it appears for a second client and after restart; a YouTube URL turns
into a click-to-load embed.

---

## 8. Phone UI rehaul, Google Keep style

**Needs prompt 2** (its full-screen editor is the phone's note editor).

**Goal.** "Better phone UI (complete rehaul)." Also covers the old bug "phone app changes sticky
note layout": the phone now has its **own** layout by design, Keep-style, instead of a squashed
copy of the corkboard.

**Where it is today.** Below 560 px (`mqStack`, `src/client.js` ~1076) `freeLayout` turns off and
cards flow in the `@media (max-width: 560px)` blocks of `public/style.css`. The desktop corkboard
(`x/y/w/h/z`) must not change.

**Build.**
- A dedicated phone shell when `mqStack` matches: top bar with the tab name (tap → tabs drawer
  with all tabs, archive, home) and search; a **masonry two-column grid** of compact cards (title,
  first lines, checklist preview, image thumbnail, colour), toggle to one column remembered per
  device; a floating **+** button (long-press for "new checklist" / "new sketch tab").
- Tap a card → the full-screen editor from prompt 2 with a bottom toolbar (formatting, colour,
  checklist, more). Long-press a card → selection mode with colour, archive, delete, move to tab.
  Swipe a card sideways → archive with Undo toast.
- Ordering on the phone follows `order` (newest first) with pinned notes first if you add a
  `pinned` flag; the phone **never writes** `x/y/w/h/z`.
- Touch quality: 44 px targets, no hover-only controls, `env(safe-area-inset-*)`, the editor stays
  above the keyboard (`visualViewport` resize), no accidental zoom on input focus (16 px font),
  smooth scrolling, pull-to-refresh disabled where it would fight the board.
- Sketch tabs stay usable: full-width canvas with the draw bar docked at the bottom.
- Make the PWA install nicely: `site.webmanifest` `display: standalone`, theme colour, icons.

**Tests.** Browser smoke at a 390×844 viewport: grid renders, open/edit/close a note, long-press
menu, archive + Undo, tab drawer switching; desktop layout untouched (positions unchanged after a
phone session).

---

## 9. Infinite horizontal scroll (pan and zoom canvas)

**Goal.** "Infinite horizontal scroll."

**Where it is today.** The board only grows downward. Drag clamps `x` to the board width
(`src/client.js` ~1323), resize clamps width (~1373), `applyNoteLayout` clamps on render (~1092),
`updateBoardExtent` (~1132) sets a min-height from the lowest note, `nextNotePos` (~1154) cascades
from the top left. Read **ROADMAP.md section 7**.

**Build.**
- A per-tab view mode `canvas` (tab field, default stays the current board) switched from the tab
  menu. In canvas mode the board is an unbounded plane inside a transformed container.
- Pan: drag empty space, space+drag, middle mouse, two-finger trackpad scroll. Zoom: Ctrl/Cmd+wheel
  and trackpad pinch around the pointer, 10 %–400 %, plus buttons for zoom in/out, 100 % and
  **zoom to fit**. A small minimap in a corner shows all notes and the viewport and is clickable.
- Coordinates are unclamped and may be negative; drag/resize convert pointer deltas by the zoom.
  New notes appear in the centre of the current view.
- Viewport (pan + zoom) is per device per tab in localStorage, restored on load.
- Keep it fast: transform one container, don't re-layout every card per frame; cull nothing yet
  unless profiling says so.
- Switching a tab back to the normal board must still show every note (offer "bring all notes
  into view" that repacks positions into the board width, undoable).
- Mirror / REST already carry `x/y`; make sure negative values are fine there.

**Tests.** Drag a note left past the old edge and it stays there for a second client and after
restart; zoom to fit includes all notes; pan/zoom state isn't shared.

---

## 10. Align mechanism

**Needs prompt 9** (works on the normal board too, but build it on top of the canvas code).

**Goal.** "Align mechanism."

**Build.**
- **Snapping while dragging/resizing:** to other notes' left/centre/right and top/middle/bottom
  within ~6 screen px, with thin guide lines; optional grid snap (per-device setting, grid size
  in settings). Hold Alt to disable.
- **Multi-select:** marquee drag on empty space (in canvas mode, Shift+drag so plain drag still
  pans), Shift/Ctrl-click to add; selected notes move together.
- **Toolbar** when 2+ notes are selected: align left/centre/right/top/middle/bottom, distribute
  horizontally/vertically, match width/height, and "tidy up" (pack into a neat grid in their
  current reading order).
- All position writes for one action in **one** `doc.transact`, committed through the existing
  `rafThrottle` pattern (`src/util.js`, used at `schedulePos` ~1300), and undoable as one step
  (a small board-level `Y.UndoManager` tracking positions from a local origin).

**Tests.** Align left gives identical `x`; distribute gives equal gaps; one undo restores all;
a second client sees a single move.

---

## 11. Mind maps

**Needs prompts 3 and 9.**

**Goal.** "Mind maps." Read **ROADMAP.md section 7** ("Mind maps, in two stages").

**Stage A — outline to mind map (M).**
- Any note can be shown as a mind map (gear → View → Mind map, or a toggle in full screen). The
  title is the root; indented blocks are the tree. Render as SVG with automatic layout (balanced
  left/right like a radial tree), curved connectors, colours by branch.
- Editing in the map edits the blocks: click a node to edit its text, Enter adds a sibling, Tab a
  child, drag a node onto another to reparent (rewrites `indent` and order). The outline and the
  map are always the same data.
- Export the map as SVG/PNG.

**Stage B — connector arrows between notes (L).**
- Drag from a handle on a note's edge to another note to create an edge in a new
  `doc.getArray('edges')`: `Y.Map { id, from, to, label?, color?, style: 'solid' | 'dashed',
  head: 'arrow' | 'none' | 'both' }`.
- Draw on an SVG layer under the cards as smooth cubic Béziers with proper arrowheads, anchored
  to the nearest sides, rerouting live while notes move (piggyback on the drag rAF).
- Click an edge to select: change label, colour, style, direction, delete (undoable). Deleting
  or trashing a note hides its edges; restoring brings them back; hard delete removes them.
- Works in both the normal board and canvas mode; hidden on the phone list view.
- Mirror: edges go in `index.json`; REST `GET /api/tabs/:id` includes them.

**Tests.** Edge creation syncs; moving a note re-routes the curve; trash/restore round trip;
outline ⇄ map edits stay consistent.

---

## 12. Android app and home-screen widget

**Needs prompt 4** (so checkbox state is addressable per block).

**Goal.** "Android widget to access tabs individually, similar to Google Keep."

**Phase 1 — in this repo (S).** The REST API exists (`server/api.js`: tabs, tab detail, create
note, tick, search, history, export) and auth already accepts `Authorization: Bearer
<password>`. Add what a widget needs: `GET /api/notes/:id`, `PATCH /api/notes/:id` (title/body
append), a lightweight `GET /api/tabs/:id?summary=1` (titles, first lines, todo blocks, colours,
`updatedAt`), and an `ETag`/`If-None-Match` so polling is cheap. Tests in `test/api.mjs`. Document
in the README.

**Phase 2 — new repo `shared-notes-android` (XL).** Kotlin, minimal dependencies.
- **App:** a WebView shell around the board URL (configurable on first launch; optional LAN
  discovery via mDNS/NSD for the Pi), keeps the auth cookie, handles deep links
  `sharednotes://tab/<id>` and `…/note/<id>` by loading `#note=<id>`, file upload for images
  (prompt 7), back button closes the full-screen editor first.
- **Widgets (Jetpack Glance):**
  - *Tab widget* — pick a tab when placing it; shows its notes as Keep-like cards with tappable
    checkboxes (tick calls `PATCH /api/notes/:id/check` and updates optimistically).
  - *Single-note widget* — one note's text/checklist.
  - *Quick add* — a button that opens a small input and `POST`s a note to a chosen tab.
  - Tapping a card opens the app at that note.
- Refresh with WorkManager (15-minute minimum), plus immediately after a widget action and when
  the app goes to the background. Cache the last response so the widget shows something with the
  Pi offline, with a "last updated" stamp.
- Credentials (URL + password/bearer) in EncryptedSharedPreferences; HTTPS required unless the
  host is a LAN address.

**Tests.** Phase 1: API tests. Phase 2: unit tests for the API client and widget state mapping,
manual test on a real device documented in that repo's README.
