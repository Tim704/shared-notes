# Shared Notes

Live collaborative sticky notes for you and your friends, self-hosted on a Raspberry Pi.
Think Google Keep meets a corkboard, with Google-Docs-style live typing: everyone sees
each other's edits land character by character, in real time.

No accounts, no cloud, no database server. One Pi on your LAN, everyone points their
browser at it.

## What it does

- **Tabs** come in four kinds (the + at the end of the tab bar): **sticky notes** ("Ideas",
  "Work", "Shopping", …), a **document**, a **mind map** and a **sketch board**. Add, rename (double-click),
  reorder (drag), archive and delete tabs. Tabs are shared; your last-open tab is
  remembered per device.
- **A real corkboard**: notes float wherever you put them. Drag a note by its header to
  move it, and drag the bottom-right corner to resize it like a window. Positions and
  sizes are shared, so everyone sees the same board.
- **Canvas view (pan & zoom)**: any tab can switch to an endless canvas (tab menu ⋯ →
  *Canvas view*). Drag the background, use two-finger scroll or hold Space to pan;
  Ctrl/⌘ + wheel or pinch to zoom; the corner buttons zoom and fit; the minimap jumps.
  Notes can go anywhere, including left of and above where the board starts. The pan
  and zoom are remembered per device. *Back to the board view* offers to bring stray
  notes back into the window.
- **Alignment**: while dragging, a note snaps to its neighbours' edges and centres
  (pink guide lines; hold Alt to place freely); optionally to a grid too (Settings → Board).
  Shift/Ctrl-click headers, or drag a box on empty board (Shift+drag on the canvas), to
  select several notes. They move together, and a toolbar aligns them (left, centre,
  right, top, middle, bottom), spaces them evenly, matches sizes or tidies them into a
  grid. Each move or alignment is one Ctrl/⌘+Z away from undone.
- **Rich text** in the note body: **bold**, *italic*, underline and strikethrough, and
  lines that are:
  - **bullet lists** (by default alternating • and – by depth: •, then – under it, then •) in six
    styles: • discs, ▪ squares, → arrows, – dashes, 1. numbers,
    a. letters and i. roman numerals. Nested numbers go 1. → a. → i. by default;
  - **checkboxes mixed in with normal text** (a shopping list under a paragraph,
    sub-tasks under a task);
  - **headings**;
  - aligned **left, centre or right**.

  Type `- `, `* `, `1. `, `a. `, `i. `, `-> `, `[] ` or `# ` at the start of a line, or
  use the toolbar. Tab / Shift+Tab nest list items. Enter on an empty item leaves the
  list, and Backspace right after a shortcut undoes it. All of it is CRDT data, so it
  merges like the text does.
- **Folding**: hover a bullet that has points under it and its marker turns into a ▸
  arrow (headings and paragraphs show the arrow at the right edge). Fold it to hide
  them (shows "… 3"), or press Ctrl/⌘+. on the line. Folding is per device, so it never hides
  anything for anyone else, and searching shows folded lines again.
- **Pictures and videos**: paste or drop a picture into a note (or use the 🖼 button).
  It is shrunk to at most 2000 px in the browser, stored on the Pi, and shown in the note.
  Click to see it full size, drag its corner to resize it. A YouTube or Instagram link on a
  line of its own becomes a click-to-load player (privacy-friendly: nothing loads from
  YouTube until you click).
- **Full screen**: the expand button on a note (or double-click its header) opens it large, with its own
  live editor. The back button or Esc closes it, and `#note=<id>&full` links straight to it.
- **Mind map tabs**: the tab's name sits in the middle. Click a node to edit it (Enter adds
  a sibling, Tab a child, Backspace on an empty node removes it), drag a node onto another
  to move it and what hangs off it, pan by dragging, zoom with Ctrl/⌘ + wheel, and save the
  map as PNG or SVG.
- **Document tabs**: one blank page to write on, like Word or Docs, with the same lists,
  checkboxes, headings, pictures and links as notes. Formatting is in the ribbon.
