# UI overhaul prompt: Shared Notes in an Apple-style design language

> Paste everything below the line into a fresh session. Line numbers and counts are
> against commit `6c22fec`; treat them as pointers and re-find the code if it has moved.

---

## Role and goal

You are a senior product designer and front-end engineer. Your job is a **complete visual
and interaction overhaul** of the `shared-notes` web app so that it looks and feels like a
first-party Apple app: think Apple Notes, Freeform, Reminders and Finder on macOS, and
Notes / Reminders on iOS. When someone opens it on a Mac or an iPhone, it should feel at
home next to the system apps. On Windows and Android it should still look calm, polished
and consistent.

This is a **design-language overhaul, not a feature rewrite**. Every feature that works
today must still work, in the same place, with the same data. You are changing how things
look, move and respond, plus the small interaction patterns (menus, sheets, toggles,
segmented controls) that make up the Apple feel. You are not changing what the app does.

## Read first, before changing anything

1. `README.md`: the full feature list. Every feature in it needs a home in the new UI.
2. `ROADMAP.md`, top section and "Still open".
3. `public/index.html` (80 lines): the app shell.
4. `public/style.css` (~2,990 lines): all styling. It has grown in layers. Sections such as
   `/* ---- tab bar extras ---- */` and `/* ---- popover extras ---- */` patch earlier
   sections, so the same component is often styled in two or three places.
5. `src/ui.js`: `dialog`, `confirm`, `prompt` and `toast`, the only modal and toast
   primitives. Never use native `alert`, `confirm` or `prompt`.
6. `src/client.js` (~4,200 lines): builds almost all DOM (cards, popovers, menus, tab bar,
   phone chrome, panels, settings). Skim it for `className`, `h(`, and inline `style.`
   writes so you know which classes the JS creates and which styles it sets inline.
7. `src/util.js`: `PAPER` (note colours), `PEN_COLORS`, `PRESENCE`, `inkFor`,
   `inkDimFor`, `hairlineFor`.
8. `src/edges.js` (`EDGE_COLORS`), `src/draw.js`, `src/mindmap.js` (`--mm-*` vars, PNG/SVG
   export colours), `src/viewport.js` (zoom controls, minimap), `src/snap.js` (guide
   lines), `src/richbody.js` (note body lines, lists, checkboxes, link picker),
   `src/media.js` (images, lightbox, embeds), `src/settings.js`.
