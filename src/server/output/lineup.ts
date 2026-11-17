import { getMeta } from '../db'

export type EventStatus = 'scheduled' | 'live' | 'ended' | 'cancelled'

export function eventStatus(
  e: { starts_at: number | null; ends_at: number | null; status_override: string | null },
  now = Date.now(),
): EventStatus {
  if (e.status_override) return e.status_override as EventStatus
  if (e.starts_at == null) return 'scheduled'
  const end = e.ends_at ?? e.starts_at + 3 * 3600_000
  if (now < e.starts_at) return 'scheduled'
  if (now < end) return 'live'
  return 'ended'
}

export function baseUrl(env: Env, req: Request) {
  return (env.PUBLIC_URL as string) || new URL(req.url).origin
}

export type OutputChannel = {
  id: string
  number: number | null
  name: string
  tvgId: string
  logo: string | null
  category: string | null
  categoryId: string | null
  kind: 'linear' | 'event'
  epgSourceId: string | null
  epgChannelId: string | null
  streamExt: 'ts' | 'm3u8'
}

export type OutputEvent = {
  id: string
  title: string
  subtitle: string | null
  description: string | null
  sport: string | null
  league: string | null
  image: string | null
  startsAt: number | null
  endsAt: number | null
  status: EventStatus
  origin: string
  channels: { id: string; label: string | null; name: string; number: number | null; tvgId: string }[]
}

/** Events for outputs (not hidden), optionally filtered by status / window. */
export async function loadEvents(
  env: Env,
  opts: { statuses?: EventStatus[]; hoursAhead?: number; includeEnded?: boolean } = {},
): Promise<OutputEvent[]> {
  const now = Date.now()
  const { results } = await env.DB.prepare(
    `SELECT e.*, (
       SELECT json_group_array(json_object('id', lc.id, 'label', ec.label, 'name', lc.name, 'number', lc.number,
                                           'tvgId', COALESCE(lc.tvg_id, lc.id), 'priority', ec.priority))
       FROM event_channels ec JOIN lineup_channels lc ON lc.id = ec.lineup_channel_id
       WHERE ec.event_id = e.id AND lc.enabled = 1) AS channels
     FROM events e WHERE e.hidden = 0
     ORDER BY e.starts_at IS NULL, e.starts_at, e.title`,
  ).all<Record<string, any>>()

  const ahead = opts.hoursAhead != null ? now + opts.hoursAhead * 3600_000 : Infinity
  return results
    .map((e) => {
      const chans = (JSON.parse(e.channels || '[]') as any[]).sort((a, b) => a.priority - b.priority)
      return {
        id: e.id,
        title: e.title,
        subtitle: e.subtitle,
        description: e.description,
        sport: e.sport,
        league: e.league,
        image: e.image,
        startsAt: e.starts_at,
        endsAt: e.ends_at,
        status: eventStatus(e as any, now),
        origin: e.origin,
        channels: chans.map(({ priority: _p, ...c }) => c),
      } satisfies OutputEvent
    })
    .filter((e) => (opts.statuses ? opts.statuses.includes(e.status) : opts.includeEnded || e.status !== 'ended'))
    .filter((e) => e.startsAt == null || e.startsAt <= ahead)
}

/** Visible lineup in output order. Idle event channels are dropped. */
export async function loadOutputChannels(env: Env): Promise<OutputChannel[]> {
  const { results } = await env.DB.prepare(
    `SELECT lc.*, c.name AS category_name,
       (SELECT s.stream_format FROM lineup_streams ls
          JOIN source_channels sc ON sc.id = ls.source_channel_id
          JOIN sources s ON s.id = sc.source_id
        WHERE ls.lineup_channel_id = lc.id ORDER BY ls.priority LIMIT 1) AS stream_format
     FROM lineup_channels lc LEFT JOIN categories c ON c.id = lc.category_id
     WHERE lc.enabled = 1 AND COALESCE(c.hidden, 0) = 0
       AND EXISTS (SELECT 1 FROM lineup_streams ls WHERE ls.lineup_channel_id = lc.id)
     ORDER BY COALESCE(c.sort_order, 1000000), lc.number IS NULL, lc.number, lc.sort_order, lc.name`,
  ).all<Record<string, any>>()

  let active: Set<string> | null = null
  if (results.some((r) => r.hide_when_idle)) {
    const evs = await loadEvents(env, { hoursAhead: 24 })
    active = new Set(evs.flatMap((e) => e.channels.map((c) => c.id)))
  }

  return results
    .filter((r) => !r.hide_when_idle || active?.has(r.id))
    .map((r) => ({
      id: r.id,
      number: r.number,
      name: r.name,
      tvgId: r.tvg_id || r.id,
      logo: r.logo,
      category: r.category_name ?? null,
      categoryId: r.category_id,
      kind: r.kind,
      epgSourceId: r.epg_source_id,
      epgChannelId: r.epg_channel_id,
      streamExt: r.stream_format === 'm3u8' ? 'm3u8' : 'ts',
    }))
}

export async function outputVersion(env: Env) {
  const [a, b, c] = await Promise.all([
    getMeta(env, 'epg_version'),
    getMeta(env, 'lineup_version'),
    getMeta(env, 'events_version'),
  ])
  return `${a ?? 0}-${b ?? 0}-${c ?? 0}`
}

export function streamUrl(base: string, ch: { id: string; streamExt: string }, token: string | null) {
  return `${base}/stream/${ch.id}.${ch.streamExt}${token ? `?token=${encodeURIComponent(token)}` : ''}`
}

export function formatEventTime(ms: number | null, tz: string) {
  if (ms == null) return ''
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(ms)
  } catch {
    return new Date(ms).toISOString()
  }
}
