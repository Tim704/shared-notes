# Shared Notes

Live collaborative sticky notes for you and your friends, self-hosted on a Raspberry Pi.
Think Google Keep meets a corkboard, with Google-Docs-style live typing: everyone sees
each other's edits land character by character, in real time.

No accounts, no cloud, no database server. One Pi on your LAN, everyone points their
browser at it.

## What it does

- **Tabs**: organise everything into tabs — separate lists of notes ("Ideas", "Work",
  "Shopping", …) and **sketch** tabs for free-hand drawing. Add, rename (double-click),
  reorder (drag), and delete tabs. Tabs are shared; your last-open tab is remembered per device.
- **A real corkboard**: notes float wherever you put them. Drag a note by its header to move
  it, and drag the bottom-right corner to resize it like a window. Positions and sizes are
  shared, so everyone sees the same board. (On phones the board falls back to a simple stacked
  layout so it stays usable.)
- **Rich text** in the note body: **bold**, *italic*, underline, and strikethrough, with
  keyboard shortcuts. Formatting is part of the CRDT, so it merges and syncs like the text does.
- **Checklists**: turn any note into a to-do list of tickable items (or back into prose) from
  the **⚙** menu. Press Enter to add the next item, Backspace on an empty item to remove it.
  Checked-off state syncs and persists. (Checklist items are plain text, so converting a
  formatted note to a list keeps the words but not their bold/italic styling.)
- **Per-note styling**: full-range colour picker with quick swatches and your own saved
  favourites, adjustable text size, and three width presets (S / M / L).
- **Sketch boards**: draw together on a shared canvas with a pen (quick colour swatches +
  adjustable size), an **eraser**, undo, and clear — and drop **text labels** anywhere on the
  canvas. Everything syncs live and persists.
- Real-time editing: when a friend types, draws, or moves a note, you see it happen as they go.
- Concurrent edits merge cleanly. Two people in the same note do not clobber each other
  (this uses a CRDT, [Yjs](https://github.com/yjs/yjs), so there are no "last write wins"
  surprises).
- Presence: little colored dots show who is online and who is currently editing which note.
- Search to filter the current tab's notes by text, and a **home page** (the ⌂ button in
  the tab bar) that lists every tab, shows who is on each one, and searches across all of
  them.
- **Safe delete**: deleting a note moves it to the tab's trash and offers Undo. Trash is
  kept for 30 days. Notes and whole tabs can also be **archived** (kept, but out of the way).
- **Collapse** any note to its title (the ⌄ chevron, or "Collapse all" in the tab bar).
  This is per device, so folding a note never hides it for anyone else.
- **Links**: URLs in a note are clickable, and typing `[[` opens a picker to link to
  another note or tab by title. Click a link on an unfocused note to follow it, or
  Ctrl/Cmd+click while editing. `#note=<id>` in the URL deep-links to a note.
- **Book notes**: a note can have two pages side by side (gear → Layout → Book).
- **Smart arrows**: `->` becomes →, `<-` ←, `=>` ⇒, `--` —. Backspace straight after
  restores what you typed. Tab indents (two spaces), Shift+Tab outdents.
- Per note: optional separate **title size**, and **grow with content** (no inner scroll).
- **Version history**: gear → History shows earlier versions of a note from the Pi's git
  history of the Markdown mirror, with one-click restore.
- **Offline copy**: each browser keeps a copy of the board in IndexedDB and the app shell
  is cached by a service worker, so the board opens (and can be edited) with the Pi off.
  Edits sync when it comes back. Turn it off per device in ⚙ settings.
- **Readable backup**: the Pi mirrors every note to `data/export/` as Markdown (and sketches
  as SVG), commits it to a local git repo, and ⚙ → Backup downloads everything as one
  Markdown or JSON file.
- **Optional password** for when the board is reachable from outside your LAN.
- A small **REST API** so scripts or a widget can read tabs, add notes and tick items.
- Everything survives restarts. The whole board is saved to `data/board.bin` on disk.

### Formatting shortcuts (in a note body)

