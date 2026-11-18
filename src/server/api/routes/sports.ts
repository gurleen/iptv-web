import { z } from '@hono/zod-openapi'
import { SportsError } from '../../sports/espn'
import { LEAGUES, LEAGUE_IDS, type LeagueId } from '../../sports/leagues'
import { gamesForEvents, matchEvents } from '../../sports/match'
import * as sports from '../../sports/service'
import { bumpVersion } from '../../db'
import { HttpError, IdParam, newRouter, route, valid } from '../hono'

const T = ['Sports']
const app = newRouter()

// ---------------- schemas ----------------
const LeagueParam = z.enum(LEAGUE_IDS).openapi({ param: { name: 'league', in: 'path' }, example: 'nfl' })

export const TeamRefSchema = z
  .object({
    id: z.string(),
    abbreviation: z.string().nullable(),
    displayName: z.string(),
    shortName: z.string().nullable(),
    location: z.string().nullable(),
    name: z.string().nullable(),
    logo: z.string().nullable(),
    color: z.string().nullable(),
    altColor: z.string().nullable(),
  })
  .openapi('Team')

const CompetitorSchema = z
  .object({
    team: TeamRefSchema,
    homeAway: z.enum(['home', 'away']),
    score: z.number().nullable(),
    record: z.string().nullable(),
    rank: z.number().nullable().openapi({ description: 'Poll rank (college), null if unranked' }),
    winner: z.boolean().nullable(),
  })
  .openapi('Competitor')

export const GameSchema = z
  .object({
    id: z.string(),
    league: z.enum(LEAGUE_IDS),
    name: z.string(),
    shortName: z.string().nullable(),
    startsAt: z.number().openapi({ description: 'Epoch ms' }),
    status: z.object({
      state: z.enum(['pre', 'in', 'post']),
      completed: z.boolean(),
      detail: z.string().nullable().openapi({ example: '3rd Quarter - 4:12' }),
      shortDetail: z.string().nullable(),
      clock: z.string().nullable(),
      period: z.number().nullable(),
    }),
    home: CompetitorSchema,
    away: CompetitorSchema,
    venue: z.object({ name: z.string().nullable(), city: z.string().nullable(), state: z.string().nullable() }).nullable(),
    neutralSite: z.boolean(),
    conferenceGame: z.boolean(),
    broadcasts: z.array(z.string()),
    odds: z.object({ details: z.string().nullable(), overUnder: z.number().nullable(), provider: z.string().nullable() }).nullable(),
    notes: z.array(z.string()),
    link: z.string().nullable(),
  })
  .openapi('Game')

const GameDetailSchema = GameSchema.extend({
  boxscore: z.array(z.object({ team: TeamRefSchema, stats: z.array(z.object({ name: z.string(), label: z.string(), value: z.string() })) })),
  leaders: z.array(
    z.object({
      team: TeamRefSchema,
      categories: z.array(
        z.object({ name: z.string(), label: z.string(), athlete: z.string().nullable(), position: z.string().nullable(), headshot: z.string().nullable(), value: z.string().nullable() }),
      ),
    }),
  ),
  injuries: z.array(
    z.object({ team: TeamRefSchema, players: z.array(z.object({ name: z.string(), position: z.string().nullable(), status: z.string().nullable(), detail: z.string().nullable() })) }),
  ),
  winProbability: z.object({ home: z.number().nullable(), away: z.number().nullable() }).nullable().openapi({ description: 'Pre-game projection, percent' }),
  seasonSeries: z.string().nullable(),
  headline: z.string().nullable(),
}).openapi('GameDetail')

const TeamDetailSchema = TeamRefSchema.extend({
  league: z.enum(LEAGUE_IDS),
  record: z.array(z.object({ type: z.string(), summary: z.string() })),
  standingSummary: z.string().nullable(),
  nextGame: GameSchema.nullable(),
}).openapi('TeamDetail')

