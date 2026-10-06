// The line model for note bodies, shared by the browser (src/richbody.js), the
// server (mirror, REST API, migrations) and the tests. Pure JS, no imports.
//
// A note body is still ONE Y.Text. Inline formatting lives on characters as
// attributes (b/i/u/s), exactly as before. Block structure lives on the '\n'
// that ENDS each line, the same way Quill stores line formats:
//
//   lt    line type: 'li' (list item) | 'todo' (checkbox) | 'h' (heading); absent = paragraph
//   mk    list marker: disc | square | arrow | dash | decimal | alpha | roman (li only)
//   ind   indent level 1..5 (li / todo); absent = 0
//   done  true when a todo is ticked
//   al    'center' | 'right'; absent = left
//   bid   a stable id for the line (todo/li lines get one when created; any line
//         gets one the first time it is folded). Used for per-device folding and
//         by the REST API to tick a todo.
//   ew    embed width in percent (10..100) for a line that is just a media URL
//
// The last line of a body normally ends with '\n' too. Bodies written before
// this model (or by old clients) may not; such a last line simply has no line
// attributes until something needs them, at which point the editor appends the
// missing '\n' (see richbody's ensureTerminator).

export const MARKS = ['b', 'i', 'u', 's']
export const LINE_KEYS = ['lt', 'mk', 'ind', 'done', 'al', 'bid', 'ew']
export const MARKERS = ['disc', 'square', 'arrow', 'dash', 'decimal', 'alpha', 'roman']
export const NUMERIC = new Set(['decimal', 'alpha', 'roman'])
export const MAX_IND = 5

export function pickMarks(attrs) {
  const out = {}
  if (!attrs) return out
  for (const k of MARKS) if (attrs[k]) out[k] = true
  return out
}

export function pickLine(attrs) {
  const out = {}
  if (!attrs) return out
  for (const k of LINE_KEYS) if (attrs[k] != null && attrs[k] !== false && attrs[k] !== '' && attrs[k] !== 0) out[k] = attrs[k]
  return out
}

/** Every line key, with null for the ones not in `attrs` (so Y.Text.format clears them). */
export function fullLine(attrs) {
  const out = {}
  for (const k of LINE_KEYS) out[k] = attrs && attrs[k] != null && attrs[k] !== false && attrs[k] !== 0 ? attrs[k] : null
  return out
}

export const isList = (a) => !!a && (a.lt === 'li' || a.lt === 'todo')

/**
 * Y.Text delta → lines.
 * Each line: { start, len, text, runs: [{ text, marks }], attrs, term }
 *   start  index of the first character
 *   len    characters before the terminating '\n'
 *   term   true when a real '\n' ends the line (false for an unterminated last line)
 * A body that ends with '\n' has no extra empty line after it; an empty body is
 * one empty, unterminated line.
 */
export function deltaToLines(delta) {
  const lines = []
  let cur = { start: 0, len: 0, text: '', runs: [], attrs: {}, term: false }
  let pos = 0
  for (const op of delta || []) {
    if (typeof op.insert !== 'string') {
      pos += 1
      continue
    }
    const marks = pickMarks(op.attributes)
    const parts = op.insert.split('\n')
    for (let p = 0; p < parts.length; p++) {
      const piece = parts[p]
      if (piece) {
        const last = cur.runs[cur.runs.length - 1]
        if (last && sameMarks(last.marks, marks)) last.text += piece
        else cur.runs.push({ text: piece, marks })
        cur.text += piece
        cur.len += piece.length
        pos += piece.length
      }
      if (p < parts.length - 1) {
        // a '\n': it carries this line's attributes and ends the line
        cur.attrs = pickLine(op.attributes)
        cur.term = true
        lines.push(cur)
        pos += 1
        cur = { start: pos, len: 0, text: '', runs: [], attrs: {}, term: false }
      }
    }
  }
  if (!lines.length || cur.len > 0) lines.push(cur)
  return lines
}

function sameMarks(a, b) {
  for (const k of MARKS) if (!!a[k] !== !!b[k]) return false
  return true
}

/** Lines straight from a Y.Text (or a plain string, which has no attributes). */
export function linesOf(ytext) {
  if (ytext && typeof ytext.toDelta === 'function') return deltaToLines(ytext.toDelta())
  const s = ytext == null ? '' : String(ytext)
  return deltaToLines(s ? [{ insert: s }] : [])
}

// ---- markers / numbering -------------------------------------------------

export function toAlpha(n) {
  let s = ''
  let v = n
  while (v > 0) {
    v -= 1
    s = String.fromCharCode(97 + (v % 26)) + s
    v = Math.floor(v / 26)
  }
  return s || 'a'
}

export function toRoman(n) {
  const table = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ]
  let v = Math.max(1, Math.min(3999, n))
  let s = ''
  for (const [k, r] of table) {
    while (v >= k) {
      s += r
      v -= k
    }
  }
  return s
}

/** Default numbered style for a nesting level: 1. → a. → i. → 1. … */
export function numericForLevel(ind) {
  return ['decimal', 'alpha', 'roman'][(ind || 0) % 3]
}