- **Drawing between the notes**: on a sticky-note tab, *Draw* in the ribbon (or the D key)
  turns on ink mode: drag anywhere to draw little characters, arrows or circles in the
  space around the notes. Pick a colour and size, the eraser removes a whole stroke,
  Ctrl/⌘+Z undoes your own strokes, Esc goes back to the notes. The ink sits under the
  notes and pans and zooms with them on the canvas. It does not move when a note moves
  (and on a very narrow window, notes squeezed in from the right can drift from ink drawn
  next to them). Desktop only.
- **The ribbon**: a Word-style toolbar under the tabs, so notes carry no toolbars of their
  own. It acts on the note you last clicked or typed in: text (bold, italic, underline,
  strikethrough, list styles, checkbox, alignment, picture), the note's colour, text size,
  width, *Grow*, pin, archive, delete and *More* (book layout, title size and alignment,
  move to tab, history, favourite colours). With no note being edited it is greyed out.
  Settings → Appearance → *Toolbar* chooses *Always* or *While editing* (it then slides in
  only while you edit). Phones keep the toolbar above the keyboard instead.
- **Light and dark**: the look follows Apple's design language (system font, translucent
  toolbars, grouped settings) and follows your device's appearance. Settings → Appearance
  switches this device between *Automatic*, *Light* and *Dark*. Coloured notes keep their
  colour in shared data and are shown in a deeper shade in the dark theme. Fonts and
  icons ship with the app, so nothing is fetched from the internet and it all works
  offline. `DESIGN.md` documents the tokens.
- **Phones get their own layout**, Google Keep style: a two-column grid of previews
  (pinned notes first; one column if you prefer), a bottom bar (Home, Tabs, Settings), a
  drawer for tabs and a round + button (hold it for a checklist or a new tab). The pages
  form one strip: swipe left and right to move between your tabs, with Home (every tab,
  with search) before the first tab and Settings after the last, and swipe back to the
  notes; pull the grid down to search the current tab. Tap a note to edit it full
  screen with the toolbar above the keyboard. Long-press to select notes (colour, pin,
  archive, delete, move). Swipe a note sideways to archive it (so page swipes start on
  the title, the bottom bar, a gap or a screen edge). Checkboxes in the previews
  can be ticked directly. A phone never moves or resizes notes, so it can't disturb the
  desktop board. The app installs to the home screen (manifest + icons).
- **Tab types** (the + at the end of the tab bar):
  - **NotePad**: sticky notes, drawings and images on a board.
  - **Document**: a full text editor with images.
  - **To-do**: tasks broken into parts (as deep as you like), each with a tick, a due
    date and a progress bar over its smallest parts. List, Week and Month views; the
    tab shows a red count of what is due today or overdue. Mirrored as `todo--<id>.md`.
  - **Sketch Pad**: free drawing with images, more freedom.
  - **Mind map**: brainstorm around a centre. Tab adds an idea and Enter the next one;
    the map lays itself out, but you can drag any bubble anywhere (Tidy puts them back),
    drop one onto another to move it, Alt-drag to link two ideas, and double-click empty
    space for a loose idea. Bubbles take a colour, a shape, a note and a picture, and a
    branch can be sent to a To-do tab as a task with parts. Older mind maps (drawn from
    an outline) are converted the first time they are opened; the outline is kept.
- **Sketch Pads**: draw together on a shared canvas with a pen (quick colour swatches +
  adjustable size), an **eraser**, undo and clear, and drop **text labels** anywhere.
