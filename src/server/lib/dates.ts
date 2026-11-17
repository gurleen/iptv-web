/**
 * Extract an event start time from free text such as provider PPV channel names:
 *   "PPV 03: UFC 310 Pantoja vs Asakura | Sat 12/07 10:00 PM ET"
 *   "NFL 05 - Bears @ Packers (2026-11-22 13:00)"
 *   "Boxing: Canelo v Crawford - Sep 13 9PM EDT"
 *   "NBA: Lakers vs Celtics @ 7:30pm"
 */

const TZ_ABBR: Record<string, string> = {
  ET: 'America/New_York', EST: 'America/New_York', EDT: 'America/New_York',
  CT: 'America/Chicago', CST: 'America/Chicago', CDT: 'America/Chicago',
  MT: 'America/Denver', MST: 'America/Denver', MDT: 'America/Denver',
  PT: 'America/Los_Angeles', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles',
  UK: 'Europe/London', GMT: 'Europe/London', BST: 'Europe/London',
  CET: 'Europe/Paris', CEST: 'Europe/Paris',
  UTC: 'UTC', Z: 'UTC',
  AEST: 'Australia/Sydney', AEDT: 'Australia/Sydney',
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Offset (ms) of `timeZone` from UTC at instant `utcMs`. */
function tzOffset(utcMs: number, timeZone: string) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]))
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return asUtc - utcMs
}

/** Convert a wall-clock time in an IANA zone to epoch ms. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone: string) {
  const guess = Date.UTC(y, mo, d, h, mi)
  let t = guess - tzOffset(guess, timeZone)
  // second pass handles DST transitions
  t = guess - tzOffset(t, timeZone)
  return t
}

function zonedParts(utcMs: number, timeZone: string) {
  const d = new Date(utcMs + tzOffset(utcMs, timeZone))
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate() }
}

export type ParsedDate = { start: number; hasDate: boolean; matched: string }

export function parseEventDate(text: string, defaultTz = 'America/New_York', now = Date.now()): ParsedDate | null {
  let tz = defaultTz
  const tzm = /\b(ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT|UK|GMT|BST|CET|CEST|UTC|AEST|AEDT)\b/.exec(text)
  if (tzm) tz = TZ_ABBR[tzm[1]]

  const today = zonedParts(now, tz)
  let y: number | null = null
  let mo: number | null = null
  let d: number | null = null
  let dateStr = ''

  // ISO 2026-11-22
  let m = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(text)
  if (m) {
    ;[y, mo, d] = [+m[1], +m[2] - 1, +m[3]]
    dateStr = m[0]
  }
  // Month name: "Nov 22", "22 Nov", "November 22nd, 2026"
  if (mo == null) {
    m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/i.exec(text)
    if (m) {
      mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase())
      d = +m[2]
      y = m[3] ? +m[3] : null
      dateStr = m[0]
    } else {
      m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s+(20\d{2}))?\b/i.exec(text)
      if (m) {
        d = +m[1]
        mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase())
        y = m[3] ? +m[3] : null
        dateStr = m[0]
      }
    }
  }
  // Numeric M/D(/YY). European D/M is ambiguous; use M/D unless first part > 12.
  if (mo == null) {
    m = /(?<![\d:])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\d:])/.exec(text)
    if (m) {
      let a = +m[1]
      let b = +m[2]
      if (a > 12 && b <= 12) [a, b] = [b, a]
      if (a >= 1 && a <= 12 && b >= 1 && b <= 31) {
        mo = a - 1
        d = b
        y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null
        dateStr = m[0]
      }
    }
  }

  // Time: "10:00 PM", "10PM", "22:00", "7.30pm"
  const rest = dateStr ? text.replace(dateStr, ' ') : text
  let h: number | null = null
  let mi = 0
  m = /\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?m\.?\b/i.exec(rest)
  if (m) {
    h = +m[1] % 12 + (m[3].toLowerCase() === 'p' ? 12 : 0)
    mi = m[2] ? +m[2] : 0
  } else {
    m = /(?<![\d/])([01]?\d|2[0-3])[:h]([0-5]\d)(?![\d/])/.exec(rest)
    if (m) {
      h = +m[1]
      mi = +m[2]
    }
  }

  if (mo == null && h == null) return null

  const hasDate = mo != null
  if (hasDate) {
    if (y == null) {
      // no year: pick the occurrence closest to now (handles Dec -> Jan rollover)
      y = today.y
      const candidate = zonedToUtc(y, mo!, d!, h ?? 0, mi, tz)
      if (candidate < now - 180 * 86400_000) y += 1
      else if (candidate > now + 180 * 86400_000) y -= 1
    }
    return { start: zonedToUtc(y, mo!, d!, h ?? 0, mi, tz), hasDate: true, matched: dateStr }
  }

  // time only: today in tz, or tomorrow if that was more than 6h ago
  let start = zonedToUtc(today.y, today.mo, today.d, h!, mi, tz)
  if (start < now - 6 * 3600_000) start += 86400_000
  return { start, hasDate: false, matched: '' }
}

/** Remove the date/time/timezone fragments so the remainder can be used as a title. */
export function stripDateText(text: string) {
  return text
    .replace(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/g, ' ')
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s/gi, ' ')
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+20\d{2})?/gi, ' ')
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s+20\d{2})?/gi, ' ')
    .replace(/(?<![\d:])\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?![\d:])/g, ' ')
    .replace(/@?\s*\b\d{1,2}(?:[:.]\d{2})?\s*[ap]\.?m\.?\b/gi, ' ')
    .replace(/(?<![\d/])([01]?\d|2[0-3])[:h][0-5]\d(?![\d/])/g, ' ')
    .replace(/\b(ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT|UK|GMT|BST|CET|CEST|UTC|AEST|AEDT)\b/g, ' ')
    .replace(/[()[\]]\s*[()[\]]/g, ' ')
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/\s*[|\-–@:,]+\s*$/g, '')
    .replace(/^\s*[|\-–@:,]+\s*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
