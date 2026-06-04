# Shared Notes

Live collaborative sticky notes for you and your friends, self-hosted on a Raspberry Pi.
Think Google Keep meets a corkboard, with Google-Docs-style live typing: everyone sees
each other's edits land character by character, in real time.

No accounts, no cloud, no database server. One Pi on your LAN, everyone points their
browser at it.

## What it does

- A single shared board of colored notes (title + body), newest first.
- Real-time editing: when a friend types, you see it appear in their note as they go.
- Concurrent edits merge cleanly. Two people typing in the same note do not clobber each
  other (this uses a CRDT, [Yjs](https://github.com/yjs/yjs), so there are no "last write
  wins" surprises).
- Presence: little colored dots show who is online and who is currently editing which note.
- Search to filter notes by text.
- Notes survive restarts. The board is saved to `data/board.bin` on disk.

It is intentionally dense: tight masonry layout, small type, lots of notes on screen at once.

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

Environment variables:

- `PORT`: port to listen on (default `3000`).
- `HOST`: interface to bind (default `0.0.0.0`, meaning reachable from the LAN).

Example, run on port 8080:

```bash
PORT=8080 npm start
```

## Data and backups

The whole board lives in one file: `data/board.bin`. It is written shortly after any
change and again on shutdown. To back up, copy that file. To wipe the board and start
fresh, stop the server, delete `data/board.bin`, start again.

## Updating the look or behavior

If you edit anything in `src/` (the browser code), rebuild before restarting:

```bash
npm run build
```

Files in `public/` (`index.html`, `style.css`) are served as-is, no build needed for those.

## A note on safety

This app has no login and no encryption. That is fine for friends on your home network,
which is the intended use. Do not port-forward it or expose it to the public internet as
is: anyone who reached it could read and edit everything. If you ever want remote access,
put it behind something that adds HTTPS and authentication (for example a Cloudflare Tunnel,
a Tailscale network, or an nginx reverse proxy with basic auth) rather than opening the port
directly.

## How it works (short version)

- The server (`server.js`) serves the static files and runs a WebSocket endpoint at `/ws`.
- All clients share one Yjs document. Edits are sent as small binary updates over the
  WebSocket and merged with a CRDT, so concurrent typing converges without conflicts.
- "Who is here" and "who is editing what" use Yjs awareness, which is ephemeral and not
  saved to disk.
- The document state is serialized to `data/board.bin` (debounced, plus on shutdown) so the
  board persists across restarts. No external database, and no native modules, so it
  installs cleanly on a Pi.

## Project layout

```
shared-notes/
  server.js          Express static server + WebSocket sync + disk persistence
  build.js           esbuild bundling step (src/client.js -> public/bundle.js)
  src/client.js      Browser app: rendering, editing, live sync, presence
  public/index.html  Markup
  public/style.css   Dense dark-workspace styling
  public/bundle.js   Built browser bundle (generated by npm run build)
  data/board.bin     Saved board state (generated at runtime)
  test/              End-to-end and persistence tests
```

## Tests

From the project folder, the tests start a server, drive it with simulated clients, and
tear it down:

```bash
# end-to-end: live typing sync, concurrent merge, presence
PORT=3902 node server.js & SRV=$!; sleep 1; PORT=3902 node test/e2e.mjs; kill $SRV
```