const TeamStatsSchema = z
  .object({
    team: TeamRefSchema,
    season: z.string().nullable(),
    categories: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        stats: z.array(
          z.object({ name: z.string(), label: z.string(), abbreviation: z.string().nullable(), value: z.number().nullable(), displayValue: z.string().nullable(), rank: z.string().nullable() }),
        ),
      }),
    ),
  })
  .openapi('TeamStats')

const StandingsSchema = z
  .object({
    league: z.enum(LEAGUE_IDS),
    season: z.string().nullable(),
    groups: z.array(z.object({ name: z.string(), entries: z.array(z.object({ team: TeamRefSchema, stats: z.record(z.string(), z.string()) })) })),
  })
  .openapi('Standings')

const MatchResultSchema = z
  .object({
    eventId: z.string(),
    title: z.string(),
    league: z.enum(LEAGUE_IDS).nullable(),
    gameId: z.string().nullable(),
    gameName: z.string().nullable(),
    score: z.number(),
    status: z.enum(['matched', 'no_match', 'no_league', 'no_time', 'skipped', 'error']),
    error: z.string().optional(),
  })
  .openapi('EventGameMatch')

// ---------------- helpers ----------------
const tz = (env: Env) => (env.DEFAULT_TIMEZONE as string) || 'America/New_York'

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof SportsError) throw new HttpError(e.status === 404 ? 404 : e.status === 400 ? 400 : 502, e.message)
    throw e
  }
}

async function teamOr404(env: Env, league: LeagueId, q: string) {
  const t = await sports.findTeam(env, league, q)
  if (!t) throw new HttpError(404, `No ${league.toUpperCase()} team matching "${q}"`)
  return t
}

const teamMatches = (q: string) => {
  const s = q.toLowerCase()
  return (g: z.infer<typeof GameSchema>) =>
    [g.home.team, g.away.team].some(
      (t) => t.id === q || t.abbreviation?.toLowerCase() === s || t.displayName.toLowerCase().includes(s) || t.shortName?.toLowerCase().includes(s),
    )
}

// ---------------- reference data ----------------
app.openapi(
  route({
    method: 'get',
    path: '/sports/leagues',
    tags: T,
    summary: 'Leagues with game metadata',
    response: z.array(z.object({ id: z.enum(LEAGUE_IDS), name: z.string(), sport: z.string(), aliases: z.array(z.string()) })),
  }),
  async (c) => c.json(LEAGUES.map(({ id, name, sport, aliases }) => ({ id, name, sport, aliases }))),
)

const ScoreboardQuery = z.object({
  date: z.string().optional().openapi({ description: "YYYY-MM-DD, or today/yesterday/tomorrow (default today, in the server's timezone)" }),
  to: z.string().optional().openapi({ description: 'End date (YYYY-MM-DD) for a range starting at date; max 14 days' }),
  team: z.string().optional().openapi({ description: 'Filter by team id, abbreviation or name' }),
  state: z.enum(['pre', 'in', 'post']).optional(),
  groups: z.string().optional().openapi({ description: 'College only: provider conference/division group (default: all D1 basketball / FBS football)' }),
})

