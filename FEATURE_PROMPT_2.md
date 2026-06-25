# Feature build prompt — Shared Notes, round 2 (movable notes, checklists, sketch text)

You are working in `C:\Users\Tim\Desktop\BucketFillers\shared-notes`, a self-hosted, real-time
collaborative sticky-note board. **Read these files before touching anything:** `src/client.js`,
`src/richbody.js`, `src/draw.js`, `src/util.js`, `server.js`, `public/index.html`,
`public/style.css`, `build.js`, `README.md`.

## What the app is (don't break this)
- **Vanilla JS, no framework.** `src/client.js` (+ `src/richbody.js`, `src/draw.js`, `src/util.js`)
  is bundled by esbuild into `public/bundle.js` (`npm run build`). Server is Express + `ws`.
- **Collaboration is Yjs (CRDT).** A single shared `Y.Doc` syncs over `/ws` and persists to
  `data/board.bin`. Current model (see top of `src/client.js`):
  - `yNotes = doc.getMap('notes')` → each note is a `Y.Map { title:Y.Text, body:Y.Text, color,
    created, tabId, fontSize, size }` where `size ∈ {'s','m','l'}`.
  - `yOrder = doc.getArray('order')` → note ids, newest first.
  - `yTabs = doc.getArray('tabs')` → `{ id, name, kind }`, `kind ∈ {'notes','draw'}`.
  - `yDrawings = doc.getMap('drawings')` → `tabId -> Y.Array<stroke>`, each stroke a
    `Y.Map { color, width, mode:'pen'|'erase', points:Y.Array<number> }` (flat `x,y,x,y…` in a
    fixed logical space `1600×1000`, scaled to fit — see `src/draw.js`).
  - The note **body** is a `contentEditable` driven by `bindRichText()` (`src/richbody.js`): one
    `Y.Text` with inline formatting **attributes** `b/i/u/s`; newlines are `'\n'` inside that text.
  - Titles use `bindInput()` (plain `<input>` ↔ `Y.Text`).
- **HARD CONSTRAINT: pure JS, no native/compiled dependencies.** This deploys to a Raspberry Pi
  (arm64) via Docker. Any new dep must be pure JS and bundle cleanly with esbuild. Prefer adding
  **no** dependencies; hand-roll small things in the existing style.
- Keep the look/feel (dark UI, paper-coloured cards, Caveat/Schibsted Grotesk fonts) and the code
  style (small modules, plain DOM, no build-time magic).

After any change: `npm run build`, then `npm start`, and verify in the browser. **Multi-client
behaviour matters** — test with two tabs open that everything syncs live and survives a server
restart (persistence). Keep the `test/features.mjs` + `test/e2e.mjs` suites green and extend
`test/features.mjs` for the new shared state. Update `README.md`.

Where a feature changes the shared data model, make it **backward-compatible** with existing
`data/board.bin`: old notes/strokes lacking new fields must still load and render with sensible
defaults.

---

## Features to implement

### 1. Move & resize notes like windows (free positioning) — THE HARD ONE
Today notes flow in an auto-layout board: `.board` is `display:flex; flex-wrap:wrap` and each card
has a fixed width from `size-s/m/l` (190 / 250 / 366px). Height is intrinsic. There is no stored
position. You are changing this to **free placement**: the user drags a note anywhere and resizes
it like an OS window.

- **Data model:** add `x`, `y`, `w`, `h` to the note `Y.Map`. `w`/`h` are explicit pixel sizes
  (replace the role of `size` for width; keep `size` readable for back-compat). Keep these synced
  + persisted.
- **Board layout:** switch the notes board to a **positioned canvas** — `.board { position:
  relative }` and `.card { position:absolute; left:x; top:y; width:w; height:h }`. The board needs
  a real scrollable area (notes can be placed beyond the first screen) — give it a min size that
  grows to contain the furthest note. Keep `.card.hidden` (search) working.
