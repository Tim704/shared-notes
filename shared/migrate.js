// Board migrations that the server runs (once per legacy note, in one place, so
// two browsers can never both migrate the same note and duplicate its text).

import * as Y from 'yjs'
import { replaceAllLines } from './lineops.js'
import { itemsOf } from './serialise.js'

/**
 * Whole-note checklists (kind: 'todo' with an `items` array) become ordinary
 * notes whose body is made of todo lines, so checkboxes can sit between normal
 * paragraphs. Each item's id becomes the line's `bid`, so REST calls that tick
 * an item by its old id keep working. `items` is left in place for one
 * release so an old client still sees something sensible.
 * Returns the number of notes migrated.
 */
export function migrateLegacyTodos(ydoc, origin = 'migrate') {
  const yNotes = ydoc.getMap('notes')
  const todo = []
  yNotes.forEach((n, id) => {
    if (n && typeof n.get === 'function' && n.get('kind') === 'todo') todo.push([id, n])
  })
  if (!todo.length) return 0
  ydoc.transact(() => {
    for (const [, n] of todo) {
      const items = itemsOf(n.get('items'))
      let body = n.get('body')
      if (!(body instanceof Y.Text)) {
        body = new Y.Text()
        n.set('body', body)
      }
      replaceAllLines(
        body,
        items.length
          ? items.map((it) => ({
              text: it.text.replace(/\n/g, ' '),
              attrs: { lt: 'todo', done: it.done || null, bid: it.id || undefined },
            }))
          : [{ text: '', attrs: { lt: 'todo' } }]
      )
      n.set('kind', 'note')
      n.set('migratedTodo', true)
    }
  }, origin)
  return todo.length
}
