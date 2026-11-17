import { z } from '@hono/zod-openapi'
import { loadEvents, loadOutputChannels } from '../../output/lineup'
import { epgDays } from '../../sync/epg'
import { newRouter, route, valid } from '../hono'

const T = ['Guide viewer']
const app = newRouter()

const GuideCategory = z.object({ id: z.string().nullable(), name: z.string(), channelCount: z.number() }).openapi('GuideCategory')

const GuideProgramme = z
  .object({
    start: z.number(),
    stop: z.number(),
    title: z.string(),
    subtitle: z.string().nullable(),
    description: z.string().nullable(),
    category: z.string().nullable(),
    icon: z.string().nullable(),
    episode: z.string().nullable(),
    eventId: z.string().nullable().openapi({ description: 'Set when the entry comes from an event rather than the EPG' }),
  })
  .openapi('GuideProgramme')

const GuideChannel = z
  .object({
    id: z.string(),
    number: z.number().nullable(),
    name: z.string(),
    logo: z.string().nullable(),
    kind: z.enum(['linear', 'event']),
    hasEpg: z.boolean(),
    programmes: z.array(GuideProgramme),
  })
  .openapi('GuideChannel')

app.openapi(
  route({
    method: 'get',
    path: '/viewer/categories',
    tags: T,
    summary: 'Output categories (as players see them) with channel counts',
    response: z.object({ categories: z.array(GuideCategory), epgDays: z.number() }),
  }),
  async (c) => {
    const channels = await loadOutputChannels(c.env)
    const cats = new Map<string, { id: string | null; name: string; channelCount: number }>()
    for (const ch of channels) {
      const key = ch.categoryId ?? '__none'
      const cur = cats.get(key) ?? { id: ch.categoryId, name: ch.category ?? 'Uncategorized', channelCount: 0 }
      cur.channelCount++
      cats.set(key, cur)
    }
    return c.json({ categories: [...cats.values()], epgDays: epgDays(c.env) })
  },
)

const GuideQuery = z.object({
  categoryId: z.string().optional().openapi({ description: "Category id, 'none' for uncategorized; omit for all channels" }),
  from: z.coerce.number().optional().openapi({ description: 'Epoch ms (default: now - 1h)' }),
  to: z.coerce.number().optional().openapi({ description: 'Epoch ms (default: from + 24h, max 48h window)' }),
})

app.openapi(
  route({
    method: 'get',
    path: '/viewer/guide',
    tags: T,
    summary: 'Guide grid for one output category: channels in output order with their programmes',
    description: 'Channels without an EPG mapping get entries generated from their linked events (same as the XMLTV output).',
    query: GuideQuery,
    response: z.object({ from: z.number(), to: z.number(), channels: z.array(GuideChannel) }),
  }),
  async (c) => {
    const q = valid(c, 'query') as z.infer<typeof GuideQuery>
    const from = q.from ?? Date.now() - 3600_000
    const to = Math.min(q.to ?? from + 86400_000, from + 2 * 86400_000)

    const all = await loadOutputChannels(c.env)
    const channels = all.filter((ch) => !q.categoryId || (q.categoryId === 'none' ? !ch.categoryId : ch.categoryId === q.categoryId))

    // programmes for mapped channels, batched by EPG key
    const keyOf = (s: string, x: string) => `${s}\u0000${x}`
    const byKey = new Map<string, z.infer<typeof GuideProgramme>[]>()
    const keys = [...new Set(channels.filter((ch) => ch.epgSourceId && ch.epgChannelId).map((ch) => keyOf(ch.epgSourceId!, ch.epgChannelId!)))]
    for (let i = 0; i < keys.length; i += 50) {
      const batch = keys.slice(i, i + 50).map((k) => k.split('\u0000'))
      const { results } = await c.env.DB.prepare(
        `SELECT p.epg_source_id, p.xmltv_id, p.start, p.stop, p.title, p.subtitle, p.description, p.category, p.icon, p.episode
         FROM programmes p JOIN json_each(?1) j ON p.epg_source_id = j.value ->> '$[0]' AND p.xmltv_id = j.value ->> '$[1]'
         WHERE p.stop > ?2 AND p.start < ?3 ORDER BY p.start`,
      )
        .bind(JSON.stringify(batch), from, to)
        .all<Record<string, any>>()
      for (const p of results) {
        const k = keyOf(p.epg_source_id, p.xmltv_id)
        const list = byKey.get(k) ?? []
        list.push({
          start: p.start, stop: p.stop, title: p.title, subtitle: p.subtitle, description: p.description,
          category: p.category, icon: p.icon, episode: p.episode, eventId: null,
        })
        byKey.set(k, list)
      }
    }

    // events for channels that have no EPG of their own
    const eventsByChannel = new Map<string, z.infer<typeof GuideProgramme>[]>()
    if (channels.some((ch) => !ch.epgChannelId)) {
      for (const e of await loadEvents(c.env, { includeEnded: true })) {
        if (e.startsAt == null) continue
        const stop = e.endsAt ?? e.startsAt + 3 * 3600_000
        if (stop <= from || e.startsAt >= to) continue
        for (const ec of e.channels) {
          const list = eventsByChannel.get(ec.id) ?? []
          list.push({
            start: e.startsAt, stop, title: e.title, subtitle: e.subtitle, description: e.description,
            category: e.sport, icon: e.image, episode: null, eventId: e.id,
          })
          eventsByChannel.set(ec.id, list)
        }
      }
    }

    return c.json({
      from,
      to,
      channels: channels.map((ch) => ({
        id: ch.id,
        number: ch.number,
        name: ch.name,
        logo: ch.logo,
        kind: ch.kind,
        hasEpg: !!ch.epgChannelId,
        programmes: ch.epgSourceId && ch.epgChannelId
          ? (byKey.get(keyOf(ch.epgSourceId, ch.epgChannelId)) ?? [])
          : (eventsByChannel.get(ch.id) ?? []).sort((a, b) => a.start - b.start),
      })),
    })
  },
)

export default app
