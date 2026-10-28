// Natural-language dates for "@friday", "@tomorrow", "@in 3 days", "@3 nov".
// A tiny hand-written parser (no dependency), shared by the editor and tests.
// Everything works in local calendar days as 'YYYY-MM-DD' (see shared/tasks.js).

import { ymd, parseYmd, addDays, validDate } from './tasks.js'

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 }

// "fri", "frid", "friday" → 5 (at least three letters; "tues" and "thurs" too)
function weekday(word) {
  if (!word || word.length < 3) return -1
  return WEEKDAYS.findIndex((d) => d.startsWith(word))
}
// "nov", "november", "sept" → 10 (at least three letters)
function month(word) {
  if (!word || word.length < 3) return -1
  return MONTHS.findIndex((m) => m.startsWith(word))
}

const validDay = (y, m, d) => {
  const dt = new Date(y, m, d)
  return dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d
}

/**
 * Parse a phrase into 'YYYY-MM-DD', or null if it is not a date this knows.
 * `today` is 'YYYY-MM-DD' (defaults to the real today). A weekday is the next
 * one from today (today itself counts); "next friday" is the one a week after.
 * A day and month without a year is the next time that date comes round.
 */
export function parseNatural(phrase, today = ymd(new Date())) {
  const s = String(phrase || '')
    .toLowerCase()
    .trim()
    .replace(/[.,]+$/, '')
    .replace(/\s+/g, ' ')
  if (!s) return null
  if (s === 'today' || s === 'tod') return today
  if (s === 'tomorrow' || s === 'tmrw' || s === 'tmr') return addDays(today, 1)
  if (s === 'yesterday') return addDays(today, -1)
  if (validDate(s)) {
    const [y, m, d] = s.split('-').map(Number)
    return validDay(y, m - 1, d) ? s : null
  }

  // in 3 days / in 2 weeks / in a month / in 1 year
  let m = /^in (\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) (day|days|week|weeks|wk|wks|month|months|mo|year|years|yr|yrs)$/.exec(s)
  if (m) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBERS[m[1]]
    const unit = m[2]
    if (unit.startsWith('d')) return addDays(today, n)
    if (unit.startsWith('w')) return addDays(today, 7 * n)
    const dt = parseYmd(today)
    if (unit.startsWith('m')) {
      const target = new Date(dt.getFullYear(), dt.getMonth() + n, 1)
      const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
      return ymd(new Date(target.getFullYear(), target.getMonth(), Math.min(dt.getDate(), last)))
    }
    return ymd(new Date(dt.getFullYear() + n, dt.getMonth(), Math.min(dt.getDate(), new Date(dt.getFullYear() + n, dt.getMonth() + 1, 0).getDate())))
  }

  // next week / next month
  if (s === 'next week') return addDays(today, 7)
  if (s === 'next month') return parseNatural('in 1 month', today)

  // friday / this friday / next friday
  m = /^(this |next )?([a-z]+)$/.exec(s)
  if (m) {
    const wd = weekday(m[2])
    if (wd >= 0) {
      const now = parseYmd(today).getDay()
      let ahead = (wd - now + 7) % 7
      if (m[1] === 'next ') ahead += 7
      return addDays(today, ahead)
    }
  }

  // 3 nov / 3rd november / nov 3 / november 3rd (optionally with a year)
  m = /^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]+)(?: (\d{4}))?$/.exec(s) || null
  let day, mon, year
  if (m) {
    day = Number(m[1])
    mon = month(m[2])
    year = m[3] ? Number(m[3]) : null
  } else {
    m = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/.exec(s)
    if (m) {
      mon = month(m[1])
      day = Number(m[2])
      year = m[3] ? Number(m[3]) : null
    }
  }
  if (m && mon >= 0) {
    const t = parseYmd(today)
    if (year != null) return validDay(year, mon, day) ? ymd(new Date(year, mon, day)) : null
    for (const y of [t.getFullYear(), t.getFullYear() + 1]) {
      if (!validDay(y, mon, day)) continue
      const d = ymd(new Date(y, mon, day))
      if (d >= today) return d
    }
    return null
  }
  return null
}

/**
 * Typing just finished a word: if the text before the caret ends in "@phrase"
 * (up to four words) that is a date, return { from, to, date } where [from, to)
 * is the "@phrase" to replace with "@YYYY-MM-DD". `before` is the line's text
 * up to the caret. The longest phrase that parses wins, so "@next friday"
 * beats "@friday".
 */
export function dateBeforeCaret(before, today) {
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/[\s(]/.test(before[at - 1])) return null // an e-mail address, not a date
  const phrase = before.slice(at + 1)
  if (!phrase || phrase.length > 40 || /^\d{4}-\d{2}-\d{2}$/.test(phrase)) return null
  if (phrase.split(' ').length > 4) return null
  const date = parseNatural(phrase, today)
  return date ? { from: at, to: before.length, date } : null
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "Fri 30 Oct" (with the year when it isn't this year). */
export function dateLabel(date, today = ymd(new Date())) {
  if (!validDate(date)) return ''
  const d = parseYmd(date)
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}` + (date.slice(0, 4) === today.slice(0, 4) ? '' : ' ' + d.getFullYear())
}