- **Drag to move:** the **card header (`.card-top`) is the drag handle** (like a title bar) — do
  NOT make the whole card draggable or it fights text editing/selection in the body. Use Pointer
  Events (mouse + touch). Bring the dragged note to the front (see z-order below).
- **Resize:** add a **bottom-right resize grip** (a small corner handle), window-style. Enforce
  sensible min width/height. Body already scrolls (`.card-body { overflow:auto; max-height:50vh }`)
  — let the body fill the card height.
- **Live sync, but don't spam the CRDT:** during a drag/resize, update `x/y/w/h` at most once per
  animation frame (mirror the buffer/`requestAnimationFrame` flush pattern in `src/draw.js`), and
  commit the final value on pointer-up. Two clients dragging different notes must both see the
  motion live.
- **z-order:** add a `z` integer on the note; on focus/drag-start set it to `max(z)+1` and apply via
  `style.zIndex`. (Or reuse `yOrder`/`created` — your call, document it.)
- **Migration / back-compat (critical):** existing notes have no `x/y/w/h`. On first load after this
  ships, **auto-arrange** legacy notes into a tidy grid (pack them left-to-right/top-down) and write
  their positions, instead of stacking every note at `0,0`. New notes get an initial position that
  doesn't overlap the last one (e.g. cascade like new windows). Map old `size` → initial `w`.
- **Mobile fallback (required):** there is a `@media (max-width:560px)` block. Free-floating absolute
  positioning is unusable on a phone. On narrow screens, **fall back to the current stacked/flow
  layout** (ignore `x/y`, full-width cards) so the Pi-on-a-phone case still works. Document this.
- **New-note button** (`#add` → `createNote`) should still work and place the note in view.

This is the feature most likely to regress things — isolate it, and hand-test: drag, resize, two
clients, server restart, search filtering, switching tabs, and the mobile fallback.

### 2. To-do checklist option
Let a note be a checklist of tickable items.

- **Recommended model:** give the note a `kind` (e.g. `'note'` default vs `'todo'`), and for todo
  notes store items in a `Y.Array` on the note `Y.Map`, e.g. `items: Y.Array<Y.Map{ id, text:Y.Text,
  done:boolean }>`. Render each item as a checkbox + an editable text field; toggling `done` and
  editing `text` sync live and persist. Add/remove items, Enter to add the next item, backspace on an
  empty item removes it. (If you'd rather keep ONE body representation, an alternative is line-level
  checkboxes folded into the existing rich `Y.Text` — but the per-line "done" state has nowhere clean
  to live in the inline-attribute model, so the items-array approach is preferred. If you pick the
  inline approach, justify how checked-state is stored and survives concurrent edits.)
- **Toggle:** a control (in the ⚙ popover or the card header) flips a note between prose and checklist.
  Converting prose→todo should split the body into items by line; todo→prose should join them. Don't
  lose text.
- **Back-compat:** notes with no `kind` render as today (rich prose). Done-state and item text must
  sync across clients and survive a restart.