- Real-time editing: when a friend types, draws, or moves a note, you see it happen.
  Concurrent edits merge cleanly (a CRDT, [Yjs](https://github.com/yjs/yjs)).
- Presence: little coloured dots show who is online and who is editing which note.
- Search filters the current tab, and the **home page** (the house button at the left of the tab bar) lists every tab, shows who is
  on each one, and searches across all of them.
- **Safe delete**: deleting a note moves it to the tab's trash and offers Undo. Trash is
  kept for 30 days. Notes and whole tabs can also be **archived**.
- **Collapse** any note to its title (the chevron in its header, or "Collapse all" in the tab bar).
- **Links**: URLs in a note are clickable, and typing `[[` opens a picker to link to
  another note or tab by title (or alias), or to a heading (`[[Note#Heading]]`) or a single
  line (`[[Note^id]]`) in it. Links follow renames, a note opened large lists what links to
  it (and unlinked mentions, with a one-click *Link*), links show a preview on hover, and
  a link to nothing offers to create the note. Ctrl/⌘+K on selected text (or pasting an
  address onto it) makes a labelled link; a pasted address gets its page title.
- **Roadmap 2** (see `FEATURES.md` for the full list): the Ctrl/⌘+K quick switcher, Back
  and Forward through tabs, links and full screen, the `/` slash menu, `@friday`-style
  dates, Alt+Shift+↑/↓ to move lines, highlights, callouts, dividers, checkbox states
  (`[/]` `[-]` `[>]`), `#tags` with a tag list and renaming, search operators (`tag:`,
  `tab:`, `is:todo`, `has:image`, `by:`, `"phrases"`, `-word`), templates, daily notes in a
  *Journal* tab, *Selection → new note* and *Merge into…*, a document outline with word
  count, checkboxes from every note in the To-do tab, a Board (Kanban) view, daily
  reminders by Web Push, aliases, read-only share links, quick capture (API, Android share
  sheet, iOS Shortcut), import (Markdown, Obsidian, Google Keep), a ZIP download with
  pictures, print / PDF and webhooks.
- **Book notes**: two pages side by side (ribbon → More → Layout → Book).
- **Smart arrows**: `->` becomes →, `<-` ←, `=>` ⇒, `--` —. Backspace straight after
  restores what you typed.
- Per note: optional separate **title size** and **title alignment**, and **pin** (pinned
  notes come first on phones and in the widget). Notes **grow with their content** by
  default; resizing one by its corner (or *Grow* in the ribbon) gives it a fixed height.
- **Version history**: ribbon → More → History shows earlier versions of a note from the Pi's git
  history of the Markdown mirror, with one-click restore (lists and checkboxes included).
- **Offline copy**: each browser keeps the board in IndexedDB and the app shell (and any
  picture it has shown) is cached, so the board opens and can be edited with the Pi off.
- **Backups everywhere**: the Pi mirrors every note to Markdown and commits it to git.
  Every device can also make its own backup **without the Pi**: download it as Markdown
  or JSON, or, on desktop Chrome/Edge, **auto-save to a folder** that is rewritten as you
  edit (pictures included). Any tab can be left out of *this device's* backups (tab
  menu ⋯ → *Backed up on this device*). The Pi always keeps everything.
- **Optional password** for when the board is reachable from outside your LAN.
- A **REST API** for scripts, and an **Android app with home-screen widgets** (in the
  sibling `shared-notes-android` folder).
- Everything survives restarts. The whole board is saved to `data/board.bin` on disk.

### Shortcuts (in a note body)

| Action | Shortcut |
| --- | --- |
| Bold / italic / underline | Ctrl/Cmd + B / I / U |
| Strikethrough | Ctrl/Cmd + Shift + S |
| Bullets / numbers / checkbox | Ctrl/Cmd + Shift + 8 / 7 / 9 (or type `- `, `1. `, `[] `) |
| Heading | type `# ` at the start of a line |
| Nest / un-nest a list item | Tab / Shift + Tab |
| Align left / centre / right | Ctrl/Cmd + Shift + L / E / R |
| Tick the checkbox you're on | Ctrl/Cmd + Enter |
| Fold / unfold | Ctrl/Cmd + . |
| Undo / Redo | Ctrl/Cmd + Z / Ctrl/Cmd + Shift + Z |
| Link to a note or tab | type `[[` then pick (`#` after the title for a heading, `^` for a line) |
| Slash menu (headings, lists, divider, callouts, dates, picture, template) | type `/` |
| A date | type `@friday`, `@tomorrow`, `@in 3 days`, `@3 nov`… and a space |
| Link the selected text | Ctrl/Cmd + K |
| Highlight | Ctrl/Cmd + Shift + H |
| Move the line (and what is under it) | Alt + Shift + ↑ / ↓ |
| More checkbox states | type `[/] `, `[-] `, `[>] `, or Alt+click the box |
| Quote / callout | type `> ` (callouts from the `/` menu) |

Anywhere: Ctrl/Cmd + K opens the quick switcher (go to a note or tab; Enter on no match
creates the note).

The ribbon under the tabs has the same: B / I / U / S, a list menu, checkbox, alignment
and picture buttons, plus the note's colour, text size, width, *Grow*, pin, archive, delete
and *More* (layout, title, move to tab, history). In full screen the toolbar sits under the
title and the note's ⋯ has the settings.

On the board (nothing being edited): Ctrl/Cmd+Z undoes the last move, resize or
alignment; Esc clears a selection; D toggles drawing between the notes.

## Requirements

- A Raspberry Pi (any model that runs a current Raspberry Pi OS is fine; a Pi 3 or newer
  is comfortable).
- Node.js 18 or newer.
- All devices on the same local network as the Pi.

Check your Node version:

```bash
node -v
```

If it is older than 18, or missing, install a current one. On Raspberry Pi OS:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## Install and run

Copy this folder onto the Pi (for example with `scp` from your computer):

```bash
scp -r shared-notes pi@<pi-ip>:~/
```

Then on the Pi:

```bash
cd ~/shared-notes
npm install        # installs dependencies
npm run build      # bundles the browser code into public/bundle.js
npm start          # starts the server on port 3000
```

You should see:

```
Shared Notes running on http://0.0.0.0:3000
```

## Open it

Find the Pi's IP address:

```bash
hostname -I
```

Say it prints `192.168.1.42`. On any phone, tablet, or laptop on the same network, open:

```
http://192.168.1.42:3000
```

First visit asks for a display name (stored locally in that browser, change it any time
with the rename button). Share that URL with your friends. Everyone on it sees the same
board live.

## Autostart on boot (recommended)

So the board comes back by itself after a power cut or reboot. Two options, pick one.

### Option A: systemd (built in, no extra tools)

Create the service file:

```bash
sudo nano /etc/systemd/system/shared-notes.service
```

Paste this, adjusting `User` and the two paths if your username or folder differ:

```ini
[Unit]
Description=Shared Notes
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/shared-notes
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now shared-notes
sudo systemctl status shared-notes   # check it is running
```

Logs, if you need them:

```bash
journalctl -u shared-notes -f
```

### Option B: pm2

```bash
sudo npm install -g pm2
cd ~/shared-notes
pm2 start server.js --name shared-notes
pm2 save
pm2 startup            # run the command it prints, to enable boot start
```

## Configuration

Environment variables (all optional):

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on. |
| `HOST` | `0.0.0.0` | Interface to bind (reachable from the LAN). |
| `NOTES_DATA_DIR` | `data/` | Where `board.bin`, the export mirror and pictures live. |
| `NOTES_EXPORT_DIR` | `<data>/export` | Where the readable Markdown mirror is written. |
| `NOTES_MEDIA_DIR` | `<data>/media` | Where pictures pasted into notes are stored. |
| `NOTES_MEDIA_MAX_MB` | `8` | Largest picture upload accepted (the browser shrinks photos first). |
| `NOTES_MIRROR_MS` | `3000` | How long after the last edit the mirror is rewritten. |
| `NOTES_HISTORY` | on | Set to `0` to skip the git history of the mirror. |
| `NOTES_COMMIT_MS` | `60000` | How often (at most) the mirror is committed to git. |
| `NOTES_TRASH_DAYS` | `30` | Deleted notes are purged after this many days (and pictures no note uses, after the same time). |
| `NOTES_PASSWORD` | unset | When set, everyone must enter this password once per browser. |
| `NOTES_PUSH` | on | Set to `0` to turn off reminders (Web Push). Keys and subscriptions live in `<data>/push.json`. |
| `NOTES_PUSH_SUBJECT` | `mailto:notes@localhost.invalid` | Contact sent to push services (`mailto:` or `https:`), e.g. your board's `https://` address. Apple's push service wants a real one. |
| `NOTES_WEBHOOKS` | unset | Comma-separated URLs that get a POST when a note changes. |
| `NOTES_WEBHOOK_SECRET` | unset | When set, each webhook carries `X-Notes-Signature: sha256=<HMAC of the body>`. |
| `NOTES_WEBHOOK_MS` | `5000` | Changes to one note are gathered this long into one webhook call. |

Example, run on port 8080 with a password:

```bash
PORT=8080 NOTES_PASSWORD='something-long' npm start
```

## Data and backups

Four layers, so losing the Pi never means losing the notes:

1. **`data/board.bin`** is the live board (a Yjs binary). It is written shortly after any
   change and again on shutdown. To wipe the board, stop the server, delete it, start again.
2. **`data/export/`** is a human-readable mirror the server rewrites a few seconds after
   any change: one Markdown file per note (`<tab>/<title>--<id>.md`, with the note's
   colour, position and dates in the front matter; lists as `- `, `1. `, `a. `; checkboxes
   as `- [ ]` lines; pictures as `![](../../media/…)` links), one `sketch.svg` per sketch
   tab, `ink.svg` for drawings between notes, `document--<id>.md` / `mindmap--<id>.md` for
   document and mind map tabs, and an `index.json`. If git is
   installed, that folder is a git repo committed about once a minute after edits, which
   is what the in-app History panel reads. Back it up anywhere (`rsync`, a USB stick,
   `git push` to a private remote) and you have every note, readable without this app.
3. **`data/media/`** holds the pictures, named by their content hash. It is deliberately
   *not* in the git history (photos would bloat the SD card's repo); back it up next to
   `data/export/`. Pictures no note mentions any more are removed after `NOTES_TRASH_DAYS`.
4. **Every device keeps its own copy.** With "Keep an offline copy" on (the default,
   Settings → Board), the board is stored in that browser's IndexedDB and the app shell is
   cached, so it opens and works offline. Settings → *Backup on this device* builds a backup
   **in the browser**, so it works with the Pi switched off:
   - *Download all notes* as one Markdown or JSON file;
   - *Auto-save to a folder* (desktop Chrome / Edge): pick a folder once; the same layout as
     `data/export/` (plus the pictures, in `media/`) is rewritten a few seconds after each
     change. After a browser restart the browser asks for permission again (a toast offers
     *Resume*).

   Tabs can be left out of **this device's** backups from the tab menu (⋯ → *Backed up on
   this device*); they are flagged on the home page. This only affects this device's
   downloads and folder: the Pi's mirror and history keep everything, and the offline copy
   in the browser is still the whole board.

The Docker image includes git so history works out of the box. On a bare Pi,
`sudo apt-get install git` if it is missing; without it everything still works, there is
just no History panel.

### Upgrading from an older version

Nothing to do. Old notes load as they are. Whole-note checklists from before todo lines
existed are converted by the Pi the first time it sees them (each item becomes a checkbox
line, keeping its id so scripts that tick items by id keep working). The old `items` list
is left in place for one release so an un-updated browser still shows something.

## Updating the look or behavior

If you edit anything in `src/` or `shared/` (the browser code), rebuild before restarting:

```bash
npm run build
```

Files in `public/` (`index.html`, `style.css`) are served as-is, no build needed for those.

## A note on safety

This app has no accounts and no encryption of its own. On a home LAN that is fine. If you
expose it beyond that (a Cloudflare Tunnel, a port forward), do at least one of these:

- Set `NOTES_PASSWORD`. Every browser then sees a login page once and gets a long-lived
  cookie; the WebSocket, the API and the pictures refuse anything without it. Scripts and
  the Android widgets send `Authorization: Bearer <password>` instead. Make sure the
  tunnel terminates HTTPS so the password and cookie are not sent in the clear.
- Or put something with its own login in front of it (Cloudflare Access, Tailscale, an
  nginx reverse proxy with basic auth).

Without either, anyone who can reach the URL can read and edit everything.

**Share links** (`/s/<token>`) open without the password on purpose: each shows one note
(or document) read-only, rendered on the Pi, and only the pictures that note shows. The
token is random; *Stop sharing* deletes it and the link stops working.

## REST API

Handy for scripts, widgets and automations. JSON in and out; add `?trash=1` to include
deleted notes. GETs that a widget polls send an `ETag` and answer `304` to a matching
`If-None-Match`. Clients that can't send PATCH may POST with `X-HTTP-Method-Override: PATCH`.

| Method and path | Does |
| --- | --- |
| `GET /api/tabs` | List tabs with note counts. |
| `GET /api/tabs/:id` | One tab and all its notes (title, `lines`, plain-text body, colour, position…). Tab `kind` is `notes`, `draw`, `doc` or `mindmap`. |
| `GET /api/tabs/:id?summary=1` | What a widget needs: per note the title, colour, pinned, a snippet and its checkboxes (`{ id, index, text, done }`), pinned first. |
| `POST /api/tabs/:id/notes` | Create a note: `{ "title", "body", "color" }`. In `body`, lines starting `- [ ] `, `- `, `1. `, `# ` become checkboxes, bullets, numbers, headings. Or send `lines: [{ text, type: "p"/"li"/"todo"/"h", done, indent }]`. |
| `GET /api/notes/:id` | One note, with its tab id. |
| `PATCH /api/notes/:id` | Edit: `{ title, body (replace), append (add lines), color, pinned, archived }`. |
| `PATCH /api/notes/:id/check` | Tick or untick a checkbox: `{ "lineId": "…", "done": true }` (or `"index"`, or an old checklist's `"itemId"`). |
| `GET /api/search?q=milk` | Search every tab (operators work: `tag:`, `tab:`, `is:todo`, `has:image`, `by:`, `"…"`, `-word`). |
| `GET /api/history/:noteId` | Earlier versions of a note (needs git). |
| `GET /api/history/:noteId/:commit` | One earlier version's title and body. |
| `GET /api/export.md`, `GET /api/export.json` | Download the whole board. |
| `GET /api/export.zip` | The Markdown mirror (`notes/<tab>/…`) plus every picture (`media/`), in one ZIP. |
| `POST /api/capture` | Quick capture: `{ "text", "note"?, "heading"?, "tab"?, "as"? }` adds the lines to the note called `note` (default `Inbox`, made in the first NotePad or `tab` if missing), at the end or under `heading`. `as: "todo"` / `"li"` makes plain lines checkboxes / bullets. |
| `GET /api/unfurl?url=…` | `{ title }` of a public web page (used for pasted links; private addresses are refused). |
| `GET /api/push/key`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe`, `POST /api/push/test` | Reminders (used by Settings). |
| `GET /share?title=&text=&url=` | The installed app's share target: saves to the Inbox and opens it. |
| `GET /s/<token>` | A read-only shared note or document (no password needed). |
| `POST /api/media` | Upload a picture (raw bytes, `Content-Type: image/png`, `jpeg`, `webp`, `gif` or `avif`) → `{ url: "/media/<sha256>.<ext>" }`. |
| `GET /media/<file>` | A stored picture (cached for a year; it never changes). |

### Quick capture from a phone

- **iPhone:** make a Shortcut with *Get Contents of URL*: method POST, URL
  `https://<your board>/api/capture`, request body JSON with a `text` field set to the
  Shortcut Input (and `note` / `heading` if you like), plus a header
  `Authorization: Bearer <password>` if the board has one. Add it to the share sheet or
  the home screen.
- **Android:** install the app to the home screen; it then appears in the share sheet and
  saves whatever you share to the Inbox note.

## Android app and widgets

The sibling folder `../shared-notes-android` is a small Kotlin app: the board in a
WebView (with deep links, the gallery picker and a sensible back button) plus Glance
home-screen widgets: **a tab** (Keep-style cards with checkboxes you can tick on the
home screen, + to add), **one note**, and a **quick-add** button. They refresh every 15
minutes, right after you use them, and when you leave the app, and keep the last data
when the Pi is off. See its README. *It has not been compiled yet* (it was written
without the Android SDK available).

## How it works (short version)

- The server (`server.js`) serves the static files and runs a WebSocket endpoint at `/ws`.
- All clients share one Yjs document. Edits are sent as small binary updates over the
  WebSocket and merged with a CRDT, so concurrent typing converges without conflicts.
- "Who is here" and "who is editing what" use Yjs awareness, which is ephemeral and not
  saved to disk.
- The document state is serialized to `data/board.bin` (debounced, plus on shutdown) so the
  board persists across restarts. No external database, and no native modules, so it
  installs cleanly on a Pi.
- Tabs are `Y.Map` entries in a `Y.Array` (older boards hold plain objects; both are read),
  so a rename is a single field write that merges cleanly. A tab's `view` is `board` or `canvas`.
- **A note body is one `Y.Text`.** Inline formatting (`b`/`i`/`u`/`s`) is attributes on
  the characters; line structure is attributes on the `'\n'` that ends each line (the
  way Quill does it): `lt` (list item / todo / heading), `mk` (marker style), `ind`
  (indent), `done`, `al` (alignment), `bid` (a stable line id, for folding and for ticking
  a todo through the API). So checkboxes can sit between paragraphs, and every feature
  merges like plain text. See `shared/lines.js`. The editor (`src/richbody.js`) renders
  one element per line, re-using untouched ones, so a playing video or your caret survive
  a friend's edit elsewhere in the note.
- Deleting a note only sets a `deleted` timestamp; the server purges old ones. Archiving
  sets `archived`. Both are ordinary CRDT writes, which is why Undo is trivial.
- Document and mind map tabs keep their text in `doc.getMap('pages')` (tab id →
  `{ title: Y.Text, body: Y.Text }`), with the same line model as note bodies, so a mind map
  is an outline and the same editor and Markdown code serve both.
- Ink between the notes is `doc.getMap('drawings').get('ink:<tabId>')`: strokes
  `{ color, width, points }` in board pixels. Undo uses a `Y.UndoManager` with a local
  origin, so it only takes back your own strokes.
- An unset `autoGrow` means a note grows with its content; a fixed height stores
  `autoGrow: false`.
- Removed features leave their data alone: old arrows (`doc.getArray('edges')`) and the
  old per-note mind map view (`view: 'map'`) are simply no longer shown.
- Moves, resizes and alignments are written with a `layout` origin, so a board-level
  `Y.UndoManager` can undo each as one step without touching anyone's typing.
- The browser keeps the document in IndexedDB via `y-indexeddb` and registers a service
  worker (`public/sw.js`): network first for the app, cache first for pictures.
- `shared/serialise.js` turns the board into the mirror files and exports. The server
  and the browser use the same code, so a device backup matches the Pi's mirror file for
  file.
- Notes carry their own `x`/`y`/`w`/`h`/`z` on the shared doc, so the corkboard layout is
  collaborative; drags and resizes are committed at most once per animation frame. The
  canvas view only adds a per-device pan and zoom on top.
- Sketches are stored as a Yjs array of strokes and text labels in a fixed logical
  coordinate space, scaled to fit any screen.

## Project layout

```
shared-notes/
  server.js            Express static server + WebSocket sync + persistence + trash purge + migrations
  server/api.js        REST API (/api/...)
  server/media.js      Picture uploads (/api/media) and serving (/media/...)
  server/mirror.js     Writes the Markdown / SVG mirror to data/export/
  server/history.js    git commits of the mirror + per-note version lookup
  server/auth.js       Optional shared-password login (NOTES_PASSWORD)
  server/share.js      Read-only share links (/s/<token>), rendered on the server
  server/capture.js    Quick capture into a note (/api/capture, /share)
  server/push.js       Daily reminders by Web Push (VAPID + aes128gcm, no dependency)
  server/unfurl.js     Page titles for pasted links (guarded against private addresses)
  server/webhooks.js   POSTs note changes to NOTES_WEBHOOKS
  server/zip.js        Store-only ZIP writer for /api/export.zip
  shared/lines.js      The line model: lists, todos, headings, markers, outline, embeds, Markdown
  shared/lineops.js    Structural edits on a body (insert/move/delete lines, tick a todo)
  shared/serialise.js  Board → Markdown files / exports / API views (server and browser)
  shared/migrate.js    Old whole-note checklists → todo lines (run by the server)
  shared/links.js      [[Links]], backlinks, mentions, renames, #tags, checkboxes with @dates
  shared/dates.js      "@friday" / "@in 3 days" → dates
  shared/search.js     Search operators (tag:, tab:, is:, has:, by:, phrases, -word)
  shared/tasks.js      The To-do tab's data (tree, progress, dates, Markdown)
  build.js             esbuild bundling step (src/client.js -> public/bundle.js)
  src/client.js        Browser app: tabs, cards, layout, full screen, phone UI, panels, sync wiring
  src/richbody.js      contentEditable <-> Y.Text editor: lines, lists, todos, folding, embeds, links,
                       the [[ and / pickers, dates, labelled links, highlights, moving lines
  src/switcher.js      The Ctrl/Cmd+K quick switcher
  src/preview.js       Hover previews of [[links]]
  src/importer.js      Import of Markdown folders, Obsidian vaults and Google Keep
  src/tasks.js         The To-do tab (List, Week, Month, Board; checkboxes from notes)
  src/mindmap.js       Mind map of an outline (the mind map tab type)
  src/ribbon.js        The Word-style toolbar under the tabs
  src/ink.js           Free-hand ink between the notes of a tab
  src/viewport.js      Canvas view: pan, zoom, minimap
  src/snap.js          Snapping, guide lines, align / distribute / tidy
  src/backup.js        This device's backup: downloads and auto-save to a folder
  src/media.js         Picture upload (shrinks photos first) and lightbox
  src/folds.js         Per-device folded lines
  src/draw.js          Collaborative sketch surface (strokes + text labels)
  src/ui.js            In-app dialogs, menus and toasts
  src/settings.js      Per-device settings (localStorage)
  src/util.js          Helpers: ids, time, colour/contrast, favourites
  tools/make-icons.mjs Regenerates the raster icons (pure JS, no deps)
  public/              index.html, style.css, sw.js, icons, site.webmanifest, bundle.js (built)
  data/board.bin       Saved board state (generated at runtime)
  data/export/         Readable Markdown mirror + git history (generated at runtime)
  data/media/          Pictures (generated at runtime)
  test/                End-to-end, feature, API, password, persistence and browser tests
```

## Tests

```bash
npm test               # e2e, features, api, roadmap, auth and persistence suites, each on a fresh server
npm run test:browser   # the same, plus the headless-Chrome smoke and roadmap tests
```

Every suite starts its own server on a throwaway data directory, so your real board is
never touched. The browser test needs Chrome, Chromium or Edge installed (set `CHROME=path`
if it cannot find one). It drives the editor with real key events (lists, numbering,
checkboxes, alignment, folding, the list menu, Tab, smart arrows, links), full screen and
its deep link, pictures and video embeds, dragging notes, the ribbon (greyed out with no
note, formatting, options, "while editing"), ink between notes (draw, erase, undo),
multi-select + align + undo, document and mind map tabs, the canvas (pan, zoom, negative positions, fit,
back to the board), this device's backup and the tab opt-out, the phone layout (tap,
long-press, pin, drawer), soft delete and Undo, collapse, book layout, the home page,
inline tab rename and the history panel. It asserts that no native browser dialogs and
no console errors appear.

If you ever change the brand mark, regenerate the raster icons with
`node tools/make-icons.mjs` (the SVG favicon is edited directly).
