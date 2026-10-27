# Shared Notes: features

Shared Notes is a self-hosted board of live, shared notes for Tim and friends. It runs at
[notes.timhufnagel.org](https://notes.timhufnagel.org) on a Raspberry Pi. It is Google Keep
meets a corkboard, with Google Docs-style live typing: everyone sees each other's edits land
letter by letter. There are no accounts, no cloud and no database server.

This list describes the app as of commit `8d239e3` (27 Oct 2026). `README.md` has the
setup details, and `ROADMAP_2.md` the planned work.

---

## 1. Tabs

The board is split into tabs, which everyone shares. The **+** at the end of the tab bar
adds one of five kinds:

| Kind | What it is |
|---|---|
| **NotePad** | Sticky notes, drawings and pictures on a corkboard. |
| **Document** | One page to write on, like Word or Docs, with the same lists, checkboxes, headings, pictures and links as notes. |
| **To-do** | Tasks broken into parts, as deep as you like. See section 8. |
| **Sketch Pad** | A shared drawing canvas. |
| **Mind map** | Ideas around a centre. See section 9. |

- **Managing tabs:** add, rename (double-click and type in place), reorder by dragging,
  archive or delete. Each tab can have an icon.
- **Remembered per device:** the tab you had open last.
- **A safe rename:** renaming a tab is a single change to its name field, so two people
  renaming or reordering at once can't duplicate or lose it.

## 2. The corkboard

On a NotePad tab, notes sit wherever you put them:

- **Moving and resizing:** drag a note by its header to move it, and drag its bottom-right
  corner to resize it. Positions and sizes are shared, so everyone sees the same board.
- **Height:** notes grow with their content by default. Resizing one by hand (or *Grow* in
  the ribbon) fixes its height.
- **Snapping:** while you drag, a note snaps to the edges and centres of its neighbours, and
  pink guide lines show the match. Alt places it freely, and there is an optional grid.
- **Selecting several notes:** Shift- or Ctrl-click their headers, or drag a box on an empty
  part of the board. They then move together, and a toolbar can:
  - align them (left, centre, right, top, middle, bottom);
  - space them evenly or match their sizes;
  - tidy them into a grid.
- **Undo for layout:** each move, resize or alignment is undone separately with Ctrl/⌘+Z,
  without touching anyone's typing.
- **Collapsing:** any note can collapse to its title, and "Collapse all" collapses the whole
  tab.

### Canvas view

Any tab can switch to an endless canvas (tab menu ⋯ → *Canvas view*):

- **Pan** by dragging the background, scrolling with two fingers or holding Space.
- **Zoom** with Ctrl/⌘ + wheel or by pinching. The corner buttons zoom and fit everything
  in, and a minimap jumps you around.
- **Notes can go anywhere,** including to the left of and above where the board starts.
- **Per device:** the pan and zoom are remembered on each device.
- **Going back:** *Back to the board view* offers to bring stray notes back into the window.

### Ink between the notes

*Draw* in the ribbon (or the D key) lets you draw small characters, arrows or circles in the
space around the notes:

- **Tools:** a choice of colour and size, and an eraser that removes a whole stroke.
- **Undo:** Ctrl/⌘+Z takes back only your own strokes.
- **Where it sits:** the ink lies under the notes and pans and zooms with them on the
  canvas.
- **Desktop only.**

## 3. Writing in a note

- **Text formatting:** bold, italic, underline and strikethrough.
- **Lists, in seven styles:** dots, squares, arrows, dashes, numbers, letters and roman
  numerals.
  - By default the bullets alternate by depth: •, then – under it, then • again.
  - Nested numbers go 1. → a. → i.
- **Checkboxes mixed in with normal text,** such as a shopping list under a paragraph, or
  sub-tasks under a task.
- **Headings,** and **alignment** (left, centre, right) per line.
- **Typing shortcuts:** start a line with `- `, `* `, `1. `, `a. `, `i. `, `-> `, `[] ` or
  `# ` to start that kind of line.
  - Tab and Shift+Tab nest and un-nest a list item.
  - Enter on an empty item leaves the list.
  - Backspace straight after a shortcut undoes it.
- **Smart arrows:** `->` becomes →, `<-` becomes ←, `=>` becomes ⇒ and `--` becomes —.
  Backspace right after restores what you typed.
- **Folding:** a bullet with points under it can be folded away; it then shows "… 3" for
  the hidden lines.
  - Hover over the bullet to show its fold arrow, or press Ctrl/⌘+. on the line.
  - Folding is per device, so it never hides anything for anyone else.
  - Searching shows folded lines again.
- **Undo and redo** for each note.
- **Merging:** everything above is stored in the shared document, so two people editing the
  same list at once merge cleanly.

### Pictures and video

- **Adding pictures:** paste or drop a picture into a note, or use the 🖼 button.
- **Size and storage:** the browser shrinks it to at most 2000 px before uploading, and the
  Pi stores it.
- **Viewing:** click a picture to see it full size, or drag its corner to resize it.
- **Video:** a YouTube or Instagram link on a line of its own becomes a click-to-load
  player. Nothing loads from YouTube until you click.

### Links between notes

- **Web links:** web addresses in a note can be clicked.
- **Note links:** typing `[[` opens a picker for linking to another note or tab by its
  title. Clicking the link jumps there, in full screen if you started from full screen.

### Options for each note

- **Look:** colour (a full picker with saved favourites), text size, a separate title size
  and title alignment, and three widths.
- **Pin:** pinned notes come first on phones and in the widget.
- **Book layout:** two pages side by side, which suits a question and its answer, or a
  translation (ribbon → More → Layout → Book).
- **Moving:** send a note to another tab.

## 4. Full screen

The expand button on a note, or double-clicking its header, opens the note large, with its
own editor. The back button or Esc closes it. A link ending in `#note=<id>&full` opens a
note straight in full screen.

## 5. The ribbon

A Word-style toolbar under the tabs acts on the note you last clicked or typed in:

- **Text:** formatting, the list styles, checkbox, alignment and picture buttons.
- **The note:** colour, text size, width, *Grow*, pin, archive and delete.
- ***More*:** layout, title options, move to another tab, history and favourite colours.

It is greyed out while no note is being edited. Settings → Appearance → *Toolbar* chooses
whether it shows *Always* or only *While editing*. Phones get a toolbar above the keyboard
instead.

## 6. Working together

- **Live editing:** when a friend types, draws or moves a note, you see it happen. Edits
  made at the same time merge without conflicts (Yjs).
- **Presence:** coloured dots show who is online and who is editing which note.
- **Edit tracking:** each note records who edited it last and when.
- **Your name:** set on your first visit, and changeable at any time.

## 7. Finding things

- **Searching a tab:** the search box filters the current tab.
- **The Home page** (the house at the left of the tab bar):
  - lists every tab and shows who is on each one;
  - searches across all tabs at once;
  - holds the archived tabs.
- **On phones:** pull down on the grid to search the current tab.

## 8. To-do tabs

- **Tasks:** broken into parts as deep as you like, each with a tick, a due date and a
  progress bar that counts its smallest parts.
- **Three views:** List, Week and Month.
- **Due-today badge:** the tab shows a red count of what is due today or overdue.
- **From a mind map:** a mind map branch can be sent to a To-do tab as a task with parts.

## 9. Mind maps and sketches

**Mind map tabs:**
- **The centre:** the tab's name sits in the middle.
- **Adding ideas:** Tab adds an idea under the current one, and Enter the next one beside
  it.
- **Layout:** the map lays itself out, but any bubble can be dragged anywhere, and **Tidy**
  puts them all back.
- **Rearranging:** drop a bubble onto another to move it there. Alt-drag between two ideas
  links them. Double-click empty space for a loose idea.
- **Bubbles:** each takes a colour, a shape, a note and a picture.
- **Export:** save the map as a PNG or SVG.
- **Older maps:** maps drawn from an outline are converted the first time they are opened,
  and the outline is kept.

**Sketch Pads:**
- **Drawing:** a pen with quick colour swatches and an adjustable size, an eraser, undo and
  clear.
- **Text labels:** can be dropped anywhere.
- **Shared:** everyone draws on the same canvas live.

## 10. Phones

Phones get their own layout, in the style of Google Keep:

- **The grid:** a two-column grid of note previews, pinned notes first (one column if you
  prefer). Tap a note to edit it full screen, with the toolbar above the keyboard.
- **Navigation:**
  - a bottom bar (Home, Tabs, Settings), a drawer for the tabs, and a round **+** button;
  - hold **+** for a new checklist or a new tab;
  - swipe left and right to move between tabs, with Home before the first tab and
    Settings after the last.
- **Acting on notes:**
  - long-press to select notes, then colour, pin, archive, delete or move them;
  - swipe a note sideways to archive it;
  - tick checkboxes directly in the previews.
- **Layout is safe:** a phone never moves or resizes notes, so it can't disturb the desktop
  board.
- **Install:** the app can be added to the home screen as an app.

## 11. Safety and history

- **Safe delete:** deleting a note moves it to the tab's trash and offers Undo. The trash
  is kept for 30 days.
- **Archive:** notes and whole tabs can be archived instead of deleted.
- **Version history:** ribbon → More → History lists earlier versions of a note, with
  one-click restore (lists and checkboxes included).
- **A readable copy on the Pi:** the Pi mirrors every note to Markdown files and commits
  them to git about once a minute. Each sketch is also saved as an SVG, and documents and
  mind maps as their own files.
- **Picture cleanup:** pictures that no note uses are removed after 30 days.

## 12. Offline use and backups

- **Offline copy:** each browser keeps the whole board, and the app itself is cached. So
  the board opens and can be edited with the Pi off, and the changes merge when it comes
  back.
- **Backups made in the browser,** which work without the Pi:
  - *Download all notes* as one Markdown or JSON file;
  - *Auto-save to a folder* (desktop Chrome and Edge): the same layout as the Pi's mirror,
    pictures included, rewritten a few seconds after each change.
- **Leaving tabs out:** any tab can be left out of this device's backups. The Pi always
  keeps everything.

## 13. Look and feel

- **Style:** an Apple-style design: the system font, see-through toolbars and grouped
  settings.
- **Light and dark:** these follow the device by default, or can be fixed per device.
  Coloured notes keep their colour and are shown in a deeper shade in the dark theme.
- **Hover tips** on buttons.
- **No browser pop-ups:** every dialog is built into the app.
- **Offline-friendly:** fonts and icons ship with the app, so nothing is fetched from the
  internet.

## 14. Access, API and apps

- **Optional password** (`NOTES_PASSWORD`): each browser logs in once and gets a
  long-lived cookie, which the live connection, the API and the pictures all require.
  Scripts send `Authorization: Bearer <password>` instead.
- **A REST API** for scripts, widgets and automations:
  - list tabs and read their notes;
  - create notes, edit them, add lines to them and tick checkboxes by line;
  - search everything;
  - read a note's history;
  - export the board and upload pictures.

  Polled requests answer `304` when nothing has changed.
- **Android app and home-screen widgets** (in `../shared-notes-android`): the board in an
  app, a tab widget with checkboxes you can tick, a single-note widget and a quick-add
  button. *The app is written but has not been compiled yet.*

## 15. Running it

- **Stack:** Node with Express, ws and Yjs on the server. The browser code is plain
  JavaScript, bundled by esbuild. There is no database: the board is one file,
  `data/board.bin`.
- **Deploy:** Docker Compose on the Pi, behind a Cloudflare tunnel. The image includes git,
  so version history works out of the box.
- **Updates reach browsers at once:** a deploy reaches open browsers straight away, without
  a manual reload.
- **Tests:**
  - `npm test` runs the end-to-end, feature, API, password and persistence suites, each
    against a fresh server;
  - `npm run test:browser` adds a headless-Chrome smoke test of the editor and the main
    screens.