const GLYPH = { disc: '•', square: '▪', arrow: '→', dash: '–' }

/**
 * The marker text for every line ('' for non-list lines; todo lines get '').
 * Numbering counts consecutive list items per indent level and restarts after
 * any paragraph/heading, or when the marker style at a level changes.
 */
export function computeMarkers(lines) {
  const out = new Array(lines.length).fill('')
  let counters = []
  let styles = []
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i].attrs || {}
    if (!isList(a)) {
      counters = []
      styles = []
      continue
    }
    const lvl = a.ind || 0
    counters.length = lvl + 1
    styles.length = lvl + 1
    if (a.lt === 'todo') continue
    const mk = a.mk || 'disc'
    if (styles[lvl] !== mk) {
      styles[lvl] = mk
      counters[lvl] = 0
    }
    counters[lvl] = (counters[lvl] || 0) + 1
    const n = counters[lvl]
    if (mk === 'decimal') out[i] = n + '.'
    else if (mk === 'alpha') out[i] = toAlpha(n) + '.'
    else if (mk === 'roman') out[i] = toRoman(n) + '.'
    else out[i] = GLYPH[mk] || '•'
  }
  return out
}

// ---- outline structure (folding, mind maps) ------------------------------

/**
 * Nesting level used for "who owns whom": headings own everything up to the
 * next heading; a paragraph owns the list lines straight after it; a list line
 * owns the deeper list lines after it.
 */
function rank(a) {
  if (a.lt === 'h') return -2
  if (isList(a)) return a.ind || 0
  return -1
}

/**
 * For every line, the index one past the last line it owns (its subtree end).
 * A line with end === i + 1 has no children. Empty paragraphs own nothing.
 */
export function subtreeEnds(lines) {
  const ends = new Array(lines.length)
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i].attrs || {}
    const r = rank(a)
    let j = i + 1
    if (!(r === -1 && !lines[i].text.trim())) {
      while (j < lines.length) {
        const b = lines[j].attrs || {}
        const rb = rank(b)
        if (r === -2) {
          if (rb === -2) break
        } else if (r === -1) {
          if (!isList(b)) break
        } else if (!isList(b) || rb <= r) break
        j++
      }
    }
    ends[i] = j
  }
  return ends
}

/**
 * Outline tree for the mind map: [{ line, index, children: [...] }].
 * Blank lines are left out (but still own nothing).
 */
export function outlineTree(lines) {
  const ends = subtreeEnds(lines)
  const build = (from, to) => {
    const out = []
    let i = from
    while (i < to) {
      const end = Math.min(ends[i], to)
      if (lines[i].text.trim()) out.push({ index: i, line: lines[i], children: build(i + 1, end) })
      else out.push(...build(i + 1, end))
      i = end
    }
    return out
  }
  return build(0, lines.length)
}

// ---- embeds ----------------------------------------------------------------

const IMG_EXT = /\.(png|jpe?g|gif|webp|avif)(\?[^\s]*)?$/i

/**
 * If a line is nothing but one media URL, what to show for it:
 *   { kind: 'image', src } | { kind: 'youtube', id, src } | { kind: 'instagram', id, src }
 * Anything else returns null.
 */
export function embedOf(text) {
  const t = String(text || '').trim()
  if (!t || /\s/.test(t)) return null
  if (/^\/media\/[A-Za-z0-9_.-]+$/.test(t)) return { kind: 'image', src: t }
  if (!/^https?:\/\//i.test(t)) return null
  let u
  try {
    u = new URL(t)
  } catch {
    return null
  }
  const host = u.hostname.replace(/^www\.|^m\./, '')
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0]
    if (/^[\w-]{6,20}$/.test(id)) return { kind: 'youtube', id, src: t }
  }
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    let id = u.searchParams.get('v')
    const m = /^\/(shorts|embed|live)\/([\w-]{6,20})/.exec(u.pathname)
    if (!id && m) id = m[2]
    if (id && /^[\w-]{6,20}$/.test(id)) return { kind: 'youtube', id, src: t }
  }
  if (host === 'instagram.com') {
    const m = /^\/(p|reel|reels|tv)\/([\w-]{5,40})/.exec(u.pathname)
    if (m) return { kind: 'instagram', id: m[2], src: t }
  }
  if (IMG_EXT.test(u.pathname)) return { kind: 'image', src: t }
  return null
}

// ---- markdown --------------------------------------------------------------

function runsToMarkdown(runs) {
  let out = ''
  for (const r of runs) {
    const m = r.marks || {}
    if (!r.text.trim()) {
      out += r.text
      continue
    }
    const open = (m.b ? '**' : '') + (m.i ? '*' : '') + (m.u ? '<u>' : '') + (m.s ? '~~' : '')
    const close = (m.s ? '~~' : '') + (m.u ? '</u>' : '') + (m.i ? '*' : '') + (m.b ? '**' : '')
    out += open + r.text + close
  }
  return out
}

