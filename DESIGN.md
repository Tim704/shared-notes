# Shared Notes design system

The board is the document. Compact desktop toolbars and generous phone navigation
surround it; coloured paper supplies the personality. This is a local, offline-first
interface. Shared data, Markdown, and the API retain their existing formats.

## Colour and materials

The system theme is the default; this device can choose Automatic, Light, or Dark.
`html[data-theme]` always contains the resolved `light` or `dark` value. A small
head script resolves it before paint; the settings module follows system changes.

| Semantic token | Light | Dark |
| --- | --- | --- |
| bg | #f2f2f7 | #000000 |
| bg-elevated | #ffffff | #1c1c1e |
| bg-tertiary | #f2f2f7 | #2c2c2e |
| fill | rgba(120,120,128,.12) | rgba(120,120,128,.24) |
| fill-strong | rgba(120,120,128,.20) | rgba(120,120,128,.36) |
| label | #000000 | #ffffff |
| label-2 | #636366 | #aeaeb2 |
| label-3 | #76767b | #8e8e93 |
| separator | rgba(60,60,67,.29) | rgba(84,84,88,.65) |
| accent | #e6a700 | #ffd60a |
| tint (text) | #805c00 | #ffd60a |

Secondary and placeholder labels deliberately use more contrast than the suggested
translucent labels. Black ink on yellow primary buttons; dark amber for light-mode
links. Red, orange, yellow, green, teal, blue, indigo, purple and pink use system-style
palettes. Status colours always accompany a label, icon, or accessible name.

Thin/regular/thick materials mix elevated background at 60/72/90 percent, with
saturate(180%) blur(20px). They are confined to stationary chrome and overlays.
Unsupported backdrop filtering and reduced transparency use opaque backgrounds.
Cards never blur. Backdrops are black at .20/.45; lightboxes remain dark.

Stored PAPER hexes are unchanged. Known papers render as #39351f, #3d3022,
#40282b, #203737, #293724, #332b42, #253443, #1c1c1e in dark mode. Unknown
colours remain unchanged. Ink is chosen by contrast against the rendered paper;
the change never writes a colour back to Yjs. Sketch and map exports have fixed,
light document colours independent of the UI theme.

## Type

System fonts first: -apple-system, BlinkMacSystemFont, SF Pro Text, SF Pro Display,
Inter var, Inter, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif.
SF names only request installed system fonts: no Apple font or artwork is shipped.
Inter Latin variable WOFF2 (OFL, licence beside the file) is bundled locally.
Use cv11/ss01 and optical sizing; mono is ui-monospace, SF Mono, Menlo, Consolas.

| Text style | Desktop size/line | Phone size/line | Weight |
| --- | --- | --- | --- |
| large-title | 26/32 | 34/41 | 700 |
| title-1 | 22/28 | 28/34 | 700 |
| title-2 | 17/22 | 22/28 | 700 |
| title-3 | 15/20 | 20/25 | 600 |
| headline | 13/16 | 17/22 | 600 |
| body | 13/16 | 17/22 | 400 |
| callout | 12/15 | 16/21 | 400 |
| subhead | 11/14 | 15/20 | 400 |
| footnote | 10/13 | 13/18 | 400 |
| caption | 10/13 | 12/16 | 400 |

Note bodies default to 14/20 on desktop. Existing note size choices remain usable.
Large titles use -.02em tracking; counts use tabular numerals.

## Geometry, elevation and motion

Spacing s-1…s-8 = 4, 8, 12, 16, 20, 24, 28, 32px. Desktop gutters 24px,
phone gutters 16px and grid gaps 12px. Radius tokens: control 6px, field 8px,
search 10px, card/popover 12px, dialog 14px, sheet 16px, capsule 999px.
Hairlines are 1px, reduced to .5px on high-DPI displays.

Elevation 1: 0 .5px 1px black .08 + 0 1px 3px black .06.
Elevation 2: 0 4px 16px black .12.
Elevation 3: 0 10px 40px black .18 + .5px separator outline.
Dark elevation increases shadow opacity and uses separators for definition.

Enter curve cubic-bezier(.32,.72,0,1); state curve cubic-bezier(.2,0,0,1).
Fast/normal/slow durations 120/220/380ms. Controls press to .97. Menus fade/scale
from .96 at their anchor; phone sheets slide from below. Full-screen documents
use card-to-window FLIP transforms. Remote layout changes use transform animation;
local pointer drags have no easing. Reduced motion uses short opacity fades.

## Components and interaction

Desktop: 52px unified toolbar, scrollable pill tabs, 28px icon targets, 13px chrome.
Phone: 44px minimum controls, large title, 49px bottom navigation plus safe area,
compose button, leading sidebar, bottom sheets. Breakpoint: 600px.
Ribbon: a 44px material bar under the tabs (sticky, or a floating bar that slides in
while editing), groups split by hairlines, 28px buttons, greyed to 40% with no target.
Notes and documents carry no toolbars of their own on desktop.
Focus rings: 3px accent with 2px offset, except text editors (note title and body,
documents, mind-map labels), which show only the caret. Menus support arrows, Home/End, Enter,
Escape and type-ahead; dialogs trap focus and restore it to their opener.
Settings are grouped by Appearance, Editing, Board, Backup and Account; switches
are 38×22 desktop / 51×31 phone, with green on state and visible focus.

Original inline icons use a 24×24 viewBox, currentColor, 1.75px strokes, round
caps/joins. No emoji control icons, SF Symbols, Apple marks or runtime icon packages.
Semantic list markers and user-entered Unicode remain text. All icon-only buttons
carry accessible names. Editor formatting buttons preserve the selection.

## Audit and verification

`visual-review/before-values.txt` records original hard-coded style values and
locations. `visual-review/before/` and `after/` contain screenshot walkthroughs;
the original public shell is retained there to make additional baseline captures
possible. These review artifacts are local and must not be committed.
The untouched baseline has no light theme, so its light/dark system captures match.
The walkthrough exposed a pre-existing test assumption: zooming out at 1440px can
still leave scale at or above 1. The test must compare before/after scale instead.
