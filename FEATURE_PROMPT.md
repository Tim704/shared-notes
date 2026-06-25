# Feature build prompt — Shared Notes → idea hub

You are working in `C:\Users\Tim\Desktop\BucketFillers\shared-notes`, a self-hosted, real-time
collaborative sticky-note board. Read these files before touching anything: `src/client.js`,
`server.js`, `public/index.html`, `public/style.css`, `build.js`, `package.json`, `README.md`.

## What the app is (don't break this)
- **Vanilla JS, no framework.** `src/client.js` is bundled by esbuild into `public/bundle.js`
  (`npm run build`). The server (`server.js`) is Express + `ws`.
- **Collaboration is Yjs (CRDT).** A single shared `Y.Doc` syncs over `/ws` and persists to
  `data/board.bin`. Current model:
  - `yNotes = doc.getMap('notes')` → each note is a `Y.Map { title:Y.Text, body:Y.Text, color, created }`
  - `yOrder = doc.getArray('order')` → note ids, newest first
  - `bindText()` two-way-binds a `Y.Text` to a plain `<input>`/`<textarea>` by diffing.
- **Presence/awareness** shows who's online and who's editing which note.
- **HARD CONSTRAINT: pure JS, no native/compiled dependencies.** This deploys to a Raspberry Pi
  (arm64). Any new dependency must be pure JS and must bundle cleanly with esbuild. Prefer adding
  *no* dependencies; hand-roll small things in the existing style ("kept tiny on purpose").
- Keep the existing look/feel (dark UI, paper-coloured cards, Caveat/Schibsted Grotesk fonts) and
  the existing code style (small modules, plain DOM, no build-time magic).

After any change: run `npm run build`, then `npm start`, and verify in the browser. Multi-client
behaviour matters — test with two browser tabs open that edits/formatting/drawings sync live and
survive a server restart (persistence). Update `README.md` for any new features.

---

## Features to implement

Implement all of the following. Where a feature changes the shared data model, make it
**backward-compatible** with existing `data/board.bin` (old notes with no new fields must still load
and render with sensible defaults).

### 1. Rich text formatting (bold, italic, underline, strikethrough)
- Toolbar buttons **and** keyboard shortcuts on the note body: Ctrl/Cmd+B (bold), +I (italic),
  +U (underline), +Shift+X or +Shift+S (strikethrough — pick one, document it).
- **This is the architecturally hard part because the body is a plain `<textarea>` and this is a
  CRDT.** Plain textareas can't hold styled runs. Choose ONE approach and apply it to the note body
  (keep the title plain or give it bold/size only):
  - **Preferred:** replace the body `<textarea>` with a `contentEditable` element bound to the
    existing `Y.Text` using Yjs rich-text **formatting attributes** (`ytext.format(index, len, {bold:true})`
    and delta `insert` with `attributes`). Render the `Y.Text` delta to HTML and apply local
    formatting via `document.execCommand`-free range logic or a tiny custom serializer. Preserve
    caret/selection across remote edits the way `bindText` already does.
  - **Alternative (only if it stays pure-JS and bundles for arm64):** integrate Quill + `y-quill`,
    or ProseMirror + `y-prosemirror`. If you go this route, justify the bundle-size/Pi impact and
    confirm no native deps.
- Formatting must sync between clients and persist. Existing plain-text note bodies must upgrade
  cleanly (treat them as unformatted runs).
- Show active-format state on the toolbar buttons based on the current selection.

