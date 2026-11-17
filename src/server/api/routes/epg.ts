import { z } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import { schema } from '../../db'
import { newId } from '../../lib/ids'
import { enqueueJob } from '../../jobs'
import { HttpError, IdParam, db, newRouter, notFound, route, valid } from '../hono'
import { EpgChannel, EpgSource, EpgSourceInput, Job, OkSchema, PageQuery, Programme, paginated } from '../schemas'

const T = ['EPG']
const app = newRouter()


const ser = (r: typeof schema.epgSources.$inferSelect): z.infer<typeof EpgSource> => ({ ...r, type: r.type as 'xmltv' | 'xtream' })

app.openapi(
  route({ method: 'get', path: '/epg-sources', tags: T, summary: 'List EPG sources', response: z.array(EpgSource) }),
  async (c) => c.json((await db(c).select().from(schema.epgSources).orderBy(schema.epgSources.priority)).map(ser)),
)

app.openapi(
  route({
    method: 'post',
    path: '/epg-sources',
    tags: T,
    summary: 'Add an external XMLTV source',
    body: EpgSourceInput.extend({ syncNow: z.boolean().optional() }),
    response: z.object({ epgSource: EpgSource, job: Job.nullable() }),
    status: 201,
  }),
  async (c) => {
    const b = valid(c, 'json') as z.infer<typeof EpgSourceInput> & { syncNow?: boolean }
    const type = b.type ?? 'xmltv'
    if (type === 'xmltv' && !b.url) throw new HttpError(400, 'url is required for xmltv sources')
    if (type === 'xtream' && !b.sourceId) throw new HttpError(400, 'sourceId is required for xtream EPG sources')
    const now = Date.now()
    const id = newId('epg')
    await db(c).insert(schema.epgSources).values({
      id, name: b.name, type, url: b.url ?? null, sourceId: b.sourceId ?? null,
      enabled: b.enabled ?? true, priority: b.priority ?? 100, createdAt: now, updatedAt: now,
    })
    const job = b.syncNow === false ? null : await enqueueJob(c.env, 'epg_refresh', id)
    const row = await db(c).query.epgSources.findFirst({ where: eq(schema.epgSources.id, id) })
    return c.json({ epgSource: ser(row!), job } as any, 201)
  },
)

app.openapi(
  route({ method: 'patch', path: '/epg-sources/{id}', tags: T, summary: 'Update an EPG source', params: IdParam, body: EpgSourceInput.partial(), response: EpgSource }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    const b = valid(c, 'json') as Partial<z.infer<typeof EpgSourceInput>>
    const [row] = await db(c).update(schema.epgSources).set({ ...b, updatedAt: Date.now() }).where(eq(schema.epgSources.id, id)).returning()
    if (!row) throw notFound('epg source')
    return c.json(ser(row))
  },
)

app.openapi(
  route({ method: 'delete', path: '/epg-sources/{id}', tags: T, summary: 'Delete an EPG source (unmaps channels using it)', params: IdParam, response: OkSchema }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE lineup_channels SET epg_source_id = NULL, epg_channel_id = NULL WHERE epg_source_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM programmes WHERE epg_source_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM epg_channels WHERE epg_source_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM epg_sources WHERE id = ?').bind(id),
    ])
    return c.json({ ok: true })
  },
)

app.openapi(
  route({ method: 'post', path: '/epg-sources/{id}/refresh', tags: T, summary: 'Queue a refresh of one EPG source (background job)', params: IdParam, response: Job, status: 202 as any }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    const exists = await db(c).query.epgSources.findFirst({ where: eq(schema.epgSources.id, id) })
    if (!exists) throw notFound('epg source')
    return c.json((await enqueueJob(c.env, 'epg_refresh', id)) as any, 202)
  },
)

app.openapi(
  route({
    method: 'post',
    path: '/epg/refresh',
    tags: T,
    summary: 'Queue a refresh of all EPG sources, then an event-rule run (background job)',
    description: 'Programmes are only stored for EPG channels mapped into the lineup, so run this after changing EPG mappings. Poll GET /api/jobs/{id}.',
    response: Job,
    status: 202 as any,
  }),
  async (c) => c.json((await enqueueJob(c.env, 'epg_refresh')) as any, 202),
)

