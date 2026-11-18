/**
 * ESPN public site API adapter (undocumented, keyless). Everything is normalised into our own
 * shapes so the rest of the app never sees ESPN's format, and swapping providers stays local.
 */
import { getLeague, type League, type LeagueId } from './leagues'

const SITE = 'https://site.api.espn.com/apis/site/v2/sports'
const WEB = 'https://site.web.api.espn.com/apis/v2/sports'

// ---------------- normalised types ----------------
export type TeamRef = {
  id: string
  abbreviation: string | null
  displayName: string
  shortName: string | null
  location: string | null
  name: string | null
  logo: string | null
  color: string | null
  altColor: string | null
}

export type Competitor = {
  team: TeamRef
  homeAway: 'home' | 'away'
  score: number | null
  record: string | null
  rank: number | null
  winner: boolean | null
}

export type GameStatus = {
  state: 'pre' | 'in' | 'post'
  completed: boolean
  detail: string | null
  shortDetail: string | null
  clock: string | null
  period: number | null
}

export type Game = {
  id: string
  league: LeagueId
  name: string
  shortName: string | null
  startsAt: number
  status: GameStatus
  home: Competitor
  away: Competitor
  venue: { name: string | null; city: string | null; state: string | null } | null
  neutralSite: boolean
  conferenceGame: boolean
  broadcasts: string[]
  odds: { details: string | null; overUnder: number | null; provider: string | null } | null
  notes: string[]
  link: string | null
}

export type StatLine = { name: string; label: string; value: string }
export type GameDetail = Game & {
  boxscore: { team: TeamRef; stats: StatLine[] }[]
  leaders: { team: TeamRef; categories: { name: string; label: string; athlete: string | null; position: string | null; headshot: string | null; value: string | null }[] }[]
  injuries: { team: TeamRef; players: { name: string; position: string | null; status: string | null; detail: string | null }[] }[]
  winProbability: { home: number | null; away: number | null } | null
  seasonSeries: string | null
  headline: string | null
}

export type TeamDetail = TeamRef & {
  league: LeagueId
  record: { type: string; summary: string }[]
  standingSummary: string | null
  nextGame: Game | null
}

export type TeamStats = {
  team: TeamRef
  season: string | null
  categories: { name: string; label: string; stats: { name: string; label: string; abbreviation: string | null; value: number | null; displayValue: string | null; rank: string | null }[] }[]
}

export type Standings = {
  league: LeagueId
  season: string | null
  groups: { name: string; entries: { team: TeamRef; stats: Record<string, string> }[] }[]
}

// ---------------- fetch ----------------
export class SportsError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; iptv-web)' } })
  if (res.status === 404) throw new SportsError(404, 'Not found at the sports data provider')
  if (!res.ok) throw new SportsError(502, `Sports data provider returned HTTP ${res.status}`)
  return res.json()
}

const lg = (id: LeagueId): League => getLeague(id)!
const base = (l: League) => `${SITE}/${l.sport}/${l.espn}`

