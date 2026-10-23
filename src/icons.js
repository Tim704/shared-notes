// Original 24-unit outline artwork. No SF Symbols or external assets.
const paths = {
  note: 'M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM8 8h8M8 12h8M8 16h5',
  compose: 'M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M16 3l5 5M10 14l1-5 7-7 5 5-7 7-6 1Z',
  pencil: 'm15 4 5 5M4 20l1-6L16 3a2 2 0 0 1 3 0l2 2a2 2 0 0 1 0 3L10 19l-6 1Z',
  settings: 'm10 3-.8 2.5-2 .9-2.5-.6-2 3.4 1.8 1.9v2.3l-1.8 1.9 2 3.4 2.5-.6 2 .9.8 2.5h4l.8-2.5 2-.9 2.5.6 2-3.4-1.8-1.9v-2.3l1.8-1.9-2-3.4-2.5.6-2-.9L14 3h-4ZM15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0',
  search: 'M16.5 16.5 21 21M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0',
  close: 'm6 6 12 12M18 6 6 18', plus: 'M12 5v14M5 12h14', minus: 'M5 12h14',
  home: 'm3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9',
  folder: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7ZM3 10h18',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  down: 'm6 9 6 6 6-6', up: 'm6 15 6-6 6 6', right: 'm9 6 6 6-6 6', back: 'm15 5-7 7 7 7',
  expand: 'M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6',
  check: 'm5 12 4 4L19 6', todo: 'M21 12a9 9 0 1 1-5-8M7 11l4 4L21 4',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  archive: 'M3 3h18v5H3ZM5 8v13h14V8M9 12h6',
  pin: 'm8 3 8 0-1 7 4 4v2H5v-2l4-4-1-7ZM12 16v6',
  history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2',
  image: 'M3 3h18v18H3ZM3 17l6-6 4 4 3-3 5 5M9 7h.01',
  play: 'm9 5 11 7-11 7V5Z', stop: 'M5 5h14v14H5Z',
  camera: 'M3 7h4l2-3h6l2 3h4v14H3ZM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  external: 'M14 3h7v7M21 3 10 14M11 4H4v16h16v-7',
  grid: 'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',
  rows: 'M3 3h18v7H3ZM3 14h18v7H3Z',
  canvas: 'M9 8c-6-7-12 8-3 8 4 0 8-11 12-11 9 0 3 15-3 8',
  arrow: 'M3 12h18m-6-6 6 6-6 6', both: 'M3 12h18m-6-6 6 6-6 6M9 6l-6 6 6 6',
  swap: 'M3 7h17l-4-4M21 17H4l4 4', dashed: 'M3 12h3m4 0h4m4 0h3',
  star: 'm12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1 3-6Z',
  bold: 'M6 3h7a4.5 4.5 0 0 1 0 9H6ZM6 12h8a4.5 4.5 0 0 1 0 9H6Z',
  italic: 'M10 3h10M4 21h10M15 3 9 21',
  underline: 'M5 3v8a7 7 0 0 0 14 0V3M3 21h18',
  strike: 'M18 5c-2-3-12-3-12 3 0 3 5 3 8 4M6 19c3 3 12 2 12-3M3 12h18',
  left: 'M3 5h18M3 10h12M3 15h18M3 20h12',
  center: 'M3 5h18M6 10h12M3 15h18M6 20h12',
  alignRight: 'M3 5h18M9 10h12M3 15h18M9 20h12',
  heading: 'M5 4v16M19 4v16M5 12h14', text: 'M3 5h18M12 5v16M8 21h8',
  square: 'M3 8h4v4H3ZM11 10h10M11 17h10M3 17h4',
  numbers: 'M4 3h1v6M3 9h4M3 15c0-4 5-4 4 0l-4 5h4M11 6h10M11 17h10',
  eraser: 'm3 14 10-11 8 8-10 10H8l-5-5v-2Zm5-5 8 8M11 21h11',
  undo: 'M3 10h11a7 7 0 0 1 0 14M3 10l6-6M3 10l6 6',
  redo: 'M21 10H10a7 7 0 0 0 0 14M21 10l-6-6M21 10l-6 6',
  map: 'M12 5v5M5 10h14M5 10v6M19 10v6M9 1h6v4H9ZM2 16h6v6H2ZM16 16h6v6h-6Z',
  person: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-3a8 8 0 0 1 16 0v3',
  sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1',
  cloud: 'M6 18a5 5 0 1 1 1-10 6 6 0 0 1 12 2 4 4 0 0 1-1 8H6Z',
  calendar: 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM3 10h18M8 3v4M16 3v4',
  palette: 'M12 21a9 9 0 1 1 9-9.5 4.5 4.5 0 0 1-4.5 4.5h-1.6a1.75 1.75 0 0 0-1.4 2.8l.3.4A1.75 1.75 0 0 1 12.4 21ZM13.5 6.5h.01M17.5 10.5h.01M6.5 12h.01M8.5 7.5h.01',
}
const aliases = { '⚙':'settings','⌂':'home','☰':'list','⌕':'search','✎':'pencil','⤢':'expand','✕':'close','×':'close','⋯':'more','▸':'right','⌄':'down','⌃':'up','🖼':'image','+':'plus','−':'minus','🗑':'trash','🗄':'archive','🎨':'palette','📌':'pin','📍':'pin','⌫':'eraser','↶':'undo','↷':'redo','📁':'folder','☐':'todo','☑':'todo','✓':'check','✔':'check','⬇':'download','▶':'play','■':'stop','▦':'grid','▤':'rows','∞':'canvas','⇲':'expand','★':'star','←':'back','→':'arrow','↔':'both','—':'minus','┄':'dashed','⇄':'swap','•':'list','▪':'square','–':'minus','1.':'numbers','a.':'numbers','i.':'numbers','H':'heading','¶':'text' }

export const iconNames = () => Object.keys(paths)

export function icon(name, { size = '1.15em' } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  for (const [key, value] of Object.entries({ viewBox:'0 0 24 24', width:size, height:size, fill:'none', stroke:'currentColor', 'stroke-width':1.75, 'stroke-linecap':'round', 'stroke-linejoin':'round', 'aria-hidden':'true', focusable:'false', class:'icon' })) svg.setAttribute(key, value)
  const path = document.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', paths[aliases[name] || name] || paths.note)
  svg.appendChild(path)
  return svg
}
export const iconHTML = name => icon(name).outerHTML
export function iconLabel(el, text, name) {
  const value = String(text || '')
  const leading = Object.keys(aliases).find(g => value === g || value.startsWith(g + ' '))
  const label = leading ? value.slice(leading.length).trim() : value
  el.replaceChildren()
  if (name || leading) el.appendChild(icon(name || leading))
  if (label) el.appendChild(document.createTextNode(label))
  if (!label && el.tagName === 'BUTTON') el.setAttribute('aria-label', el.title || name || aliases[leading] || 'Options')
  return el
}
export function mountIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => el.replaceChildren(icon(el.dataset.icon)))
}
