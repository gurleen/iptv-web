/** Leagues we provide game metadata for, and how event "league" text maps onto them. */
export type LeagueId = 'nfl' | 'nba' | 'nhl' | 'ncaaf' | 'ncaam' | 'ncaaw'

export type League = {
  id: LeagueId
  name: string
  sport: 'football' | 'basketball' | 'hockey'
  /** ESPN path segment: sports/{sport}/{espn} */
  espn: string
  /** ESPN scoreboard "groups" for complete college slates (otherwise ESPN returns only featured games) */
  groups?: string
  aliases: string[]
}

export const LEAGUES: League[] = [
  { id: 'nfl', name: 'NFL', sport: 'football', espn: 'nfl', aliases: ['nfl', 'national football league'] },
  { id: 'nba', name: 'NBA', sport: 'basketball', espn: 'nba', aliases: ['nba', 'national basketball association'] },
  { id: 'nhl', name: 'NHL', sport: 'hockey', espn: 'nhl', aliases: ['nhl', 'national hockey league'] },
  {
    id: 'ncaaf', name: 'NCAA Football', sport: 'football', espn: 'college-football', groups: '80',
    aliases: ['ncaaf', 'ncaa football', 'college football', 'cfb', 'fbs'],
  },
  {
    id: 'ncaam', name: "NCAA Men's Basketball", sport: 'basketball', espn: 'mens-college-basketball', groups: '50',
    aliases: ['ncaam', 'ncaab', 'ncaa basketball', "ncaa men's basketball", 'mens college basketball', "men's college basketball", 'college basketball', 'cbb'],
  },
  {
    id: 'ncaaw', name: "NCAA Women's Basketball", sport: 'basketball', espn: 'womens-college-basketball', groups: '50',
    aliases: ['ncaaw', 'ncaawb', "ncaa women's basketball", 'womens college basketball', "women's college basketball", 'wcbb'],
  },
]

export const LEAGUE_IDS = LEAGUES.map((l) => l.id) as [LeagueId, ...LeagueId[]]

export function getLeague(id: string): League | undefined {
  return LEAGUES.find((l) => l.id === id.toLowerCase())
}

/** Map free-text league names used on events ("NFL", "College Football", "NCAAB") to a league. */
export function leagueFromText(text: string | null | undefined): League | undefined {
  if (!text) return undefined
  const t = text.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim()
  return LEAGUES.find((l) => l.id === t || l.aliases.includes(t))
}
