import { describe, expect, it } from 'vitest'
import type { Game, TeamRef } from '../src/server/sports/espn'
import { bestGame, eventLeague } from '../src/server/sports/match'
import { leagueFromText } from '../src/server/sports/leagues'

const team = (id: string, location: string, name: string, abbreviation: string): TeamRef => ({
  id, location, name, abbreviation, displayName: `${location} ${name}`, shortName: name, logo: null, color: null, altColor: null,
})
const T0 = Date.UTC(2026, 10, 22, 18, 0)
const game = (id: string, home: TeamRef, away: TeamRef, startsAt = T0): Game => ({
  id, league: 'ncaam', name: `${away.displayName} at ${home.displayName}`, shortName: null, startsAt,
  status: { state: 'pre', completed: false, detail: null, shortDetail: null, clock: null, period: null },
  home: { team: home, homeAway: 'home', score: null, record: null, rank: null, winner: null },
  away: { team: away, homeAway: 'away', score: null, record: null, rank: null, winner: null },
  venue: null, neutralSite: false, conferenceGame: false, broadcasts: [], odds: null, notes: [], link: null,
})

const MICH = team('1', 'Michigan', 'Wolverines', 'MICH')
const MSU = team('2', 'Michigan State', 'Spartans', 'MSU')
const IND = team('3', 'Indiana', 'Hoosiers', 'IU')
const OSU = team('4', 'Ohio State', 'Buckeyes', 'OSU')
const games = [game('g1', IND, MSU), game('g2', OSU, MICH)]

describe('event → game matching', () => {
  it('prefers the more specific team name', () => {
    expect(bestGame(games, 'NCAAB: Michigan State at Indiana', T0)?.game.id).toBe('g1')
    expect(bestGame(games, 'Michigan vs Ohio State', T0 + 20 * 60_000)?.game.id).toBe('g2')
  })
  it('matches abbreviations and nicknames', () => {
    expect(bestGame(games, 'MSU @ IU', T0)?.game.id).toBe('g1')
    expect(bestGame(games, 'Wolverines vs Buckeyes', T0)?.game.id).toBe('g2')
  })
  it('rejects games far from the event time', () => {
    expect(bestGame(games, 'Michigan State at Indiana', T0 + 6 * 3600_000)).toBeNull()
  })
  it('needs both teams unless the time lines up closely', () => {
    expect(bestGame(games, 'Indiana Basketball', T0 + 2 * 3600_000)).toBeNull()
    expect(bestGame(games, 'Indiana Basketball', T0 + 10 * 60_000)?.game.id).toBe('g1')
  })
  it('maps league text and title prefixes', () => {
    expect(leagueFromText('College Football')?.id).toBe('ncaaf')
    expect(leagueFromText('NCAAB')?.id).toBe('ncaam')
    expect(eventLeague({ league: null, title: 'NFL: Bears at Packers' })).toBe('nfl')
    expect(eventLeague({ league: 'UFC', title: 'UFC 310' })).toBeNull()
  })
})