const ChQuery = z.object({
  q: z.string().optional().openapi({ description: 'Substring of xmltv id or display name' }),
  epgSourceId: z.string().optional(),
  ...PageQuery,
})

app.openapi(
  route({ method: 'get', path: '/epg/channels', tags: T, summary: 'Search EPG channels (for mapping)', query: ChQuery, response: paginated(EpgChannel, 'EpgChannelPage') }),
  async (c) => {
    const q = valid(c, 'query') as z.infer<typeof ChQuery>
    const limit = q.limit ?? 100
    const offset = q.offset ?? 0
    const where: string[] = []
    const args: unknown[] = []
    if (q.q) {
      where.push('(display_name LIKE ? OR xmltv_id LIKE ?)')
      args.push(`%${q.q}%`, `%${q.q}%`)
    }
    if (q.epgSourceId) {
      where.push('epg_source_id = ?')
      args.push(q.epgSourceId)
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const [{ results }, total] = await Promise.all([
      c.env.DB.prepare(
        `SELECT epg_source_id AS epgSourceId, xmltv_id AS xmltvId, display_name AS displayName, icon FROM epg_channels ${w}
         ORDER BY display_name LIMIT ? OFFSET ?`,
      )
        .bind(...args, limit, offset)
        .all(),
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM epg_channels ${w}`).bind(...args).first<{ n: number }>(),
    ])
    return c.json({ items: results as any, total: total?.n ?? 0, limit, offset })
  },
)

const ProgQuery = z.object({
  lineupChannelId: z.string().optional(),
  epgSourceId: z.string().optional(),
  xmltvId: z.string().optional(),
  q: z.string().optional().openapi({ description: 'Substring of title' }),
  from: z.coerce.number().optional().openapi({ description: 'Epoch ms, default now' }),
  to: z.coerce.number().optional().openapi({ description: 'Epoch ms, default now + 24h' }),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
})

app.openapi(
  route({
    method: 'get',
    path: '/epg/programmes',
    tags: T,
    summary: 'Query stored programmes (mapped channels only)',
    query: ProgQuery,
    response: z.array(Programme.extend({ lineupChannelIds: z.array(z.string()) })),
  }),
  async (c) => {
    const q = valid(c, 'query') as z.infer<typeof ProgQuery>
    const where = ['p.stop > ?', 'p.start < ?']
    const args: unknown[] = [q.from ?? Date.now(), q.to ?? Date.now() + 86400_000]
    if (q.lineupChannelId) {
      where.push('lc.id = ?')
      args.push(q.lineupChannelId)
    }
    if (q.epgSourceId) {
      where.push('p.epg_source_id = ?')
      args.push(q.epgSourceId)
    }
    if (q.xmltvId) {
      where.push('p.xmltv_id = ?')
      args.push(q.xmltvId)
    }
    if (q.q) {
      where.push('p.title LIKE ?')
      args.push(`%${q.q}%`)
    }
    const { results } = await c.env.DB.prepare(
      `SELECT p.epg_source_id AS epgSourceId, p.xmltv_id AS xmltvId, p.start, p.stop, p.title, p.subtitle,
              p.description, p.category, p.icon, p.episode, group_concat(lc.id) AS ids
       FROM programmes p
       ${q.lineupChannelId ? '' : 'LEFT '}JOIN lineup_channels lc ON lc.epg_source_id = p.epg_source_id AND lc.epg_channel_id = p.xmltv_id
       WHERE ${where.join(' AND ')}
       GROUP BY p.epg_source_id, p.xmltv_id, p.start ORDER BY p.start LIMIT ?`,
    )
      .bind(...args, q.limit ?? 500)
      .all<Record<string, any>>()
    return c.json(results.map(({ ids, ...p }) => ({ ...p, lineupChannelIds: ids ? String(ids).split(',') : [] })) as any)
  },
)

export default app