| Action | Shortcut |
| --- | --- |
| Bold | Ctrl/Cmd + B |
| Italic | Ctrl/Cmd + I |
| Underline | Ctrl/Cmd + U |
| Strikethrough | Ctrl/Cmd + Shift + S |
| Undo / Redo | Ctrl/Cmd + Z / Ctrl/Cmd + Shift + Z |
| Indent / outdent | Tab / Shift + Tab |
| Link to a note or tab | type `[[` then pick |

You can also use the little **B / I / U / S** toolbar that appears along the bottom of a note
while it is focused. Set the note **type** (note vs checklist), colour, text size and width from
the **⚙** button on each note; an outside click dismisses that menu.

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
| `NOTES_DATA_DIR` | `data/` | Where `board.bin` and the export mirror live. |
| `NOTES_EXPORT_DIR` | `<data>/export` | Where the readable Markdown mirror is written. |
| `NOTES_MIRROR_MS` | `3000` | How long after the last edit the mirror is rewritten. |
| `NOTES_HISTORY` | on | Set to `0` to skip the git history of the mirror. |
| `NOTES_COMMIT_MS` | `60000` | How often (at most) the mirror is committed to git. |
| `NOTES_TRASH_DAYS` | `30` | Deleted notes are purged after this many days. |
| `NOTES_PASSWORD` | unset | When set, everyone must enter this password once per browser. |

Example, run on port 8080 with a password:

```bash
PORT=8080 NOTES_PASSWORD='something-long' npm start
```

## Data and backups

Three layers, so losing the Pi never means losing the notes:

1. **`data/board.bin`** is the live board (a Yjs binary). It is written shortly after any
   change and again on shutdown. To wipe the board, stop the server, delete it, start again.
2. **`data/export/`** is a human-readable mirror the server rewrites a few seconds after
   any change: one Markdown file per note (`<tab>/<title>--<id>.md`, with the note's
   colour, position and dates in the front matter; checklists as `- [ ]` lines), one
   `sketch.svg` per sketch tab, and an `index.json`. If git is installed, that folder is a
   git repo that is committed about once a minute after edits, which is what the in-app
   History panel reads. Back this folder up anywhere (`rsync`, a USB stick, `git push` it
   to a private remote) and you have every note, readable without this app.
3. **Every browser keeps its own copy.** With "Keep an offline copy" on (the default,
   ⚙ settings), the board is stored in that browser's IndexedDB and the app shell is
   cached, so it opens and works offline. ⚙ → Backup also downloads the whole board as a
   single Markdown or JSON file at any time.

The Docker image includes git so history works out of the box. On a bare Pi,
`sudo apt-get install git` if it is missing; without it everything still works, there is
just no History panel.

## Updating the look or behavior

If you edit anything in `src/` (the browser code), rebuild before restarting:

```bash
npm run build
```

Files in `public/` (`index.html`, `style.css`) are served as-is, no build needed for those.

## A note on safety

This app has no accounts and no encryption of its own. On a home LAN that is fine. If you
expose it beyond that (a Cloudflare Tunnel, a port forward), do at least one of these:

- Set `NOTES_PASSWORD`. Every browser then sees a login page once and gets a long-lived
  cookie; the WebSocket and the API refuse anything without it. Scripts can send
  `Authorization: Bearer <password>` instead. Make sure the tunnel terminates HTTPS so the
  password and cookie are not sent in the clear.
- Or put something with its own login in front of it (Cloudflare Access, Tailscale, an
  nginx reverse proxy with basic auth).

Without either, anyone who can reach the URL can read and edit everything.

## REST API

Handy for scripts, widgets and automations. JSON in and out; add `?trash=1` to include
deleted notes.