### 3. Move the formatting bar to the BOTTOM of the note
The B/I/U/S toolbar (`.card-fmt`, built in `createCard()`, shown via `.card:focus-within .card-fmt`)
currently sits between the title and the body (`el.append(top, titleEl, fmt, bodyEl, meta)`). Move it
so it sits at the **bottom of the sticky note** (after the body, by the `.card-meta` row / pinned to
the card's bottom edge). It must still only appear while the note is focused, still toggle marks via
`rich.toggleMark`, and still reflect active-format state (the `onState` callback toggling `.on`).
Make sure it doesn't overlap the new resize grip from #1.

### 4. Click anywhere to close the settings popover
The ⚙ options popover (`buildPopover`/`togglePopover`/`closeAllPopovers`) currently only closes on
Escape or by toggling the gear again — there is a `document.addEventListener('click', closeMenus)` for
the tab `+` menu, but **nothing closes the card popover on an outside click** (the popover and gear
both `stopPropagation`). Add: while a popover is open, a click anywhere outside it (and outside its
gear button) closes it — wire a document-level click handler to `closeAllPopovers()` the same way
`closeMenus` works. Clicking inside the popover (changing colour/size/text) must NOT close it; the
gear must still toggle. Keep Escape working.

### 5. Preset pen colours in the sketch
In a sketch tab, the draw bar (`buildDrawBar()` in `src/client.js`) has a native `<input
type="color">`, a width range, pen/eraser/undo/clear. Add a **row of preset colour swatches** for the
pen (like the note colour swatches in the popover): clicking a swatch sets `drawTool.color`, switches
to pen mode, calls `surface.setColor()` + `surface.setMode('pen')`, persists via `saveDrawTool()`, and
updates the bar's active state. Use a small fixed palette that reads well on the canvas (a few darks +
brand `#ffd23f` + a few brights). Optionally also expose per-user pen **favourites** in `localStorage`
(the note favourites in `src/util.js` — `getFavorites`/`addFavorite` — are a pattern to copy, but keep
pen favourites under their own key so they don't mix with note colours).

### 6. Type text on the sketch canvas
Add a **text tool** to the sketch surface (`src/draw.js`) so users can place text labels on the canvas.

- **Data model:** store text objects in the same per-tab structure as strokes. Since strokes are
  `Y.Map`s with a `mode`, add a new object type, e.g. `Y.Map { type:'text', x, y, text, color, size }`
  in logical coordinates (the `1600×1000` space), pushed into the same `yStrokes` array (or a sibling
  array on the tab — your call; if same array, the renderer must branch on `type`/shape).
- **Placing/editing:** a "Text" tool/mode; clicking the canvas drops a caret at that point. Use an
  absolutely-positioned overlay `<input>`/`<textarea>` over the canvas to capture typing, then commit
  to the Yjs object on blur/Enter. Clicking existing text re-opens it for editing. Render committed
  text with `ctx.fillText` in `redraw()`/`drawStroke` (scale font by `size * scale`, colour from the
  object).
- **Sync + persist + erase:** text objects sync live and survive restart. Decide how eraser/undo/clear
  treat text (at minimum: Clear removes everything; Undo can remove the last added text/stroke). Keep
  the `redraw()` loop tolerant of unknown/legacy object shapes.

---

## Deliverables / acceptance
- All six behaviours working, synced across two clients, and surviving a server restart.
- No native dependencies added; `npm run build` succeeds; bundle works on arm64.
- Old `data/board.bin` still loads: legacy notes get auto-positioned (not stacked at 0,0); notes with
  no `kind` render as prose; legacy strokes still render alongside new text objects.
- Mobile (`@media max-width:560px`) still usable — notes fall back to the stacked layout there.
- `test/features.mjs` extended to cover the new shared state (note `x/y/w/h/z` sync, checklist item
  `done` + text sync, canvas text object sync); existing tests stay green.
- `README.md` updated: movable/resizable notes (+ drag-handle and mobile fallback), checklist notes,
  the moved formatting bar, popover close-on-outside-click, pen presets, and sketch text.
- Keep changes scoped and in the existing minimal style.

## Suggested order (to de-risk)
1. **#3 move format bar to bottom** — trivial DOM/CSS reorder; confirms build/serve loop.
2. **#4 click-outside closes popover** — tiny, self-contained fix.
3. **#5 pen colour presets** — additive to the draw bar, no data-model change.
4. **#6 sketch text** — new draw object type; isolated in `src/draw.js`.
5. **#2 checklist notes** — note data-model change with conversion + back-compat.
6. **#1 movable/resizable notes** — the big layout change; do last, behind hand-testing of drag,
   resize, multi-client live motion, z-order, migration of legacy notes, and the mobile fallback.

Before starting #1 and #2, briefly describe the data-model changes and migration plan, then
implement. Ask me only if a decision would be expensive to reverse.
