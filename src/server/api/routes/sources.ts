import { z } from '@hono/zod-openapi'
import { eq, sql } from 'drizzle-orm'
import { schema } from '../../db'
import { newId } from '../../lib/ids'
import { XtreamClient, normalizeBaseUrl } from '../../lib/xtream'
import { syncAllSources, syncSource } from '../../sync/sources'
import { HttpError, IdParam, db, newRouter, notFound, route, valid } from '../hono'
import { OkSchema, Source, SourceInput, SourcePatch } from '../schemas'

const T = ['Sources']
const SyncResult = z.object({
  sourceId: z.string(),
  ok: z.boolean(),
  channels: z.number().optional(),
  removed: z.number().optional(),
  error: z.string().optional(),
})

const app = newRouter()

function serialize(row: typeof schema.sources.$inferSelect, channelCount?: number): z.infer<typeof Source> {
  const { password: _pw, ...rest } = row
  return { ...rest, streamFormat: rest.streamFormat as 'ts' | 'm3u8', accountInfo: rest.accountInfo ?? null, channelCount }
}

async function counts(env: Env) {
  const { results } = await env.DB.prepare(
    'SELECT source_id, COUNT(*) AS n FROM source_channels WHERE removed_at IS NULL GROUP BY source_id',
  ).all<{ source_id: string; n: number }>()
  return new Map(results.map((r) => [r.source_id, r.n]))
}

app.openapi(
  route({ method: 'get', path: '/sources', tags: T, summary: 'List Xtream sources', response: z.array(Source) }),
  async (c) => {
    const rows = await db(c).select().from(schema.sources).orderBy(schema.sources.priority, schema.sources.name)
    const n = await counts(c.env)
    return c.json(rows.map((r) => serialize(r, n.get(r.id) ?? 0)))
  },
)

app.openapi(
  route({ method: 'get', path: '/sources/{id}', tags: T, summary: 'Get a source', params: IdParam, response: Source }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    const row = await db(c).query.sources.findFirst({ where: eq(schema.sources.id, id) })
    if (!row) throw notFound('source')
    const n = await counts(c.env)
    return c.json(serialize(row, n.get(id) ?? 0))
  },
)

app.openapi(
  route({
    method: 'post',
    path: '/sources/test',
    tags: T,
    summary: 'Test Xtream credentials without saving',
    body: SourceInput.pick({ baseUrl: true, username: true, password: true, userAgent: true }),
    response: z.object({ ok: z.boolean(), account: z.unknown().optional(), error: z.string().optional() }),
  }),
  async (c) => {
    const b = valid(c, 'json') as z.infer<typeof SourceInput>
    try {
      const account = await new XtreamClient(b).account()
      return c.json({ ok: true, account: account.user_info })
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  },
)

app.openapi(
  route({
    method: 'post',
    path: '/sources',
    tags: T,
    summary: 'Add an Xtream source',
    description: 'Validates credentials, optionally registers its EPG and runs an initial sync.',
    body: SourceInput,
    response: z.object({ source: Source, sync: SyncResult.nullable() }),
    status: 201,
  }),
  async (c) => {
    const b = valid(c, 'json') as z.infer<typeof SourceInput>
    const baseUrl = normalizeBaseUrl(b.baseUrl)
    try {
      await new XtreamClient({ ...b, baseUrl }).account()
    } catch (e) {
      throw new HttpError(422, `Could not authenticate: ${e instanceof Error ? e.message : e}`)
    }
    const id = newId('src')
    const now = Date.now()
    await db(c).insert(schema.sources).values({
      id,
      name: b.name,
      baseUrl,
      username: b.username,
      password: b.password,
      streamFormat: b.streamFormat ?? 'ts',
      userAgent: b.userAgent ?? null,
      enabled: b.enabled ?? true,
      priority: b.priority ?? 100,
      createdAt: now,
      updatedAt: now,
    })
    if (b.createEpgSource !== false) {
      await db(c).insert(schema.epgSources).values({
        id: newId('epg'),
        name: `${b.name} (provider EPG)`,
        type: 'xtream',
        sourceId: id,
        createdAt: now,
        updatedAt: now,
      })
    }
    const sync = b.syncNow === false ? null : await syncSource(c.env, id)
    const row = await db(c).query.sources.findFirst({ where: eq(schema.sources.id, id) })
    return c.json({ source: serialize(row!, sync?.channels), sync }, 201)
  },
)

app.openapi(
  route({ method: 'patch', path: '/sources/{id}', tags: T, summary: 'Update a source', params: IdParam, body: SourcePatch, response: Source }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    const b = valid(c, 'json') as z.infer<typeof SourcePatch>
    const patch: Partial<typeof schema.sources.$inferInsert> = { ...b, updatedAt: Date.now() }
    if (b.baseUrl) patch.baseUrl = normalizeBaseUrl(b.baseUrl)
    const [row] = await db(c).update(schema.sources).set(patch).where(eq(schema.sources.id, id)).returning()
    if (!row) throw notFound('source')
    return c.json(serialize(row))
  },
)

app.openapi(
  route({
    method: 'delete',
    path: '/sources/{id}',
    tags: T,
    summary: 'Delete a source',
    description: 'Removes its channels; lineup channels keep existing but lose those streams.',
    params: IdParam,
    response: OkSchema,
  }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    // D1 enforces FKs; delete children explicitly for clarity
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM lineup_streams WHERE source_channel_id IN (SELECT id FROM source_channels WHERE source_id = ?)').bind(id),
      c.env.DB.prepare('DELETE FROM source_channels WHERE source_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM programmes WHERE epg_source_id IN (SELECT id FROM epg_sources WHERE source_id = ?)').bind(id),
      c.env.DB.prepare('DELETE FROM epg_channels WHERE epg_source_id IN (SELECT id FROM epg_sources WHERE source_id = ?)').bind(id),
      c.env.DB.prepare('UPDATE lineup_channels SET epg_source_id = NULL WHERE epg_source_id IN (SELECT id FROM epg_sources WHERE source_id = ?)').bind(id),
      c.env.DB.prepare('DELETE FROM epg_sources WHERE source_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM sources WHERE id = ?').bind(id),
    ])
    return c.json({ ok: true })
  },
)

app.openapi(
  route({ method: 'post', path: '/sources/{id}/sync', tags: T, summary: 'Sync channels from a source now', params: IdParam, response: SyncResult }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    return c.json(await syncSource(c.env, id))
  },
)

app.openapi(
  route({ method: 'post', path: '/sources/sync', tags: T, summary: 'Sync all enabled sources', response: z.array(SyncResult) }),
  async (c) => c.json(await syncAllSources(c.env)),
)

app.openapi(
  route({
    method: 'get',
    path: '/sources/{id}/categories',
    tags: T,
    summary: "List a source's upstream categories with channel counts",
    params: IdParam,
    response: z.array(z.object({ categoryName: z.string().nullable(), count: z.number() })),
  }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    const rows = await db(c)
      .select({ categoryName: schema.sourceChannels.categoryName, count: sql<number>`count(*)` })
      .from(schema.sourceChannels)
      .where(sql`${schema.sourceChannels.sourceId} = ${id} AND ${schema.sourceChannels.removedAt} IS NULL`)
      .groupBy(schema.sourceChannels.categoryName)
      .orderBy(schema.sourceChannels.categoryName)
    return c.json(rows)
  },
)

export default app