| Method and path | Does |
| --- | --- |
| `GET /api/tabs` | List tabs with note counts. |
| `GET /api/tabs/:id` | One tab and all its notes (title, body text, checklist items, colour, position…). |
| `POST /api/tabs/:id/notes` | Create a note: `{ "title": "...", "body": "...", "color": "#..." }`. |
| `PATCH /api/notes/:id/check` | Tick or untick a checklist item: `{ "itemId": "...", "done": true }`. |
| `GET /api/search?q=milk` | Search every tab. |
| `GET /api/history/:noteId` | Earlier versions of a note (needs git). |
| `GET /api/history/:noteId/:commit` | One earlier version's title and body. |
| `GET /api/export.md`, `GET /api/export.json` | Download the whole board. |

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
  so a rename is a single field write that merges cleanly.
- Deleting a note only sets a `deleted` timestamp; the server purges old ones. Archiving
  sets `archived`. Both are ordinary CRDT writes, which is why Undo is trivial.
- The browser keeps the document in IndexedDB via `y-indexeddb` and registers a
  network-first service worker (`public/sw.js`), so online users always get fresh files and
  offline users get the last good copy.
- Rich text is plain Yjs: the note body is a `contentEditable` driven entirely by the app
  and bound to a `Y.Text` that carries inline formatting *attributes* (bold/italic/etc.), so
  formatting travels with the characters under concurrent edits. No editor framework is
  pulled in — it stays small and pure-JS for the Pi.
- Notes carry their own `x`/`y`/`w`/`h`/`z` (position, size and stacking) on the shared doc,
  so the corkboard layout is collaborative; drags and resizes are committed at most once per
  animation frame to keep the CRDT traffic light. Checklist notes store their items as a
  `Y.Array` of `{ text, done }` so ticks and item text sync like everything else.
- Sketches are stored as a Yjs array of strokes and text labels (strokes: colour, width, mode
  and a list of points; text: position, colour, size and the string) in a fixed logical
  coordinate space, scaled to fit any screen. Text is always drawn on top of strokes.
- The first time an old board loads, its notes are migrated into a default "Ideas" tab and
  given tidy grid positions for the corkboard. Old notes without the newer fields still load
  and render with sensible defaults.

## Project layout

```
shared-notes/
  server.js          Express static server + WebSocket sync + disk persistence + trash purge
  server/api.js      REST API (/api/...)
  server/mirror.js   Markdown / SVG mirror of the board (data/export/)
  server/history.js  git commits of the mirror + per-note version lookup
  server/auth.js     Optional shared-password login (NOTES_PASSWORD)
  build.js           esbuild bundling step (src/client.js -> public/bundle.js)
  src/client.js      Browser app: tabs, cards, drag/resize, checklists, popovers, panels, sync wiring
  src/richbody.js    contentEditable <-> Y.Text rich-text binding, Tab, smart arrows, links
  src/draw.js        Collaborative canvas sketch surface (strokes + text labels)
  src/ui.js          In-app dialogs and toasts
  src/settings.js    Per-device settings (localStorage)
  src/util.js        Helpers: ids, time, colour/contrast, favourites
  tools/make-icons.mjs  Regenerates the raster favicons (pure JS, no deps)
  public/index.html  Markup
  public/style.css   Dark-workspace styling
  public/sw.js       Service worker (network first, cache fallback)
  public/favicon.svg, favicon-32.png, apple-touch-icon.png, site.webmanifest
  public/bundle.js   Built browser bundle (generated by npm run build)
  data/board.bin     Saved board state (generated at runtime)
  data/export/       Readable Markdown mirror + git history (generated at runtime)
  test/              End-to-end, feature, API, persistence and browser tests
```

## Tests

```bash
npm test               # e2e, features, api and persistence suites, each on a fresh server
npm run test:browser   # the same, plus the headless-Chrome smoke test
```

Every suite starts its own server on a throwaway data directory, so your real board is
never touched. The browser test needs Chrome, Chromium or Edge installed (set `CHROME=path`
if it cannot find one); it drives the corkboard, rich text, Tab and smart arrows, the link
picker, soft delete and Undo, collapse, book layout, the home page, inline tab rename,
settings and the history panel, and asserts that no native browser dialogs and no console
errors appear.

If you ever change the brand mark, regenerate the raster icons with
`node tools/make-icons.mjs` (the SVG favicon is edited directly).