9. `test/browser-smoke.mjs`: the UI tests. They find elements by class name (see "Selectors
   you must keep" below).
10. `public/sw.js`, `public/site.webmanifest`, `tools/make-icons.mjs`.

Then **take a screenshot of every surface listed in "Surface inventory"** at 1440×900
(desktop) and 390×844 (phone), so you have before-and-after pairs. Run the app with
`npm run dev` on port 3000.

## Project constraints (hard rules)

- **Stack.** Vanilla JS and plain DOM, no framework. `src/*.js` is bundled by esbuild
  (`npm run build`) into `public/bundle.js`. No Tailwind, no CSS-in-JS, no UI kit, no
  runtime dependencies. Plain CSS with custom properties. Modern CSS is fine (nesting,
  `:has()`, `color-mix()`, `@layer`, container queries), as long as it works in the current
  Safari, Chrome, Edge and Firefox.
- **It runs on a Raspberry Pi on a LAN and must work offline.** No CDN fonts, scripts or
  icons at runtime. The current Google Fonts `<link>` breaks offline use and must go.
  Everything ships from `public/` and is cached by `public/sw.js`.
- **Do not touch the data model.** No changes to `shared/`, the Yjs document shape, the
  REST API or the Markdown mirror. Note colours, pen colours and arrow colours are stored as
  hex strings in shared data, so existing notes keep their stored colour. Any new palette
  only affects new choices. Any dark-mode adaptation of colours happens **at render time
  only** and never writes back to the doc.
- **No Apple assets.** Do not ship or link SF Pro, SF Symbols, Apple logos or Apple
  trademarks. Their licences forbid use outside Apple platforms. Get the look through the
  system font stack and original or permissively licensed icons (details below).
- **Keep the JS ↔ CSS contract.** Restyle through CSS wherever you can. If a class or ID
  must change, update every reference in `src/` and `test/` in the same change.
- **Destructive actions stay undoable rather than confirmed** (toast with Undo), as today.
- Do not commit unless asked.

## The design language to follow

Model this on Apple's Human Interface Guidelines. Copy the principles and proportions, not
the pixels.

### Principles

- **Deference.** Content (the notes) is the hero. Chrome is quiet, translucent and recedes.
  There are no heavy borders, no loud colours on controls, and only one accent colour.
- **Clarity.** Strong typographic hierarchy, generous spacing, legible at every size, and
  each control's purpose is obvious.
- **Depth.** Layering through translucent materials, soft shadows and motion that shows
  where things came from and where they went. A sheet slides up from the bottom; a popover
  grows from its anchor.
- **Consistency.** One radius scale, one spacing scale, one type ramp, one motion curve,
  used everywhere. No one-off values.

### Light and dark mode (new)

The app is dark-only today. Ship **both**, following the system by default:

- Add a `theme: 'system' | 'light' | 'dark'` setting to `DEFAULTS` in `src/settings.js`.
  It is per-device, so it lives in localStorage like the other settings. Expose it in
  Settings as a three-way segmented control: **Automatic / Light / Dark**.
- Implement it as `data-theme` on `<html>`: the system value follows
  `prefers-color-scheme`, and an explicit choice overrides it. Set it in an inline
  `<script>` in `<head>` before first paint so the page never flashes the wrong theme.
- Update `<meta name="theme-color">`: two tags with `media="(prefers-color-scheme: …)"`,
  plus JS to update them when the user overrides. Update the manifest `theme_color` and
  `background_color` to match the new light background.
- Set `color-scheme: light dark` so native form controls and scroll bars follow.

### Colour tokens

Replace the current `:root` variables with **semantic** tokens named after Apple's
semantic colours, defined once for light and once for dark. Suggested values (light /
dark):

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` (systemGroupedBackground) | `#f2f2f7` | `#000000` | page / board ground |
| `--bg-elevated` (secondarySystemGroupedBackground) | `#ffffff` | `#1c1c1e` | panels, sheets, popovers |
| `--bg-tertiary` | `#f2f2f7` | `#2c2c2e` | inset fields, grouped rows |
| `--fill` | `rgba(120,120,128,.12)` | `rgba(120,120,128,.24)` | button and field fills |
| `--fill-strong` | `rgba(120,120,128,.20)` | `rgba(120,120,128,.36)` | pressed / selected |
| `--label` | `#000000` | `#ffffff` | primary text |
| `--label-2` | `rgba(60,60,67,.60)` | `rgba(235,235,245,.60)` | secondary text |
| `--label-3` | `rgba(60,60,67,.30)` | `rgba(235,235,245,.30)` | placeholders, disabled |
| `--separator` | `rgba(60,60,67,.29)` | `rgba(84,84,88,.65)` | hairlines (0.5px where supported) |
| `--accent` | `#e6a700` | `#ffd60a` | tint: links, selection, primary buttons, focus |
| `--red` / `--orange` / `--yellow` / `--green` / `--teal` / `--blue` / `--indigo` / `--purple` / `--pink` | Apple system colours, light | Apple system colours, dark | status, presence, swatches |

**Accent.** Use the yellow tint that Apple Notes uses. It keeps this app's identity (the
yellow brand dot) and reads as "Notes". In light mode, check text-on-accent and
accent-on-white contrast. If yellow fails 3:1 for a given use (thin text links on white,
for example), use a darker amber for that use. Primary buttons use the accent fill with
black text.

