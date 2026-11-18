import { z } from '@hono/zod-openapi'
import { baseUrl, loadEvents, loadOutputChannels, streamUrl, type EventStatus } from '../../output/lineup'
import { gamesForEvents } from '../../sports/match'
import { newRouter, route, valid } from '../hono'
import { GameSchema } from './sports'
import { EventStatus as EventStatusSchema } from '../schemas'

const T = ['Output']
const app = newRouter()

const tokenOf = (c: { req: { query: (k: string) => string | undefined } }) => c.req.query('token') ?? null

const OutChannel = z
  .object({
    id: z.string(),
    number: z.number().nullable(),
    name: z.string(),
    tvgId: z.string(),
    logo: z.string().nullable(),
    category: z.string().nullable(),
    kind: z.enum(['linear', 'event']),
    streamUrl: z.string(),
    hasEpg: z.boolean(),
  })
  .openapi('OutputChannel')

const OutEvent = z
  .object({
    id: z.string(),
    title: z.string(),
    subtitle: z.string().nullable(),
    description: z.string().nullable(),
    sport: z.string().nullable(),
    league: z.string().nullable(),
    image: z.string().nullable(),
    startsAt: z.number().nullable(),
    endsAt: z.number().nullable(),
    startsAtIso: z.string().nullable(),
    endsAtIso: z.string().nullable(),
    status: EventStatusSchema,
    game: GameSchema.nullable().openapi({
      description: 'Live metadata for the linked real-world game (teams, logos, records, score, clock, broadcasts, odds). null if not a linked game.',
    }),
    channels: z.array(z.object({ id: z.string(), name: z.string(), number: z.number().nullable(), tvgId: z.string(), label: z.string().nullable(), streamUrl: z.string() })),
  })
  .openapi('OutputEvent')

app.openapi(
  route({
    method: 'get',
    path: '/output/lineup.json',
    tags: T,
    summary: 'The cleaned-up lineup for downstream apps',
    description: 'Accepts an output-scope token via ?token=. Stream URLs embed the same token.',
    query: z.object({
      token: z.string().optional(),
      events: z.enum(['true', 'false']).optional(),
      games: z.enum(['true', 'false']).optional().openapi({ description: 'Attach live game metadata to events (default true)' }),
    }),
    response: z.object({
      generatedAt: z.string(),
      epgUrl: z.string(),
      m3uUrl: z.string(),
      categories: z.array(z.object({ name: z.string(), channels: z.array(OutChannel) })),
      events: z.array(OutEvent).optional(),
    }),
  }),
  async (c) => {
    const base = baseUrl(c.env, c.req.raw)
    const token = tokenOf(c)
    const tq = token ? `?token=${encodeURIComponent(token)}` : ''
    const channels = await loadOutputChannels(c.env)
    const groups = new Map<string, z.infer<typeof OutChannel>[]>()
    for (const ch of channels) {
      const g = ch.category ?? 'Uncategorized'
      groups.set(g, [
        ...(groups.get(g) ?? []),
        { id: ch.id, number: ch.number, name: ch.name, tvgId: ch.tvgId, logo: ch.logo, category: ch.category, kind: ch.kind, streamUrl: streamUrl(base, ch, token), hasEpg: !!ch.epgChannelId },
      ])
    }
    const body: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      epgUrl: `${base}/epg.xml${tq}`,
      m3uUrl: `${base}/playlist.m3u${tq}`,
      categories: [...groups].map(([name, chs]) => ({ name, channels: chs })),
    }
    if (c.req.query('events') !== 'false') body.events = await outputEvents(c.env, base, token, channels, { games: c.req.query('games') !== 'false' })
    return c.json(body as any)
  },
)

async function outputEvents(
  env: Env,
  base: string,
  token: string | null,
  channels: Awaited<ReturnType<typeof loadOutputChannels>>,
  opts: { statuses?: EventStatus[]; hoursAhead?: number; sport?: string; games?: boolean },
) {
  const byId = new Map(channels.map((c) => [c.id, c]))
  const evs = (await loadEvents(env, { statuses: opts.statuses, hoursAhead: opts.hoursAhead })).filter(
    (e) => !opts.sport || e.sport?.toLowerCase() === opts.sport.toLowerCase(),
  )
  const games = opts.games === false ? new Map() : await gamesForEvents(env, evs)
  return evs
    .map((e) => ({
      id: e.id,
      title: e.title,
      subtitle: e.subtitle,
      description: e.description,
      sport: e.sport,
      league: e.league,
      image: e.image,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      startsAtIso: e.startsAt ? new Date(e.startsAt).toISOString() : null,
      endsAtIso: e.endsAt ? new Date(e.endsAt).toISOString() : null,
      status: e.status,
      game: games.get(e.id) ?? null,
      channels: e.channels
        .filter((ch) => byId.has(ch.id))
        .map((ch) => ({ ...ch, streamUrl: streamUrl(base, byId.get(ch.id)!, token) })),
    }))
}

const EvQuery = z.object({
  token: z.string().optional(),
  status: z.string().optional().openapi({ description: 'Comma list (scheduled,live,ended,cancelled). Default scheduled,live' }),
  hours: z.coerce.number().optional().openapi({ description: 'Only events starting within N hours (default 48)' }),
  sport: z.string().optional(),
  withChannels: z.enum(['true', 'false']).optional().openapi({ description: 'Only events that have a playable channel (default true)' }),
  games: z.enum(['true', 'false']).optional().openapi({ description: 'Attach live game metadata (default true)' }),
})

app.openapi(
  route({ method: 'get', path: '/output/events.json', tags: T, summary: 'Live and upcoming events with playable channels', query: EvQuery, response: z.array(OutEvent) }),
  async (c) => {
    const q = valid(c, 'query') as z.infer<typeof EvQuery>
    const base = baseUrl(c.env, c.req.raw)
    const channels = await loadOutputChannels(c.env)
    const statuses = (q.status ?? 'scheduled,live').split(',') as EventStatus[]
    let evs = await outputEvents(c.env, base, tokenOf(c), channels, { statuses, hoursAhead: q.hours ?? 48, sport: q.sport, games: q.games !== 'false' })
    if (q.withChannels !== 'false') evs = evs.filter((e) => e.channels.length)
    return c.json(evs as any)
  },
)

export default app
