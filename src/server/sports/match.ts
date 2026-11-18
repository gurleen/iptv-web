import type { Game, TeamRef } from './espn'
import { leagueFromText, type LeagueId } from './leagues'
import { dayKey, game as getGame, scoreboard } from './service'

const MAX_DIFF_MS = 4 * 3600_000

const norm = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bst\.\s/g, 'state ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `

/** How strongly a team is named in the (normalised) title: length of the longest matching name, 0 if absent. */
function teamScore(t: TeamRef, title: string, rawTitle: string) {
  let best = 0
  for (const k of [t.displayName, t.shortName, t.location, t.name, t.location && t.name ? `${t.location} ${t.name}` : null]) {
    if (!k) continue
    const nk = norm(k)
    if (nk.trim().length >= 3 && title.includes(nk)) best = Math.max(best, nk.trim().length)
  }
  // abbreviations only count as an exact upper-case token ("BOS @ DET")
  if (t.abbreviation && t.abbreviation.length >= 2 && new RegExp(`(^|[^A-Za-z])${t.abbreviation}([^A-Za-z]|$)`).test(rawTitle)) best = Math.max(best, 3)
  return best
}

export function scoreGame(g: Game, rawTitle: string, startsAt: number | null) {
  const title = norm(rawTitle)
  const h = teamScore(g.home.team, title, rawTitle)
  const a = teamScore(g.away.team, title, rawTitle)
  const diff = startsAt == null ? null : Math.abs(g.startsAt - startsAt)
  if (diff != null && diff > MAX_DIFF_MS) return 0
  if (h && a) return h + a + 20 + (diff != null && diff <= 30 * 60_000 ? 10 : 0)
  // one team named: only trust it when the time lines up closely
  if ((h || a) && diff != null && diff <= 45 * 60_000) return Math.max(h, a)
  return 0
}

/** Best matching game for an event title + time, or null. */
export function bestGame(games: Game[], title: string, startsAt: number | null) {
  let best: { game: Game; score: number } | null = null
  for (const g of games) {
    const s = scoreGame(g, title, startsAt)
    if (s > 0 && (!best || s > best.score)) best = { game: g, score: s }
  }
  return best
}

/** League for an event: its league field, else a "NFL: ..." style title prefix. */
export function eventLeague(e: { league: string | null; title: string }): LeagueId | null {
  const l = leagueFromText(e.league) ?? leagueFromText(/^\s*([^:|\-–]{2,40})\s*[:|\-–]/.exec(e.title)?.[1])
  return l?.id ?? null
}

/** Scoreboard covering the day before/after (handles late games and timezone edges). */
export function gamesAround(env: Env, league: LeagueId, startsAt: number) {
  return scoreboard(env, league, `${dayKey(startsAt - 86400_000, 'UTC')}-${dayKey(startsAt + 86400_000, 'UTC')}`)
}

type EventRow = { id: string; title: string; league: string | null; starts_at: number | null; game_link: string | null }
export type MatchResult = {
  eventId: string
  title: string
  league: LeagueId | null
  gameId: string | null
  gameName: string | null
  score: number
  status: 'matched' | 'no_match' | 'no_league' | 'no_time' | 'skipped' | 'error'
  error?: string
}

/**
 * Link events to real games. Manual links (and explicit "none") are left alone; with force,
 * existing auto links are re-evaluated.
 */
export async function matchEvents(env: Env, opts: { eventIds?: string[]; force?: boolean; limit?: number } = {}) {
  const where = ['e.starts_at IS NOT NULL', 'e.starts_at > ?', 'e.starts_at < ?']
  const args: unknown[] = [Date.now() - 2 * 86400_000, Date.now() + 21 * 86400_000]
  if (opts.eventIds?.length) {
    where.push('e.id IN (SELECT value FROM json_each(?))')
    args.push(JSON.stringify(opts.eventIds))
  }
  where.push(opts.force ? "COALESCE(e.game_link, '') NOT IN ('manual', 'none')" : 'e.game_link IS NULL')
  const { results } = await env.DB.prepare(`SELECT e.id, e.title, e.league, e.starts_at, e.game_link FROM events e WHERE ${where.join(' AND ')} LIMIT ?`)
    .bind(...args, opts.limit ?? 300)
    .all<EventRow>()

  const out: MatchResult[] = []
  const stmts: D1PreparedStatement[] = []
  for (const e of results) {
    const league = eventLeague(e)
    const base = { eventId: e.id, title: e.title, league, gameId: null, gameName: null, score: 0 }
    if (!league) {
      out.push({ ...base, status: 'no_league' })
      continue
    }
    try {
      const games = await gamesAround(env, league, e.starts_at!)
      const best = bestGame(games, e.title, e.starts_at)
      if (!best) {
        out.push({ ...base, status: 'no_match' })
        continue
      }
      stmts.push(
        env.DB.prepare("UPDATE events SET game_league = ?, game_id = ?, game_link = 'auto' WHERE id = ? AND COALESCE(game_link, 'auto') = 'auto'").bind(
          league, best.game.id, e.id,
        ),
      )
      out.push({ ...base, gameId: best.game.id, gameName: best.game.name, score: best.score, status: 'matched' })
    } catch (err) {
      out.push({ ...base, status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50))
  return out
}

/** Current game data for linked events (one scoreboard call per league/day, cached). */
export async function gamesForEvents(env: Env, events: { id: string; startsAt: number | null; gameLeague: string | null; gameId: string | null }[]) {
  const out = new Map<string, Game>()
  let fallbacks = 0
  for (const e of events) {
    if (!e.gameLeague || !e.gameId) continue
    const league = e.gameLeague as LeagueId
    try {
      let g = e.startsAt != null ? (await gamesAround(env, league, e.startsAt)).find((x) => x.id === e.gameId) : undefined
      if (!g && fallbacks++ < 10) g = await getGame(env, league, e.gameId)
      if (g) out.set(e.id, stripDetail(g))
    } catch {
      // sports data is best-effort enrichment; never break the events output
    }
  }
  return out
}

/** Keep only the scoreboard-level fields (summary objects carry box scores etc.). */
function stripDetail(g: Game): Game {
  const { id, league, name, shortName, startsAt, status, home, away, venue, neutralSite, conferenceGame, broadcasts, odds, notes, link } = g
  return { id, league, name, shortName, startsAt, status, home, away, venue, neutralSite, conferenceGame, broadcasts, odds, notes, link }
}