**Materials (vibrancy).** Bars, popovers, menus, sheets and the phone tab bar use a
translucent material: `background: color-mix(in srgb, var(--bg-elevated) 72%, transparent)`
plus `backdrop-filter: saturate(180%) blur(20px)`. Define `--material-thin`,
`--material-regular` and `--material-thick` tokens. Respect
`@media (prefers-reduced-transparency: reduce)` by switching to opaque fills. Provide an
opaque fallback when `backdrop-filter` is unsupported.

**Note paper colours.** Keep the stored `PAPER` hexes as they are, because notes reference
them. Retune the swatches *offered* for new notes towards softer Apple-style pastels if you
like, but:

- In dark mode, map each **known** `PAPER` hex to a deeper, desaturated dark-mode variant
  at render time: a lookup table in `src/util.js`, applied where the card background is set.
  Unknown or custom hexes render unchanged. `inkFor`, `inkDimFor` and `hairlineFor` must
  run on the *rendered* colour.
- White paper becomes `--bg-elevated` in dark mode.

**Other palettes.** Point `PEN_COLORS`, `EDGE_COLORS`, `PRESENCE`, the snap guide colour
(pink today), the selection colour and the mind-map colours at the Apple system colours.
Grep `src/` for hard-coded hex: about 40 hits, mostly in `util.js`, plus `client.js`,
`draw.js`, `mindmap.js`, `viewport.js` and `edges.js`. Route each one through a token or a
deliberate palette. The sketch canvas and mind-map **exports** need fixed colours that
don't depend on theme, so keep them readable on white.

### Typography

- **Font stack.** `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display",
  "Inter var", "Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`. Apple
  devices get San Francisco natively. Self-host **Inter** (OFL licence; variable woff2, Latin
  subset, under `public/fonts/`, added to the service-worker shell cache) as the
  cross-platform fallback. Use `font-feature-settings: "cv11", "ss01"` for Inter and turn on
  `font-optical-sizing`. For monospace use `ui-monospace, "SF Mono", Menlo, Consolas,
  monospace`.
- **Remove Caveat and Schibsted Grotesk.** The handwritten Caveat wordmark goes. The brand
  becomes the yellow mark plus "Notes" set in the system font, semibold.
- **Type ramp**, based on Apple's text styles, as tokens. Desktop uses the macOS scale,
  phone (≤ 600px) the iOS scale:

| Token | macOS (desktop) | iOS (phone) | Use |
| --- | --- | --- | --- |
| `--t-large-title` | 26/32 bold | 34/41 bold | page titles: Home, phone tab title |
| `--t-title-1` | 22/28 bold | 28/34 bold | panel headings |
| `--t-title-2` | 17/22 bold | 22/28 bold | note titles in full screen |
| `--t-title-3` | 15/20 semibold | 20/25 semibold | note card titles, section headers |
| `--t-headline` | 13/16 bold | 17/22 semibold | list row titles, dialog titles |
| `--t-body` | 13/16 (notes: 14/20) | 17/22 | body, note text |
| `--t-callout` | 12/15 | 16/21 | secondary body |
| `--t-subhead` | 11/14 | 15/20 | menu items, tab labels |
| `--t-footnote` | 10/13 | 13/18 | metadata, hints, timestamps |
| `--t-caption` | 10/13 | 12/16 | badges, counts |

  On desktop, note body text should sit at 14 to 15px for comfortable reading; menus and
  chrome sit at 13px like macOS. Keep the existing per-note title and body size options
  working by mapping them onto this ramp.
- Use tight negative tracking at large sizes (about `-0.02em` at 28px and up) and `0` at
  body sizes, as SF does. Numerals in counts and badges use `font-variant-numeric:
  tabular-nums`.

### Spacing, shape, elevation

- **Spacing:** 4pt grid. Tokens `--s-1: 4px` up to `--s-8: 32px`. Phone side margins are
  16px; desktop content gutters 20 to 24px.
