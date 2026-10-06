// Which lines are folded (collapsed bullet points) is a per-device choice, kept
// in localStorage by line id, so folding something never hides it for anyone
// else. Every editor of a note subscribes, so the card and its full-screen view
// fold together.

const KEY = 'notesFolds'
const MAX = 2000 // plenty; oldest entries fall off

export function createFoldStore() {
  let ids = []
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    if (Array.isArray(v)) ids = v.filter((x) => typeof x === 'string')
  } catch {
    ids = []
  }
  const set = new Set(ids)
  const subs = new Set()
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(Array.from(set).slice(-MAX)))
    } catch {
      /* storage full or disabled: keep it for this session */
    }
  }
  return {
    has: (id) => set.has(id),
    set(id, on) {
      if (!id) return
      if (on === set.has(id)) return
      if (on) set.add(id)
      else set.delete(id)
      save()
      subs.forEach((fn) => {
        try {
          fn(id, on)
        } catch {
          /* one broken subscriber shouldn't stop the rest */
        }
      })
    },
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
  }
}
