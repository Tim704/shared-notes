# Roadmap 2: Obsidian-style features

> **Status (28 Oct 2026): phases 1–4 are built**, including the "extra S" items (checkbox
> states `[/]` `[-]` `[>]`, typo-tolerant search, renaming and merging tags, the Google Keep
> import). The open questions were settled as recommended: renames also rewrite links in
> archived and trashed notes; the Android share target and the iOS Shortcut are both
> there; reminders work on iPhone once the app is on the home screen. Phase 5 (pick and
> choose) is not started. See `FEATURES.md` for what each item became.

Written against commit `8d239e3` (mind map rework). It ranks a list of Obsidian core and
plugin features by how useful each would be **here** and what it would cost **in this
codebase**. `ROADMAP.md` is the earlier roadmap and is almost fully built.

**Value** (★1–5) is judged for how the app is used now: a shared board for Tim and a few
friends, mostly sticky notes, lists, documents and to-dos, on laptop and phone. It is not
judged for a single power user's knowledge base. That is why the database and plugin
features rank low.

**Effort:** **S** = an afternoon, **M** = a few days, **L** = a week or so. Costs differ from
the usual Obsidian-clone estimates in two ways:
- **Cheaper:** anything that scans every note, such as backlinks, mentions, tags or tasks
  gathered from all notes. The whole board is one `Y.Doc` that is already in memory, so
  these need no index and no server.
- **Dearer:** anything that renders a new kind of block inside the editor, such as code,
  math or tables. `src/richbody.js` is a hand-rolled `contentEditable` with no
  dependencies, not CodeMirror or ProseMirror, and the zero-dependency, offline bundle is
  worth keeping.

---

## Already built (not on this list)

- **Linking:** a `[[` link picker, but its links are resolved by title (see 1.1).
- **Editing:** folding, smart arrows, pictures (paste, drop, resize), YouTube and Instagram
  embeds.
- **Safety:** version history with restore (git on the Pi), trash with Undo kept for 30
  days, archive, Markdown and JSON download, auto-save to a folder (Chrome), offline use,
  and removal of pictures no note uses (after 30 days).
- **Views and boards:** mind map tab, canvas view, sketch pads, ink, a To-do tab with due
  dates and Week/Month views.
- **Navigation and the rest:**
  - search across every tab on Home, pinned notes and tab icons;
  - light and dark modes, the phone layout;
  - full-screen deep links, the REST API, the optional password.

---

## Phase 1: Links you can trust (about 2–3 days)

Phase 1 comes first because the `[[` picker exists but a link breaks as soon as its target
is renamed. Every later linking feature depends on links staying correct.

| # | Feature | Value | Effort | How, in this codebase |
|---|---|---|---|---|
| 1.1 | **Links follow renames** | ★★★★★ | S | `followLink` looks the note up by title text when the link is clicked (`src/client.js:1375`), so renaming a note silently breaks every link to it. When a title edit is committed (on blur), rewrite every matching link in all bodies in one Yjs transaction. Keep the `[[Title]]` text form, so the Markdown mirror and its history stay readable. |
| 1.2 | **Backlinks** ("Linked from") | ★★★★★ | S | Scan bodies for `[[title]]`. Show the results at the foot of a full-screen note and under ribbon → More, each with its line as context. Planned in `ROADMAP.md` §4 but never built. |
| 1.3 | **Quick switcher, creates on a miss** | ★★★★★ | S | Cmd/Ctrl+K over the existing `linkCandidates()` plus tab names. Rank matches where your letters start words first. Enter with no match creates the note in the current tab. |
| 1.4 | **Create a note from a dead link** | ★★★★ | S | Replace the "No note or tab called …" toast with a "Create it" action that adds a note to the current tab and opens it full screen. |
| 1.5 | **Hover preview** | ★★★★ | S | A popover with `snippetOf()` when hovering a `.rb-wiki` link (desktop only). |
| 1.6 | **Back and forward** | ★★★ | S | Only full screen calls `pushState` (`client.js:3791`). Also push states on tab switches and link jumps, so browser Back and the phone's back gesture retrace your steps. |

## Phase 2: Writing and capture (about 1–1.5 weeks)