- **Radii** (use the smooth look: `border-radius` plus generous values; real continuous
  corners aren't possible in CSS):
  - note cards 12px
  - popovers and menus 12px (macOS menus: 6px item highlight, inset 5px)
  - dialogs / alerts 14px (iOS-style) or 12px (macOS-style)
  - bottom sheets 16px top corners, with a 36×5 grabber
  - buttons: 6px on desktop (macOS push button) or capsule for primary and phone buttons
  - inputs 8px; search field 10px (iOS) or 7px (macOS)
  - image thumbnails 8px
- **Elevation:** three shadow tokens, all soft and low-opacity, larger in dark mode where
  hairlines do more of the work:
  - `--elev-1` (cards at rest): `0 0.5px 1px rgba(0,0,0,.08), 0 1px 3px rgba(0,0,0,.06)`
  - `--elev-2` (hover, dragging): about `0 4px 16px rgba(0,0,0,.12)`
  - `--elev-3` (popovers, sheets, dialogs): about `0 10px 40px rgba(0,0,0,.18), 0 0 0 0.5px var(--separator)`
- **Hairlines:** 0.5px on high-DPI screens (`@media (min-resolution: 2dppx)`), 1px
  elsewhere.

### Motion

- One house curve: `--ease: cubic-bezier(0.32, 0.72, 0, 1)` (iOS sheet curve) for things
  entering, `--ease-out: cubic-bezier(0.2, 0, 0, 1)` for small state changes. Durations:
  `--dur-fast: 120ms` (press, hover), `--dur: 220ms` (popovers, toggles), `--dur-slow:
  380ms` (sheets, full-screen open and close).
- **Press feedback** on every tappable thing: `transform: scale(.97)` plus a fill change. No
  hover-only affordances on touch devices (`@media (hover: hover)` guards hover styles).
- **Popovers and menus** scale from 0.96 and fade in from their anchor (`transform-origin`
  at the anchor). **Sheets** slide up. **Full-screen note** zooms from the card's rect to
  full size (FLIP), and back on close. **Toasts** slide up from the bottom and stack.
- Notes from other people that appear, move or resize animate smoothly. Your own drag stays
  1:1 with the pointer, with no easing during the drag.
- `@media (prefers-reduced-motion: reduce)`: replace every movement with a short opacity
  fade.

### Iconography

- Replace **every** emoji and Unicode glyph used as an icon with inline SVG: ⚙ ⌂ ☰ ⌕ ✎ ⤢ ✕
  × ⋯ ▸ ⌄ 🖼 + and any others in `index.html` and `src/*.js` (search for them).
- Create `src/icons.js` exporting `icon(name, { size })`, which returns an `<svg>` element.
  Draw the icons in an **SF-Symbols-like style**: 24×24 viewBox, 1.75px stroke, round caps
  and joins, optically balanced, `currentColor`. You may adapt paths from **Lucide**
  (ISC licence; credit it in a comment). Inline the path strings; no package at runtime.
  Do not copy SF Symbols.
- Icons size with the text next to them (`1.15em` in buttons; 22px in the phone tab bar; 17px
  in toolbars) and inherit colour, using the accent for active or selected state.
- Keep `title` attributes and add `aria-label` to every icon-only button.

## Component-by-component spec

Restyle each of these to its Apple counterpart.

1. **Top bar (`.topbar`)** → macOS unified toolbar. 52px tall, translucent material, a
   hairline bottom separator that appears only once the board scrolls under it. Left: the
   brand mark and "Notes". Centre or right: an **iOS/macOS search field** (rounded, filled
   with `--fill`, magnifier icon, clear button, `⌘F` / `Ctrl+F` focuses it). Right: presence
   avatars as overlapping circles with a 2px ring in the bar colour, the connection status
   (a small dot is fine, with a tooltip and an accessible label), your name chip, Settings,
   and a **"New Note" toolbar button** (icon `square.and.pencil` style, accent tint).
2. **Tab bar (`#tabs`, `.tab`)** → Safari/Finder-style tabs or a capsule **segmented
   control** strip that scrolls horizontally. The active tab gets an elevated white or
   `--bg-elevated` pill with `--elev-1`; inactive tabs show as plain text in `--label-2`. Keep
   drag-to-reorder, double-click to rename (inline field styled as a macOS rename field),
   the close `×`, the `+` add button, the home button and the `⋯` tab menu.
3. **Note cards (`.card`)** → Freeform/Notes cards. 12px radius, `--elev-1` at rest,
   `--elev-2` while hovered or dragged, a subtle 0.5px inner hairline for definition on
   light paper. The header (drag handle) shows the title in `--t-title-3` and quiet icon
   buttons (collapse, full screen, options) that fade in on hover on desktop. The active
   card gets an accent focus ring: 3px, offset 2px, like macOS focus rings. The resize grip
   is a subtle diagonal-lines corner. The "being edited by Alice" indicator is a small
   coloured capsule with the person's initial, not a border.
4. **Formatting toolbar** (bottom of a focused note, and above the keyboard on phones) →
   compact macOS-style segmented groups (B I U S | lists ▾ | checkbox | align ▾ | image),
   on material, icons only, 28px targets on desktop and 44px on touch, accent fill for
   active states.
5. **Note options popover (`.card-pop`, the ⚙ on each note)** → a macOS **popover** with an
   arrow pointing at its anchor, organised as grouped sections with headers: Colour (round
   swatches, 24px, with a checkmark on the selected one and a "+" for custom), Text size
   (segmented control), Width (segmented), Layout, View, then a list of actions styled as
   menu rows (Pin, Archive, History, Move to tab ▸, Delete in red). On phones it becomes a
   **bottom sheet**.
6. **Menus (`.menu`, `.menu-item`, tab `⋯` menu, list-style picker, settings menu)** → macOS
   context menus: material background, 12px radius, 5px inner padding, rows 24px tall
   (desktop) with 6px-radius accent-tinted highlight on hover or keyboard focus,
   checkmarks in a leading column, shortcuts right-aligned in `--label-2`, separators as
   hairlines, destructive items in `--red`. Full keyboard navigation (arrows, Enter, Esc,
   type-to-select). On phones, menus become **action sheets** or bottom sheets.
7. **Dialogs (`src/ui.js`: `.dlg-back`, `.dlg`, `.dlg-btn`)** → on desktop, a macOS sheet or
   alert (centred card, app icon optional, bold title, message, buttons right-aligned,
   primary in accent, destructive in red, Esc and Enter work). On phones, an iOS alert
   (centred, 270px wide, stacked or side-by-side buttons separated by hairlines, primary
   bold). Backdrop: `rgba(0,0,0,.2)` light and `.45` dark, with a slight blur. Keep the
   `dialog()` API identical.
8. **Toasts (`.toast`, `.toast-act`)** → an iOS-style banner: a capsule on material at
   bottom centre, an icon, a short message, and an accent-coloured action button ("Undo").
   It auto-dismisses and can be swiped away on touch.
9. **Settings** → a **grouped inset list**, as in iOS Settings and macOS System Settings:
   sections (Appearance, Editing, Board, Backup, Account) with headers and footers in
   `--t-footnote`, rows with leading coloured icon tiles, trailing **switches** (build a
   proper iOS toggle: 51×31 on phone, 38×22 on desktop, green `--green` when on, animated
   knob) for the boolean settings, segmented controls for small enums (theme, phone
   columns), and disclosure chevrons for sub-pages. Add **Appearance → Theme** here.
10. **Overlay panels: Home, hidden or archived notes, Trash, History** → full-height panels
    (desktop: a centred sheet, max-width about 720px; phone: a full-screen pushed view with a
    large title that collapses into the nav bar on scroll). Home's tab list uses grouped
    list rows: title, note count, presence avatars, chevron. History uses a two-pane layout
    on desktop (version list | preview) with a prominent "Restore" button.
11. **Full-screen note (`.full-back`, `.card.full`, `.full-x`, `.full-title`)** → on desktop,
    a large centred document window on material, opened with the zoom transition. On
    phones, an iOS pushed view: nav bar with "‹ Tab name" back button, title, a ⋯ menu,
    and the formatting toolbar docked above the keyboard (use `visualViewport` to stay
    above it, as today).
12. **Phone UI (`#phone-bar`, `#fab`, `#drawer`, the Keep-style grid)** → iOS:
    - The phone header becomes an iOS navigation bar with a **large title** (tab name)
      that collapses to an inline title on scroll, and the search field sits under it,
      revealed by pulling down, as in Notes.
    - `#phone-bar` becomes an iOS **tab bar** (49px plus the safe-area inset, material,
      hairline top, icon above a 10px label, accent for the active item).
    - `#fab` becomes an iOS-style compose button. Either keep a floating round button
      restyled with the accent and `--elev-3`, or move "New note" to a toolbar
      compose icon as in Apple Notes. The long-press options (checklist, new tab)
      become an iOS context menu.
    - `#drawer` becomes a **sidebar sheet** (slides from the leading edge with a dimmed
      backdrop, grouped list of tabs, edit button for reorder).
    - The grid of note previews keeps its 1/2-column setting and becomes cards with 12px
      radius and 12px gaps. Long-press selection mode shows round selection checkmarks in
      the corner (iOS Photos style) and a bottom toolbar of actions.
    - Swipe-to-archive gets an iOS swipe action reveal (coloured action behind the card).
    - Respect `env(safe-area-inset-*)` everywhere. All touch targets are at least 44×44.
13. **Selection toolbar (`#sel-bar`)** and alignment controls → a floating capsule toolbar
    on material, centred at the bottom, with grouped icon buttons (align left, centre,
    right | top, middle, bottom | distribute | match size | tidy).
14. **Canvas view (`.plane`, `.vp-ctrls`, `.vp-btn`, `.vp-map`)** → Freeform-like. Board
    background is `--bg` with a very faint dot grid (theme-aware). Zoom controls are a
    small capsule (−, percentage, +, fit) at bottom-left on material. The minimap is a
    rounded material card with a translucent viewport rectangle in the accent colour.
15. **Arrows between notes (`.edges`, `.edge-line`, `.edge-label`)** → 2px strokes in
    `--label-2` by default, rounded caps, refined arrowheads. Labels are small capsules on
    `--bg-elevated`. The connector handle (the yellow dot today) becomes a small accent
    circle with a white ring that appears on hover. The selected arrow uses the accent and a
    soft glow.
16. **Snap guides and marquee** → guides are 1px accent lines (or `--pink` to match
    Freeform). The marquee is an accent-tinted translucent rectangle with a 1px accent
    border, like Finder.
17. **Sketch view (`#draw-view`, `#draw-bar`)** → a Freeform/Markup-style floating tool
    palette: pen, eraser, text tools as large icon buttons, colour swatches as circles with
    a selection ring, a size slider styled as an iOS slider, undo/redo and clear. The canvas
    stays white (or paper) for legibility in both themes, framed as a document with
    `--elev-1`.
18. **Mind map (`.mm-node`, `.mm-root`)** → rounded capsule nodes, the root node in the
    accent, branch curves in system colours per top-level branch (as in Freeform/MindNode),
    and the same font stack.
19. **Note body (`src/richbody.js`: `.rb-line`, `.rb-check`, `.rb-fold`, `.rb-more`,
    `.rb-picker`, `.rb-pick`, `a.rb-wiki`, `.rb-embed`, `.rb-play`)** →
    - Checkboxes become **round** iOS Reminders-style circles that fill with the accent and
      a white checkmark when ticked, with a spring pop. Ticked lines go to `--label-2`,
      optionally struck through.
    - Bullets, numbers and headings follow Apple Notes: heading weights from the type ramp,
      list markers in `--label-2`, a 22px indent step.
    - Fold chevrons rotate smoothly (▸ to ▾) and only show on hover on desktop.
    - The `[[` link picker is a macOS completion popover. Wiki links are accent-coloured
      with no underline until hover.
    - Images get 8px radius. The lightbox is a dark full-screen material with zoom-from-
      thumbnail. The video embed placeholder is a rounded card with a centred play button
      on material.
20. **Empty state (`#empty`)** → centred SF-style illustration (a simple SVG note glyph in
    `--label-3`), title in `--t-title-2`, body in `--label-2`, and a "New Note" accent
    button.
21. **Scroll bars** → thin and overlay-style, auto-hiding where the platform allows
    (`scrollbar-width: thin`, theme-aware `scrollbar-color`).
22. **Focus.** Every interactive element has a visible `:focus-visible` ring (accent, 3px,
    2px offset, matching radius). Never remove outlines without a replacement.
23. **App icon and manifest** → regenerate the icons with `tools/make-icons.mjs` in an
    Apple-style rounded-square (squircle) shape: a yellow note on a light gradient, or
    the brand mark, with no text. Keep the existing filenames and sizes.

## Selectors you must keep (the tests and the JS depend on them)

`test/browser-smoke.mjs` queries these. Keep them, or update the tests in the same change:

`.card`, `.card.sel`, `.card.full`, `.card-pop.open`, `.pop-btn`, `.pop-select`,
`.icon-btn.opt`, `.resize-grip`, `.menu`, `.menu-item`, `.fmt-menu`, `.toast`,
`.toast-act`, `#tabs .tab.on .tab-name`, `#tabs .tab.on .tab-x`, `#tabs .tab-rename`,
`#tabs .tab-home`, `#tabs .tab-add`, `.tab-tool`, `.settings-menu`, `.backup-md`,
`a[href="/api/export.md"]`, `.full-back`, `.full-x`, `.full-title`, `.home-search`,
`.home-hit`, `.home-tab`, `.home-tab-flag`, `.panel-history`, `.panel-hint`, `.plane`,
`.vp-btn`, `.vp-ctrls`, `.vp-map`, `.edges .edge-line`, `.edges .edge-label`, `.mm-node`,
`.mm-root`, `.rb-line`, `.rb-text`, `.rb-fold`, `.rb-hidden`, `.rb-more`, `.rb-check`,
`.rb-mark`, `.rb-picker`, `.rb-pick`, `a.rb-wiki`, `.rb-embed`, `.rb-play`, `.lightbox`,
plus every ID in `public/index.html`.

Grep `test/` again before you start, in case this list has drifted.

## Surface inventory (screenshot each one, before and after, light and dark, desktop and phone)

Board with several coloured notes · empty board · note being edited with the formatting
toolbar · note options popover · list-style menu · tab `⋯` menu · tab rename · settings ·
backup section · dialog (rename yourself) · confirm-style dialog · toast with Undo · Home
page with search results · archived and hidden notes panel · Trash · version history ·
full-screen note · lightbox · video embed placeholder · `[[` link picker · checklist note
with ticked and unticked items · folded lines · canvas view with minimap and zoom
controls · multi-select with alignment toolbar · snap guides mid-drag · arrows with labels
· arrow edit menu · sketch tab with toolbar · mind map · phone grid · phone drawer · phone
FAB long-press menu · phone selection mode · phone full-screen editor with keyboard ·
offline / reconnecting state · first-visit name prompt.

## How to approach it (phases)

Work in this order and keep the app working after every phase:

1. **Audit.** Read the files above, take the "before" screenshots, and list every
   hard-coded colour, font, radius, shadow and duration in `style.css` and `src/`. Write
   `DESIGN.md` describing the token system you are about to build: colour, type, spacing,
   radius, elevation, motion, materials and icon rules, with the values.
2. **Foundation.** Tokens, light and dark themes, the theme setting, the font stack and
   self-hosted Inter, and the removal of Google Fonts. Restructure `style.css` into ordered
   sections or `@layer`s (`tokens`, `base`, `components`, `views`, `utilities`), and fold
   the "extras" patch sections into their components. Delete dead rules. Splitting into
   several files is fine if you add them all to the service-worker shell list.
3. **Icons.** `src/icons.js`, and replace every glyph.
4. **Primitives.** Buttons, icon buttons, fields, search field, switch, segmented control,
   swatch, menu, popover (with arrow and anchor positioning), sheet, dialog, toast and focus
   ring. Build them as reusable CSS classes and small JS helpers in `src/ui.js`
   (`menu()`, `popover()`, `sheet()` alongside `dialog()` and `toast()`), then move the ad-hoc
   versions in `client.js` onto them.
5. **Desktop chrome and cards.** Top bar, tab bar, cards, formatting toolbar, options
   popover, selection toolbar, empty state.
6. **Panels.** Settings, Home, Trash, archived and hidden notes, History, full screen,
   lightbox.
7. **Canvas, arrows, snap, sketch, mind map**, including palette updates. Check the PNG/SVG
   exports still look right.
8. **Phone.** Navigation bar, tab bar, compose button, sidebar drawer, grid, selection
   mode, swipe actions, sheets in place of popovers, keyboard toolbar, safe areas.
9. **Motion pass.** Transitions, FLIP for full screen, reduced motion.
10. **Polish and QA** (below). Bump `CACHE` in `public/sw.js` (currently
    `shared-notes-shell-v2`) so installed clients pick up the new shell.

## Quality bar: "done" means

- `npm run build`, `npm test` and `npm run test:browser` all pass. Add browser-smoke checks
  for the theme switch (`data-theme` changes, and the card background changes for a known
  paper colour in dark mode) and for one new primitive (a switch toggles a setting).
- No console errors or warnings in Chrome or Safari.
- **Every feature in README.md still works.** Walk through the README feature list item by
  item, in both themes, on desktop and on a phone-width viewport (or a real iPhone over the
  LAN, which is better).
- Two browser windows still sync live (typing, moving, drawing, arrows, presence), and the
  board survives a server restart.
- It works offline: stop the server, reload, and the shell, fonts and icons all load from
  cache.
- Accessibility: WCAG AA contrast for all text in both themes, including the paper colours
  in both themes. Visible focus everywhere. All icon buttons labelled. Full keyboard use of
  menus, dialogs and popovers. 44×44 touch targets on phones. Reduced motion and reduced
  transparency respected. Lighthouse accessibility 95 or higher.
- Performance: no layout thrash on drag (animate `transform` and `opacity` only, no
  `backdrop-filter` on elements that move every frame), and a 100-note board still drags
  at 60fps on a mid-range phone. Blur is limited to bars, menus and sheets, never applied
  to every card.
- Visual consistency check: grep the final CSS for raw hex colours, px font sizes, radii,
  shadows and durations outside the token block. Each one should be gone or justified.
- Deliverables: the "after" screenshots next to the "before" ones (in a folder you name,
  not committed), `DESIGN.md`, an updated README (fonts, theme setting, any changed
  instructions such as "the ⚙ on each note"), and a short summary of anything you could
  not match and why.

## Taste notes (what "Apple-like" means here, and common mistakes)

- **Less, not more.** Remove borders before adding them. Separate with space, fills and
  hairlines, not boxes. If a control can be a plain text button in the accent colour, make
  it one.
- **One accent.** Everything interactive that is "on" or "primary" uses the accent.
  Everything else is grey: `--label`, `--label-2`, `--fill`. Colour belongs to the notes.
- **Don't make it look like a web app wearing an Apple costume.** Avoid glassmorphism
  overload, gradients on buttons, coloured shadows, oversized radii on small controls,
  bouncy animations everywhere, or centred everything. Look at real Apple Notes and Freeform
  side by side with your build and compare spacing, weight and density.
- **Desktop is macOS, not a stretched iPhone.** Compact 13px chrome, hover states, menus
  with keyboard shortcuts, pointer cursor only on links (macOS uses the arrow for buttons).
  The phone is iOS: large titles, 17px body, sheets and big targets.
- **Text is the interface.** Get the type ramp, weights, line heights and secondary-label
  greys right and most of the look follows.
- If a decision is ambiguous, pick what Apple Notes (for notes and lists) or Freeform (for
  the canvas, arrows, sketching) does, and note it in `DESIGN.md`.