### 2. Font size
- Let the user change the body font size (e.g. a small / medium / large control, or a stepper).
  Decide scope: per-note is simplest and most useful — store `fontSize` on the note `Y.Map` and
  apply it to the card. (If you support per-selection sizing, fold it into the rich-text model from
  #1.) Sync + persist + default for old notes.

### 3. Sticky-note size
- Let the user resize a note (e.g. S / M / L width presets, or a drag handle). Store `size` (or
  `w`/`h`) on the note `Y.Map`. The board currently uses CSS multi-column layout
  (`.board { column-width: 208px }`) — make resizing work within that (e.g. presets that span
  column widths) or move to a layout that supports per-card sizing without breaking the masonry feel
  on mobile. Sync + persist.

### 4. Colour — full range + presets/favourites
- Keep the quick swatches but add a **full colour picker** (native `<input type="color">` is pure
  HTML, no dep — use it) so any colour is selectable for a note.
- Add a **favourites/presets** row: the user can save the current colour to favourites and reuse it.
  Favourites are per-user (store in `localStorage`, like the existing `notesUser`) unless you make a
  strong case for sharing them in the doc. Quick-pick from favourites applies to the selected note.
- Ensure text stays readable on light *and* dark chosen colours (auto-pick ink colour by luminance).

### 5. Tabs (make it a hub for different idea categories)
- Add **tabs** so the board is split into named sections (e.g. "Ideas", "Work", "Shopping",
  "Sketches"). Tabs are shared collaborative state:
  - Add `yTabs = doc.getArray('tabs')` (each tab: `{ id, name, kind }`, where `kind` is `'notes'` or
    `'draw'` — see #6) and tag each note with its `tabId`. Default/migrate existing notes into a
    first "Ideas" tab.
  - UI: a tab bar (add, rename, reorder, delete tab — deleting asks for confirm and handles its
    notes). Switching tabs filters the board to that tab. Remember the last active tab per user in
    `localStorage`.
  - Search should scope to the active tab (or offer all-tabs search — your call, document it).

### 6. Drawing / sketch
- Support drawing. Cleanest fit: a tab whose `kind === 'draw'` shows a **canvas** instead of the
  note board. Make strokes collaborative + persistent via Yjs:
  - Store strokes in a Yjs structure per draw-tab (e.g. `Y.Array` of stroke objects:
    `{ color, width, points:[[x,y],...] }`, or per-stroke `Y.Array` of points for live streaming).
    Render with Canvas 2D. Pointer events for mouse + touch (Pi users may be on tablets/phones).
  - Tools: pen colour, pen size, eraser, clear-canvas (with confirm). Keep it simple and pure-JS.
  - Strokes must sync live between clients and survive a restart.
  - (If a full collaborative canvas is too large in one pass, ship a single shared canvas per
    draw-tab first, then iterate — but the data must still be Yjs-synced, not local-only.)

### 7. Favicon
- Add a real favicon (the app currently has none). Create an SVG favicon matching the brand (the
  yellow rotated square "brand-dot", accent `#ffd23f`) plus a PNG fallback and an
  `apple-touch-icon`. Reference them from `public/index.html`. Keep files in `public/`.

---

## Deliverables / acceptance
- All seven features working, synced across two clients, and surviving a server restart.
- No native dependencies added; `npm run build` succeeds; bundle works on arm64.
- Old `data/board.bin` still loads (back-compat / migration for tabs, sizes, colours, formatting).
- Mobile layout still works (there's a `@media (max-width: 560px)` block — keep cards usable).
- `README.md` updated with the new features, any new shortcuts, and the chosen rich-text approach.
- Keep commits/changes scoped and the code in the existing minimal style.

## Suggested order (to de-risk)
1. Favicon (#7) — trivial warm-up, confirms build/serve loop.
2. Colour picker + favourites (#4) and per-note font size (#2) and note size (#3) — additive
   fields on the note `Y.Map`, low risk.
3. Tabs (#5) — data-model change with migration; do this before drawing since drawing is a tab kind.
4. Rich text (#1) — the hard one; isolate it and test caret/selection + remote-edit cases hard.
5. Drawing (#6) — new tab kind + collaborative canvas.

Before starting the rich-text and tabs work, briefly describe the data-model changes and migration
plan, then implement. Ask me only if a decision would be expensive to reverse.