app.openapi(
  route({
    method: 'get',
    path: '/sports/{league}/scoreboard',
    tags: T,
    summary: 'Games (schedule, live scores, results) for a date or date range',
    params: z.object({ league: LeagueParam }),
    query: ScoreboardQuery,
    response: z.array(GameSchema),
  }),
  async (c) => {
    const { league } = valid(c, 'param') as { league: LeagueId }
    const q = valid(c, 'query') as z.infer<typeof ScoreboardQuery>
    const from = await wrap(async () => sports.parseDay(q.date, tz(c.env)))
    let dates = from
    if (q.to) {
      const to = await wrap(async () => sports.parseDay(q.to, tz(c.env)))
      const span = (Date.parse(`${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6)}`) - Date.parse(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6)}`)) / 86400_000
      if (span < 0 || span > 14) throw new HttpError(400, 'Date range must be 0-14 days')
      dates = `${from}-${to}`
    }
    let games = await wrap(() => sports.scoreboard(c.env, league, dates, q.groups))
    if (q.team) games = games.filter(teamMatches(q.team))
    if (q.state) games = games.filter((g) => g.status.state === q.state)
    return c.json(games.sort((a, b) => a.startsAt - b.startsAt) as any)
  },
)

app.openapi(
  route({
    method: 'get',
    path: '/sports/{league}/games/{gameId}',
    tags: T,
    summary: 'Full game detail: score, box score, leaders, injuries, odds, win probability',
    params: z.object({ league: LeagueParam, gameId: z.string().openapi({ param: { name: 'gameId', in: 'path' } }) }),
    response: GameDetailSchema,
  }),
  async (c) => {
    const { league, gameId } = valid(c, 'param') as { league: LeagueId; gameId: string }
    return c.json((await wrap(() => sports.game(c.env, league, gameId))) as any)
  },
)

app.openapi(
  route({
    method: 'get',
    path: '/sports/{league}/teams',
    tags: T,
    summary: 'Teams in a league (optionally filtered by name/abbreviation)',
    params: z.object({ league: LeagueParam }),
    query: z.object({ q: z.string().optional() }),
    response: z.array(TeamRefSchema),
  }),
  async (c) => {
    const { league } = valid(c, 'param') as { league: LeagueId }
    const { q } = valid(c, 'query') as { q?: string }
    let teams = await wrap(() => sports.teams(c.env, league))
    if (q) {
      const s = q.toLowerCase()
      teams = teams.filter((t) => t.abbreviation?.toLowerCase() === s || t.displayName.toLowerCase().includes(s) || t.location?.toLowerCase().includes(s))
    }
    return c.json(teams as any)
  },
)

const TeamParams = z.object({
  league: LeagueParam,
  team: z.string().openapi({ param: { name: 'team', in: 'path' }, description: 'Team id, abbreviation or name', example: 'GB' }),
})

app.openapi(
  route({
    method: 'get',
    path: '/sports/{league}/teams/{team}',
    tags: T,
    summary: 'Team detail: record, standing summary, next game',
    params: TeamParams,
    response: TeamDetailSchema,
  }),
  async (c) => {
    const { league, team } = valid(c, 'param') as { league: LeagueId; team: string }
    const t = await wrap(() => teamOr404(c.env, league, team))
    return c.json((await wrap(() => sports.team(c.env, league, t.id))) as any)
  },
)

app.openapi(
  route({
    method: 'get',
    path: '/sports/{league}/teams/{team}/schedule',
    tags: T,
    summary: "A team's season schedule and results",
    params: TeamParams,
    query: z.object({ season: z.string().optional().openapi({ description: 'Season year, e.g. 2026 (default current)' }) }),
    response: z.array(GameSchema),
  }),
  async (c) => {
    const { league, team } = valid(c, 'param') as { league: LeagueId; team: string }
    const { season } = valid(c, 'query') as { season?: string }
    const t = await wrap(() => teamOr404(c.env, league, team))
    return c.json((await wrap(() => sports.teamSchedule(c.env, league, t.id, season))) as any)
  },
)

app.openapi(
  route({
    method: 'get',
    path: '/sports/{league}/teams/{team}/stats',
    tags: T,
    summary: "A team's season statistics (with league ranks where available)",
    params: TeamParams,
    response: TeamStatsSchema,
  }),
  async (c) => {
    const { league, team } = valid(c, 'param') as { league: LeagueId; team: string }
    const t = await wrap(() => teamOr404(c.env, league, team))
    return c.json((await wrap(() => sports.teamStats(c.env, league, t.id))) as any)
  },
)

app.openapi(
  route({
    method: 'get',
    path: '/sports/{league}/standings',
    tags: T,
    summary: 'Standings, grouped by conference/division',
    params: z.object({ league: LeagueParam }),
    query: z.object({ season: z.string().optional() }),
    response: StandingsSchema,
  }),
  async (c) => {
    const { league } = valid(c, 'param') as { league: LeagueId }
    const { season } = valid(c, 'query') as { season?: string }
    return c.json((await wrap(() => sports.standings(c.env, league, season))) as any)
  },
)

// ---------------- events <-> games ----------------
app.openapi(
  route({
    method: 'post',
    path: '/events/match-games',
    tags: T,
    summary: 'Link events to real games by league, team names in the title and start time',
    description:
      "Runs automatically after event rules. Manual links and events explicitly unlinked are never changed; force re-checks existing automatic links. An event's league comes from its league field or a 'NFL: …' title prefix.",
    body: z.object({ eventIds: z.array(z.string()).optional(), force: z.boolean().optional() }),
    response: z.array(MatchResultSchema),
  }),
  async (c) => {
    const b = valid(c, 'json') as { eventIds?: string[]; force?: boolean }
    const r = await matchEvents(c.env, b)
    if (r.some((x) => x.status === 'matched')) await bumpVersion(c.env, 'events_version')
    return c.json(r as any)
  },
)

app.openapi(
  route({
    method: 'get',
    path: '/events/{id}/game',
    tags: T,
    summary: "Full detail for an event's linked game",
    params: IdParam,
    response: GameDetailSchema.extend({ link: z.string().nullable(), eventId: z.string() }),
  }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    const e = await c.env.DB.prepare('SELECT game_league, game_id FROM events WHERE id = ?').bind(id).first<{ game_league: string | null; game_id: string | null }>()
    if (!e) throw new HttpError(404, 'event not found')
    if (!e.game_league || !e.game_id) throw new HttpError(404, 'event is not linked to a game')
    const g = await wrap(() => sports.game(c.env, e.game_league as LeagueId, e.game_id!))
    return c.json({ ...g, eventId: id } as any)
  },
)

const LinkBody = z
  .object({
    league: z.enum(LEAGUE_IDS).nullable(),
    gameId: z.string().nullable().openapi({ description: 'null unlinks the event and stops automatic matching for it' }),
  })
  .openapi('EventGameLink')

app.openapi(
  route({
    method: 'put',
    path: '/events/{id}/game',
    tags: T,
    summary: 'Manually link (or unlink) an event to a game',
    params: IdParam,
    body: LinkBody,
    response: z.object({ eventId: z.string(), gameLeague: z.string().nullable(), gameId: z.string().nullable(), gameLink: z.string(), game: GameSchema.nullable() }),
  }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    const b = valid(c, 'json') as z.infer<typeof LinkBody>
    const ev = await c.env.DB.prepare('SELECT id, starts_at FROM events WHERE id = ?').bind(id).first<{ id: string; starts_at: number | null }>()
    if (!ev) throw new HttpError(404, 'event not found')
    let game = null
    if (b.league && b.gameId) {
      game = (await wrap(() => sports.game(c.env, b.league!, b.gameId!))) as any
      await c.env.DB.prepare("UPDATE events SET game_league = ?, game_id = ?, game_link = 'manual', updated_at = ? WHERE id = ?")
        .bind(b.league, b.gameId, Date.now(), id)
        .run()
    } else {
      await c.env.DB.prepare("UPDATE events SET game_league = NULL, game_id = NULL, game_link = 'none', updated_at = ? WHERE id = ?").bind(Date.now(), id).run()
    }
    await bumpVersion(c.env, 'events_version')
    const [slim] = game ? [...(await gamesForEvents(c.env, [{ id, startsAt: ev.starts_at, gameLeague: b.league, gameId: b.gameId }])).values()] : [null]
    return c.json({ eventId: id, gameLeague: b.league ?? null, gameId: b.gameId ?? null, gameLink: game ? 'manual' : 'none', game: slim ?? null } as any)
  },
)

export default app