// ---------------- normalisers ----------------
const str = (v: unknown) => (v == null || v === '' ? null : String(v))
const num = (v: unknown) => {
  if (v && typeof v === 'object' && 'value' in (v as any)) v = (v as any).value
  const n = typeof v === 'string' ? parseFloat(v) : (v as number)
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

export function normTeam(t: any): TeamRef {
  const logo = t?.logo ?? t?.logos?.[0]?.href ?? null
  return {
    id: String(t?.id ?? ''),
    abbreviation: str(t?.abbreviation),
    displayName: t?.displayName ?? t?.name ?? 'TBD',
    shortName: str(t?.shortDisplayName),
    location: str(t?.location),
    name: str(t?.name ?? t?.nickname),
    logo,
    color: t?.color ? `#${t.color}` : null,
    altColor: t?.alternateColor ? `#${t.alternateColor}` : null,
  }
}

function normCompetitor(c: any): Competitor {
  const rec = (c?.records ?? c?.record ?? []).find?.((r: any) => r.type === 'total' || r.name === 'overall') ?? c?.records?.[0] ?? c?.record?.[0]
  const rank = num(c?.curatedRank?.current)
  return {
    team: normTeam(c?.team),
    homeAway: c?.homeAway === 'away' ? 'away' : 'home',
    score: num(c?.score),
    record: str(rec?.summary ?? rec?.displayValue),
    rank: rank && rank < 99 ? rank : null,
    winner: typeof c?.winner === 'boolean' ? c.winner : null,
  }
}

function normStatus(s: any): GameStatus {
  const t = s?.type ?? {}
  const state = t.state === 'in' || t.state === 'post' ? t.state : 'pre'
  return {
    state,
    completed: !!t.completed,
    detail: str(t.detail ?? t.description),
    shortDetail: str(t.shortDetail),
    clock: state === 'in' ? str(s?.displayClock) : null,
    period: state === 'pre' ? null : num(s?.period),
  }
}

export function normGame(e: any, league: LeagueId): Game {
  const c = e?.competitions?.[0] ?? {}
  const comps: any[] = c.competitors ?? []
  const home = comps.find((x) => x.homeAway === 'home') ?? comps[0]
  const away = comps.find((x) => x.homeAway === 'away') ?? comps[1]
  const odds = c.odds?.[0]
  const names = new Set<string>()
  for (const b of c.broadcasts ?? []) for (const n of b.names ?? []) names.add(n)
  for (const b of c.geoBroadcasts ?? []) if (b.media?.shortName) names.add(b.media.shortName)
  return {
    id: String(e.id),
    league,
    name: e.name ?? '',
    shortName: str(e.shortName),
    startsAt: Date.parse(c.date ?? e.date),
    status: normStatus(c.status ?? e.status),
    home: normCompetitor(home),
    away: normCompetitor(away),
    venue: c.venue ? { name: str(c.venue.fullName), city: str(c.venue.address?.city), state: str(c.venue.address?.state) } : null,
    neutralSite: !!c.neutralSite,
    conferenceGame: !!c.conferenceCompetition,
    broadcasts: [...names],
    odds: odds && (odds.details || odds.overUnder != null) ? { details: str(odds.details), overUnder: num(odds.overUnder), provider: str(odds.provider?.name) } : null,
    notes: (c.notes ?? []).map((n: any) => n.headline).filter(Boolean),
    link: e.links?.find((l: any) => l.rel?.includes('summary'))?.href ?? e.links?.[0]?.href ?? null,
  }
}

// ---------------- operations ----------------
/** YYYYMMDD or YYYYMMDD-YYYYMMDD */
export async function fetchScoreboard(league: LeagueId, dates: string, groups?: string): Promise<Game[]> {
  const l = lg(league)
  const q = new URLSearchParams({ dates, limit: '1000' })
  const g = groups ?? l.groups
  if (g) q.set('groups', g)
  const d = await getJson(`${base(l)}/scoreboard?${q}`)
  return (d.events ?? []).map((e: any) => normGame(e, league))
}

export async function fetchGame(league: LeagueId, gameId: string): Promise<GameDetail> {
  const l = lg(league)
  const d = await getJson(`${base(l)}/summary?event=${encodeURIComponent(gameId)}`)
  const h = d.header ?? {}
  const comp = h.competitions?.[0] ?? {}
  // the summary header has no venue/broadcast/odds; merge in from gameInfo/pickcenter
  const game = normGame({ id: h.id ?? gameId, name: h.name, shortName: h.shortName, competitions: [comp], links: h.links }, league)
  if (!game.name) game.name = `${game.away.team.displayName} at ${game.home.team.displayName}`
  if (!game.shortName && game.away.team.abbreviation && game.home.team.abbreviation)
    game.shortName = `${game.away.team.abbreviation} @ ${game.home.team.abbreviation}`
  const gi = d.gameInfo?.venue
  if (gi) game.venue = { name: str(gi.fullName), city: str(gi.address?.city), state: str(gi.address?.state) }
  const bc = new Set(game.broadcasts)
  for (const b of d.broadcasts ?? []) if (b.media?.shortName) bc.add(b.media.shortName)
  game.broadcasts = [...bc]
  const pc = d.pickcenter?.[0]
  if (game.odds && !game.odds.details && game.odds.overUnder == null) game.odds = null
  if (pc && !game.odds) game.odds = { details: str(pc.details), overUnder: num(pc.overUnder), provider: str(pc.provider?.name) }

  const wp = d.predictor ?? null
  return {
    ...game,
    boxscore: (d.boxscore?.teams ?? []).map((t: any) => ({
      team: normTeam(t.team),
      stats: (t.statistics ?? []).map((s: any) => ({ name: s.name, label: s.label ?? s.displayName ?? s.name, value: String(s.displayValue ?? '') })),
    })),
    leaders: (d.leaders ?? []).map((t: any) => ({
      team: normTeam(t.team),
      categories: (t.leaders ?? []).map((cat: any) => {
        const top = cat.leaders?.[0]
        return {
          name: cat.name,
          label: cat.displayName ?? cat.name,
          athlete: str(top?.athlete?.displayName),
          position: str(top?.athlete?.position?.abbreviation),
          headshot: str(top?.athlete?.headshot?.href),
          value: str(top?.displayValue),
        }
      }),
    })),
    injuries: (d.injuries ?? []).map((t: any) => ({
      team: normTeam(t.team),
      players: (t.injuries ?? []).map((i: any) => ({
        name: i.athlete?.displayName ?? 'Unknown',
        position: str(i.athlete?.position?.abbreviation),
        status: str(i.status),
        detail: str(i.details?.detail ?? i.details?.type ?? i.type?.description),
      })),
    })),
    winProbability: wp
      ? { home: num(wp.homeTeam?.gameProjection), away: num(wp.awayTeam?.gameProjection) }
      : null,
    seasonSeries: str(d.seasonseries?.[0]?.summary),
    headline: str(d.article?.headline ?? d.news?.articles?.[0]?.headline),
  }
}

export async function fetchTeams(league: LeagueId): Promise<TeamRef[]> {
  const l = lg(league)
  const q = l.groups ? `?groups=${l.groups}&limit=1000` : '?limit=1000'
  const d = await getJson(`${base(l)}/teams${q}`)
  return (d.sports?.[0]?.leagues?.[0]?.teams ?? []).map((t: any) => normTeam(t.team))
}

export async function fetchTeam(league: LeagueId, teamId: string): Promise<TeamDetail> {
  const l = lg(league)
  const d = await getJson(`${base(l)}/teams/${encodeURIComponent(teamId)}`)
  const t = d.team ?? {}
  return {
    ...normTeam(t),
    league,
    record: (t.record?.items ?? []).map((i: any) => ({ type: i.type, summary: i.summary })),
    standingSummary: str(t.standingSummary),
    nextGame: t.nextEvent?.[0] ? normGame(t.nextEvent[0], league) : null,
  }
}

export async function fetchTeamSchedule(league: LeagueId, teamId: string, season?: string): Promise<Game[]> {
  const l = lg(league)
  const d = await getJson(`${base(l)}/teams/${encodeURIComponent(teamId)}/schedule${season ? `?season=${encodeURIComponent(season)}` : ''}`)
  return (d.events ?? []).map((e: any) => normGame(e, league))
}

export async function fetchTeamStats(league: LeagueId, teamId: string): Promise<TeamStats> {
  const l = lg(league)
  const d = await getJson(`${base(l)}/teams/${encodeURIComponent(teamId)}/statistics`)
  const cats = d.results?.stats?.categories ?? d.splits?.categories ?? []
  return {
    team: normTeam(d.team),
    season: str(d.season?.displayName ?? d.requestedSeason?.displayName),
    categories: cats.map((c: any) => ({
      name: c.name,
      label: c.displayName ?? c.name,
      stats: (c.stats ?? []).map((s: any) => ({
        name: s.name,
        label: s.displayName ?? s.name,
        abbreviation: str(s.abbreviation),
        value: num(s.value),
        displayValue: str(s.displayValue),
        rank: str(s.rankDisplayValue),
      })),
    })),
  }
}

export async function fetchStandings(league: LeagueId, season?: string): Promise<Standings> {
  const l = lg(league)
  const d = await getJson(`${WEB}/${l.sport}/${l.espn}/standings${season ? `?season=${encodeURIComponent(season)}` : ''}`)
  const groups: Standings['groups'] = []
  const walk = (node: any) => {
    if (node?.standings?.entries?.length) {
      groups.push({
        name: node.name ?? node.abbreviation ?? 'Standings',
        entries: node.standings.entries.map((e: any) => ({
          team: normTeam(e.team),
          stats: Object.fromEntries((e.stats ?? []).map((s: any) => [s.name ?? s.type, String(s.displayValue ?? s.value ?? '')])),
        })),
      })
    }
    for (const ch of node?.children ?? []) walk(ch)
  }
  walk(d)
  return { league, season: str(d.seasons?.[0]?.displayName ?? d.season?.displayName), groups }
}
