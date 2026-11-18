import * as espn from './espn'
import type { Game } from './espn'
import type { LeagueId } from './leagues'

/** Per-isolate memo in front of the D1 cache (cheap repeat reads within one Worker instance). */
const memo = new Map<string, { v: unknown; exp: number }>()

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN

async function cached<T>(env: Env, key: string, ttl: (v: T) => number, load: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const m = memo.get(key)
  if (m && m.exp > now) return m.v as T
  const row = await env.DB.prepare('SELECT value, expires_at FROM sports_cache WHERE key = ?').bind(key).first<{ value: string; expires_at: number }>()
  if (row && row.expires_at > now) {
    const v = JSON.parse(row.value) as T
    memo.set(key, { v, exp: Math.min(row.expires_at, now + 30 * SEC) })
    return v
  }
  try {
    const v = await load()
    const exp = now + ttl(v)
    memo.set(key, { v, exp: Math.min(exp, now + 30 * SEC) })
    await env.DB.prepare(
      'INSERT INTO sports_cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
    )
      .bind(key, JSON.stringify(v), exp)
      .run()
    return v
  } catch (e) {
    // provider down: serve stale data if we have any
    if (row) return JSON.parse(row.value) as T
    throw e
  }
}

/** Live games change fast; finished/upcoming ones don't. */
const gamesTtl = (games: Game[]) => {
  if (games.some((g) => g.status.state === 'in')) return 30 * SEC
  const soon = games.some((g) => g.status.state === 'pre' && g.startsAt - Date.now() < 30 * MIN)
  return soon ? 1 * MIN : 10 * MIN
}

// ---------------- dates ----------------
/** epoch ms -> YYYYMMDD in a timezone */
export function dayKey(ms: number, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]),
  )
  return `${p.year}${p.month}${p.day}`
}

/** Accepts YYYYMMDD, YYYY-MM-DD, or 'today'/'yesterday'/'tomorrow'. */
export function parseDay(input: string | undefined, tz: string): string {
  const now = Date.now()
  if (!input || input === 'today') return dayKey(now, tz)
  if (input === 'yesterday') return dayKey(now - 86400_000, tz)
  if (input === 'tomorrow') return dayKey(now + 86400_000, tz)
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(input)
  if (!m) throw new espn.SportsError(400, `Invalid date "${input}" (use YYYY-MM-DD)`)
  return `${m[1]}${m[2]}${m[3]}`
}

// ---------------- cached operations ----------------
const scoreboardDay = (env: Env, league: LeagueId, day: string, groups?: string) =>
  cached(env, `sb:${league}:${day}:${groups ?? ''}`, gamesTtl, () => espn.fetchScoreboard(league, day, groups))

/** All days from..to (YYYYMMDD) as YYYYMMDD strings. */
export function daysBetween(from: string, to: string) {
  const d = (k: string) => Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8))
  const out: string[] = []
  for (let t = d(from); t <= d(to) && out.length < 31; t += 86400_000) out.push(dayKey(t, 'UTC'))
  return out
}

/**
 * Games for one day ("YYYYMMDD") or an inclusive range ("YYYYMMDD-YYYYMMDD"). The provider has no
 * range queries, so days are fetched (and cached) individually and merged.
 */
export async function scoreboard(env: Env, league: LeagueId, dates: string, groups?: string) {
  const [from, to = from] = dates.split('-')
  const days = await Promise.all(daysBetween(from, to).map((d) => scoreboardDay(env, league, d, groups)))
  const seen = new Set<string>()
  return days.flat().filter((g) => !seen.has(g.id) && (seen.add(g.id), true))
}

export const game = (env: Env, league: LeagueId, id: string) =>
  cached(env, `game:${league}:${id}`, (g) => (g.status.state === 'in' ? 30 * SEC : g.status.state === 'post' ? 6 * HOUR : 15 * MIN), () =>
    espn.fetchGame(league, id),
  )

export const teams = (env: Env, league: LeagueId) => cached(env, `teams:${league}`, () => 24 * HOUR, () => espn.fetchTeams(league))

export const team = (env: Env, league: LeagueId, id: string) => cached(env, `team:${league}:${id}`, () => 1 * HOUR, () => espn.fetchTeam(league, id))

export const teamSchedule = (env: Env, league: LeagueId, id: string, season?: string) =>
  cached(env, `sched:${league}:${id}:${season ?? ''}`, gamesTtl, () => espn.fetchTeamSchedule(league, id, season))

export const teamStats = (env: Env, league: LeagueId, id: string) => cached(env, `tstats:${league}:${id}`, () => 3 * HOUR, () => espn.fetchTeamStats(league, id))

export const standings = (env: Env, league: LeagueId, season?: string) =>
  cached(env, `stand:${league}:${season ?? ''}`, () => 1 * HOUR, () => espn.fetchStandings(league, season))

/** Resolve a team by id, abbreviation or (partial) name. */
export async function findTeam(env: Env, league: LeagueId, q: string) {
  const all = await teams(env, league)
  const s = q.trim().toLowerCase()
  return (
    all.find((t) => t.id === q) ??
    all.find((t) => t.abbreviation?.toLowerCase() === s) ??
    all.find((t) => t.displayName.toLowerCase() === s || t.shortName?.toLowerCase() === s) ??
    all.find((t) => t.displayName.toLowerCase().includes(s))
  )
}

export async function pruneCache(env: Env) {
  await env.DB.prepare('DELETE FROM sports_cache WHERE expires_at < ?').bind(Date.now() - 2 * 86400_000).run()
}