| # | Feature | Value | Effort | How |
|---|---|---|---|---|
| 2.1 | **Quick capture API + phone shortcut** | ★★★★★ | S | `POST /api/capture {text, note?, heading?}` appends lines to an Inbox note (or under a heading), using `shared/lineops.js`. An iOS Shortcut or Android share then saves into the board from anywhere. |
| 2.2 | **Share sheet target** | ★★★ | S | Add `share_target` to `site.webmanifest`, posting to 2.1. Works on Android Chrome only, because iOS Safari does not support Web Share Target; the Shortcut in 2.1 covers iPhone. |
| 2.3 | **Slash menu** | ★★★★ | S | Reuse the `[[` picker (`richbody.js:1408`) for `/`, offering heading, bullets, numbers, checkbox, picture, date, divider and template. It makes formatting reachable without going up to the ribbon. |
| 2.4 | **Labelled links** (+ paste URL on selection, auto page title) | ★★★★ | M | The editor only knows bare URLs and `[[ ]]` (`richbody.js:55`). Add an `href` text attribute next to `b/i/u/s`, mirrored as `[text](url)`. After that, paste-onto-selection is trivial, and auto-title is a small Pi endpoint that fetches the page `<title>` (the browser can't read other sites). |
| 2.5 | **Natural-language dates** | ★★★ | S | Typing `@friday`, `@tomorrow`, `@in 3 days` or `@3 nov` becomes a date. On a checkbox line it sets the due date, which feeds 3.3. A tiny hand-written parser, no dependency. |
| 2.6 | **Templates** | ★★★ | S | A Templates tab. "New from template" (and the slash menu) copies one in, filling `{{date}}`, `{{time}}`, `{{title}}` and `{{me}}`. No scripting. |
| 2.7 | **Daily notes** | ★★★ | S | A "Today" button opens or creates the `2026-10-27` note in a Journal tab from a template. The To-do month view can reuse its grid to show dots on days that have notes. |
| 2.8 | **Move lines up and down** | ★★★ | S | Alt+Shift+↑/↓ through `lineops`. The item's sub-points move with it. |
| 2.9 | **Extract to a new note / merge notes** | ★★★ | S | Select text → "Move to new note": a sticky appears beside the original with a `[[link]]` left in its place. Merge is the reverse. Both suit the corkboard well. |
| 2.10 | **Outline + word count for documents** | ★★★ | S | A side panel listing the document tab's headings to jump to, with word count and reading time. |

## Phase 3: Organising across tabs (about 2 weeks)

| # | Feature | Value | Effort | How |
|---|---|---|---|---|
| 3.1 | **Tags** (nested, with counts) | ★★★★ | M | `#tag` and `#tag/sub` shown as chips. A tag list with counts on Home, where clicking filters every tab. Renaming and merging tags is an S on top. |
| 3.2 | **Search operators** | ★★★ | M | `tag:`, `tab:`, `is:todo`, `is:done`, `has:image`, `by:Sam` and quoted phrases. `by:` is free because notes already store `lastEditedBy`. Simple typo tolerance is an extra S (★★). |
| 3.3 | **Checkboxes from every note in To-do** | ★★★★ | M | Checkbox lines are already structured in `shared/lines.js`. Add a "From notes" section to the To-do tab, grouped by due date (2.5), where ticking writes back to the note. Extra states `[/]`, `[-]` and `[>]` are an extra S (★★). |
| 3.4 | **Reminders (push notifications)** | ★★★★ | M | The To-do tab has due dates but nothing ever notifies. The service worker exists; add Web Push from the Pi (VAPID keys, a subscription per device). On iPhone it needs the app installed to the home screen. This is something Obsidian cannot do while closed. |
| 3.5 | **Links to a heading or a line** | ★★★ | M | `[[Note#Heading]]`, and `[[Note^id]]` using the line ids the API already ticks by. Following one scrolls to the line and flashes it. |
| 3.6 | **Unlinked mentions** | ★★★ | M | Under the backlinks: places where a note's title appears as plain text, each with a one-click "Link". |
| 3.7 | **Kanban view of a To-do tab** | ★★★ | M | Columns for to do, doing and done (or by tag), with drag between columns. |
| 3.8 | **Aliases** | ★★ | S | An `aliases` field on the note (ribbon → More). Resolving, backlinks and the switcher all honour it. |
| 3.9 | **Callouts** | ★★ | S–M | A `> [!note]` line type in `shared/lines.js`, mirrored in Obsidian's syntax. |
| 3.10 | **Coloured highlights** | ★★ | S | An `hl` text attribute, like `b/i/u/s`. |

## Phase 4: Sharing and safety (about 1 week)

| # | Feature | Value | Effort | How |
|---|---|---|---|---|
| 4.1 | **Share one note by link** | ★★★★ | M | A revocable random token per note serves `/s/<token>`, read-only and rendered on the server by `shared/serialise.js`. It bypasses the password for that one note only. Good for sending a list or document to someone who isn't on the board. |
| 4.2 | **ZIP export with pictures** | ★★★ | S | Today a download is one `.md` or `.json` file (`src/backup.js:45`), and the folder auto-save is Chrome-only. Add `/api/export.zip` built from `data/export/` and `data/media/`, using a store-only zip writer of about 80 lines with no dependency. |
| 4.3 | **Import Markdown / Obsidian folders, Google Keep** | ★★★ | M | Run the mirror's format in reverse: folders become tabs and files become notes. A Keep Takeout import is an extra S. Other importers are not worth it for this group. |
| 4.4 | **Print / PDF** | ★★ | S | A print stylesheet for a full-screen note or a document tab; the browser saves it as a PDF. |
| 4.5 | **Webhooks** | ★★ | S | POST to configured URLs when a note changes, building on the existing API. Covers most of what a plugin system would give. |

## Phase 5: Pick and choose

Worth building only if one of these is specifically wanted.

| # | Feature | Value | Effort | Note |
|---|---|---|---|---|
| 5.1 | **AI: ask the board, summarise** | ★★★ | M | The board is small enough to send whole tabs to Claude without embeddings, so summaries are an S and "ask the board" an M. It needs an API key on the Pi, it costs money, and friends' notes would leave the Pi, so make it opt-in per tab. Semantic search, related notes and auto-tags need an embeddings provider: later. |
| 5.2 | **Command palette** (actions, not just notes) | ★★★ | M | A `>` mode in the 1.3 switcher listing every ribbon action. Custom hotkeys on top would be ★. |
| 5.3 | **Tables** | ★★★ | L | The line model has no tables, and a proper table editor in the hand-rolled editor is the biggest editor job left. Only if they are really missed. |
| 5.4 | **Local graph** | ★★ | M | After backlinks: a note and its neighbours, drawn with the mind map's SVG renderer. |
| 5.5 | **Code blocks with highlighting** | ★★ | M | A `code` line type plus a small highlighter in the bundle. |
| 5.6 | **Flashcards** | ★★ | M | Book notes already have two sides. Add `q::a` lines and a per-device review schedule. |
| 5.7 | **Resurfacing / "a year ago"** | ★★ | S | A Home card showing a random note, or what was written on this day. |
| 5.8 | **Focus / typewriter mode** | ★★ | S | For document tabs. |
| 5.9 | **Voice notes** | ★★ | M | Record in the browser and transcribe through an API; the Pi is too slow for good Whisper. |
| 5.10 | **Email to note** | ★★ | M | Cloudflare Email Routing → Worker → `/api/capture` (2.1). |
| 5.11 | **Math (KaTeX), diagrams (Mermaid)** | ★ | M each | Heavy for the offline bundle, and they would render inside the editor the way pictures do. |
| 5.12 | **Slides from a document** | ★ | M | |

## Skipped, and why

| Feature | Why not |
|---|---|
| Typed properties, Bases / Dataview views, formulas, query blocks, map view | L to XL for a board that isn't a database. To-do already has List, Week and Month views, and hoard covers tracked collections. Revisit if notes start carrying structured fields. |
| Transclusion `![[Note]]`, embedded search results | Low value on a corkboard, and an embedded live editor inside another note is costly. |
| Global graph | The paste's own verdict: it impresses in demos but rarely helps. 5.4 is the useful version. |
| Live-preview Markdown editing, Vim mode, linter | The editor is already WYSIWYG and writes a canonical structure. Vim would need CodeMirror. |
| Split panes and saved workspaces | The corkboard and canvas already show many notes at once. |
| Folder notes, note icons, bookmarks, unique-note titles, image auto-rename | Tabs aren't folders. Tab icons and pins already exist. Pictures are stored by id. |
| Footnotes, slides, mind map from headings, Excalidraw, JSON Canvas | Niche here. Sketch pads, ink and the mind map tab cover drawing. |
| Web clipper extension, Readwise, Kindle, Zotero, PDF annotation | 2.1 and 2.2 cover capture; the rest are research-workflow niches. |
| End-to-end encryption | The Pi is already private, and E2E would break the mirror, history, search and the API. |
| Publish the notes as a website | 4.1 covers sharing. |
| Plugin system, custom CSS, toolbar customisation | The REST API with webhooks (4.5) gives most of a plugin system's benefit. |

---

## Top 10 by value per effort

1. 1.1 Links follow renames
2. 1.2 Backlinks
3. 1.3 Quick switcher
4. 2.1 Quick capture API + phone shortcut
5. 1.4 Create from dead link
6. 1.5 Hover preview
7. 2.3 Slash menu
8. 2.5 Natural-language dates
9. 3.3 Checkboxes from every note in To-do
10. 3.4 Reminders

Items 1–8 are all S, roughly a week and a half together. 9 and 10 are the first M items
worth their cost.

## Dependencies

```
1.1 rename-safe links ─┬─ 1.2 backlinks ─┬─ 3.6 unlinked mentions
                       │                 └─ 5.4 local graph
                       ├─ 3.5 heading/line links
                       └─ 3.8 aliases
1.3 switcher ── 5.2 command palette
2.1 capture API ─┬─ 2.2 share target
                 └─ 5.10 email to note
2.5 dates ── 3.3 tasks from notes ── 3.4 reminders
2.6 templates ── 2.7 daily notes
3.1 tags ── 3.2 search operators
```

## Open questions

- **Rename rewriting:** should a rename also rewrite links inside archived and trashed
  notes? Recommendation: yes, so restoring one doesn't bring back a dead link.
- **AI (5.1):** do your friends agree to their notes being sent to an API? That decides
  whether 5.1 is buildable at all.
- **Phones:** are the phones iPhones or Android? On iPhone, 2.2 does nothing and 3.4 needs
  the app installed to the home screen.