/**
 * Lines → Markdown. Lists become `- `, `1. `, `a. `, `→ ` …, todos `- [ ] `,
 * headings `### `, nesting two spaces per level, media lines `![](…)` (with
 * `/media/` swapped for `mediaPrefix`, so the link works from wherever the file
 * is written). Alignment has no Markdown form and is dropped.
 */
export function linesToMarkdown(lines, opts = {}) {
  const markers = computeMarkers(lines)
  const mediaPrefix = opts.mediaPrefix || '/media/'
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i]
    const a = L.attrs || {}
    const pad = '  '.repeat(isList(a) ? a.ind || 0 : 0)
    const emb = embedOf(L.text)
    let body = emb ? embedMarkdown(emb, mediaPrefix) : runsToMarkdown(L.runs)
    if (a.lt === 'todo') out.push(pad + `- [${a.done ? 'x' : ' '}] ` + body)
    else if (a.lt === 'li') {
      const mk = a.mk || 'disc'
      const lead = NUMERIC.has(mk) ? markers[i] + ' ' : mk === 'arrow' ? '→ ' : '- '
      out.push(pad + lead + body)
    } else if (a.lt === 'h') out.push('### ' + body)
    else out.push(body)
  }
  // an unterminated empty last line is not content
  while (out.length > 1 && out[out.length - 1] === '' && !lines[lines.length - 1].term) out.pop()
  return out.join('\n')
}

function embedMarkdown(emb, mediaPrefix) {
  if (emb.kind === 'image') {
    const src = emb.src.startsWith('/media/') ? mediaPrefix + emb.src.slice(7) : emb.src
    return `![](${src})`
  }
  if (emb.kind === 'youtube') return `[▶ YouTube](${emb.src})`
  if (emb.kind === 'instagram') return `[Instagram](${emb.src})`
  return emb.src
}

/** Plain text with list prefixes (for copy and for snippets). */
export function linesToPlain(lines) {
  const markers = computeMarkers(lines)
  return lines
    .map((L, i) => {
      const a = L.attrs || {}
      const pad = '  '.repeat(isList(a) ? a.ind || 0 : 0)
      if (a.lt === 'todo') return pad + (a.done ? '- [x] ' : '- [ ] ') + L.text
      if (a.lt === 'li') return pad + (NUMERIC.has(a.mk) ? markers[i] + ' ' : a.mk === 'arrow' ? '→ ' : '- ') + L.text
      return L.text
    })
    .join('\n')
}

/**
 * Recognise a list prefix at the start of a plain-text line (used for paste,
 * history restore and the REST API). Returns { attrs, rest } or null.
 */
export function parseLinePrefix(line) {
  const m = /^(\s*)(- \[( |x|X)\] |[-*+•] |→ |-> |(\d{1,3})[.)] |([a-z])[.)] |([ivxlc]{1,6})[.)] |#{1,6} )(.*)$/.exec(line)
  if (!m) return null
  const ind = Math.min(MAX_IND, Math.floor(m[1].replace(/\t/g, '  ').length / 2))
  const head = m[2]
  const rest = m[7]
  const withInd = (o) => (ind ? { ...o, ind } : o)
  if (head.startsWith('- [')) return { attrs: withInd(m[3] === ' ' ? { lt: 'todo' } : { lt: 'todo', done: true }), rest }
  if (head[0] === '#') return { attrs: { lt: 'h' }, rest }
  if (head === '→ ' || head === '-> ') return { attrs: withInd({ lt: 'li', mk: 'arrow' }), rest }
  if (m[4]) return { attrs: withInd({ lt: 'li', mk: 'decimal' }), rest }
  if (m[5] && m[5] !== 'i') return { attrs: withInd({ lt: 'li', mk: 'alpha' }), rest }
  if (m[5] || m[6]) return { attrs: withInd({ lt: 'li', mk: 'roman' }), rest }
  return { attrs: withInd({ lt: 'li', mk: 'disc' }), rest }
}

/** Strip the simple Markdown marks this app writes (**, *, ~~, <u>). */
export function stripMarks(s) {
  return String(s || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/<\/?u>/g, '')
}

/**
 * Markdown-ish text → [{ text, attrs }] lines, recognising the prefixes that
 * linesToMarkdown writes. `![](…/media/x)` turns back into `/media/x`.
 */
export function markdownToLines(md) {
  const src = String(md || '').replace(/\r\n/g, '\n')
  if (!src) return []
  return src.split('\n').map((raw) => {
    const p = parseLinePrefix(raw)
    let text = p ? p.rest : raw
    let attrs = p ? p.attrs : {}
    const img = /^!\[[^\]]*\]\(([^)\s]+)\)$/.exec(text.trim())
    if (img) {
      const i = img[1].indexOf('media/')
      text = i >= 0 && !/^https?:/.test(img[1]) ? '/' + img[1].slice(i) : img[1]
    }
    const link = /^\[(?:▶ YouTube|Instagram)\]\(([^)\s]+)\)$/.exec(text.trim())
    if (link) text = link[1]
    return { text: stripMarks(text), attrs }
  })
}

export function genLineId() {
  return 'l' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4)
}
