import { z } from '@hono/zod-openapi'
import { batchRun } from '../../db'
import { newId } from '../../lib/ids'
import { cleanChannelName, similarity } from '../../lib/names'
import { HttpError, IdParam, newRouter, route, valid } from '../hono'
import {
  CHANNEL_SELECT,
  ensureCategory,
  getChannel,
  getChannels,
  nextNumber,
  patchStatement,
  serializeChannels,
  touchLineup,
} from '../lineup-store'
import { LineupChannel, LineupChannelInput, LineupChannelPatch, OkSchema, PageQuery, Programme, boolQuery, paginated } from '../schemas'

const T = ['Lineup channels']
const app = newRouter()

// any successful mutation invalidates cached outputs
app.use('*', async (c, next) => {
  await next()
  if (c.req.method !== 'GET' && c.res.status < 300) {
    await touchLineup(c.env)
  }
})

const ListQuery = z.object({
  q: z.string().optional().openapi({ description: 'Substring of name' }),
  categoryId: z.string().optional().openapi({ description: "Category id, or 'none' for uncategorized" }),
  kind: z.enum(['linear', 'event']).optional(),
  enabled: boolQuery,
  hasEpg: boolQuery,
  hasStreams: boolQuery,
  brokenStreams: boolQuery.openapi({ description: 'true = channels whose every stream was removed upstream' }),
  tag: z.string().optional(),
  ...PageQuery,
})

app.openapi(
  route({
    method: 'get',
    path: '/lineup/channels',
    tags: T,
    summary: 'List lineup channels (output order)',
    query: ListQuery,
    response: paginated(LineupChannel, 'LineupChannelPage'),
  }),
  async (c) => {
    const q = valid(c, 'query') as z.infer<typeof ListQuery>
    const limit = q.limit ?? 100
    const offset = q.offset ?? 0
    const where: string[] = []
    const args: unknown[] = []
    if (q.q) {
      where.push('lc.name LIKE ?')
      args.push(`%${q.q}%`)
    }
    if (q.categoryId === 'none') where.push('lc.category_id IS NULL')
    else if (q.categoryId) {
      where.push('lc.category_id = ?')
      args.push(q.categoryId)
    }
    if (q.kind) {
      where.push('lc.kind = ?')
      args.push(q.kind)
    }
    if (q.enabled != null) where.push(`lc.enabled = ${q.enabled ? 1 : 0}`)
    if (q.hasEpg != null) where.push(q.hasEpg ? 'lc.epg_channel_id IS NOT NULL' : 'lc.epg_channel_id IS NULL')
    const hasStreams = 'EXISTS (SELECT 1 FROM lineup_streams ls WHERE ls.lineup_channel_id = lc.id)'
    if (q.hasStreams != null) where.push(q.hasStreams ? hasStreams : `NOT ${hasStreams}`)
    if (q.brokenStreams != null) {
      const ok = `EXISTS (SELECT 1 FROM lineup_streams ls JOIN source_channels sc ON sc.id = ls.source_channel_id
                    WHERE ls.lineup_channel_id = lc.id AND sc.removed_at IS NULL)`
      where.push(q.brokenStreams ? `NOT ${ok}` : ok)
    }
    if (q.tag) {
      where.push('EXISTS (SELECT 1 FROM json_each(lc.tags) WHERE value = ?)')
      args.push(q.tag)
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const [{ results }, total] = await Promise.all([
      c.env.DB.prepare(
        `${CHANNEL_SELECT} ${w} ORDER BY COALESCE(c.sort_order, 1000000), lc.number IS NULL, lc.number, lc.sort_order, lc.name LIMIT ? OFFSET ?`,
      )
        .bind(...args, limit, offset)
        .all(),
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM lineup_channels lc ${w}`).bind(...args).first<{ n: number }>(),
    ])
    return c.json({ items: await serializeChannels(c.env, results as any), total: total?.n ?? 0, limit, offset })
  },
)

app.openapi(
  route({ method: 'get', path: '/lineup/channels/{id}', tags: T, summary: 'Get a lineup channel', params: IdParam, response: LineupChannel }),
  async (c) => c.json(await getChannel(c.env, (valid(c, 'param') as { id: string }).id)),
)

async function insertChannel(env: Env, b: z.infer<typeof LineupChannelInput>) {
  const id = newId('ch')
  const now = Date.now()
  const categoryId = b.categoryName ? await ensureCategory(env, b.categoryName) : (b.categoryId ?? null)
  const stmts = [
    env.DB.prepare(
      `INSERT INTO lineup_channels (id, number, name, category_id, logo, tvg_id, epg_source_id, epg_channel_id, kind,
         hide_when_idle, enabled, sort_order, notes, tags, locked, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, b.number === undefined ? await nextNumber(env) : b.number, b.name, categoryId, b.logo ?? null, b.tvgId ?? null,
      b.epgSourceId ?? null, b.epgChannelId ?? null, b.kind ?? 'linear', b.hideWhenIdle ? 1 : 0, b.enabled === false ? 0 : 1,
      b.sortOrder ?? 0, b.notes ?? null, b.tags ? JSON.stringify(b.tags) : null, b.locked ? 1 : 0, now, now,
    ),
    ...(b.streams ?? []).map((sc, i) =>
      env.DB.prepare('INSERT INTO lineup_streams (lineup_channel_id, source_channel_id, priority) VALUES (?, ?, ?)').bind(id, sc, i),
    ),
  ]
  await env.DB.batch(stmts)
  return id
}

app.openapi(
  route({ method: 'post', path: '/lineup/channels', tags: T, summary: 'Create a lineup channel', body: LineupChannelInput, response: LineupChannel, status: 201 }),
  async (c) => {
    const id = await insertChannel(c.env, valid(c, 'json') as z.infer<typeof LineupChannelInput>)
    return c.json(await getChannel(c.env, id), 201)
  },
)

const FromSource = z
  .object({
    sourceChannelIds: z.array(z.string()).min(1).max(5000),
    categoryId: z.string().nullable().optional(),
    categoryName: z.string().optional().openapi({ description: 'Put all new channels in this category (created if missing)' }),
    useSourceCategory: z.boolean().optional().openapi({ description: 'Create/use a category named after each upstream category' }),
    cleanNames: z.boolean().optional().openapi({ description: 'Apply heuristic name cleanup (default true)' }),
    mapEpg: z.boolean().optional().openapi({ description: "Map to the provider EPG using the stream's epg_channel_id (default true)" }),
    startNumber: z.number().optional(),
    kind: z.enum(['linear', 'event']).optional(),
    skipExisting: z.boolean().optional().openapi({ description: 'Skip upstream channels already in the lineup (default true)' }),
  })
  .openapi('AddFromSource')

app.openapi(
  route({
    method: 'post',
    path: '/lineup/channels/from-source',
    tags: T,
    summary: 'Bulk-add upstream channels to the lineup (one lineup channel per upstream channel)',
    body: FromSource,
    response: z.object({ created: z.array(LineupChannel), skipped: z.array(z.string()) }),
    status: 201,
  }),
  async (c) => {
    const b = valid(c, 'json') as z.infer<typeof FromSource>
    const { results: scs } = await c.env.DB.prepare(
      `SELECT sc.*, (SELECT e.id FROM epg_sources e WHERE e.source_id = sc.source_id AND e.type = 'xtream' LIMIT 1) AS epg_src,
              EXISTS (SELECT 1 FROM lineup_streams ls WHERE ls.source_channel_id = sc.id) AS in_lineup
       FROM source_channels sc WHERE sc.id IN (SELECT value FROM json_each(?))`,
    )
      .bind(JSON.stringify(b.sourceChannelIds))
      .all<Record<string, any>>()
    const byId = new Map(scs.map((s) => [s.id, s]))
    const fixedCat = b.categoryName ? await ensureCategory(c.env, b.categoryName) : (b.categoryId ?? null)
    const catCache = new Map<string, string>()
    let num = b.startNumber ?? (await nextNumber(c.env))
    const now = Date.now()
    const stmts: D1PreparedStatement[] = []
    const created: string[] = []
    const skipped: string[] = []

    for (const scId of b.sourceChannelIds) {
      const sc = byId.get(scId)
      if (!sc || (b.skipExisting !== false && sc.in_lineup)) {
        skipped.push(scId)
        continue
      }
      let cat = fixedCat
      if (!cat && b.useSourceCategory && sc.category_name) {
        const name = cleanChannelName(sc.category_name)
        if (!catCache.has(name)) catCache.set(name, await ensureCategory(c.env, name))
        cat = catCache.get(name)!
      }
      const id = newId('ch')
      const mapEpg = b.mapEpg !== false && sc.epg_channel_id && sc.epg_src
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO lineup_channels (id, number, name, category_id, logo, epg_source_id, epg_channel_id, kind, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).bind(
          id, num++, b.cleanNames === false ? sc.name : cleanChannelName(sc.name), cat, sc.logo,
          mapEpg ? sc.epg_src : null, mapEpg ? sc.epg_channel_id : null, b.kind ?? 'linear', now, now,
        ),
        c.env.DB.prepare('INSERT INTO lineup_streams (lineup_channel_id, source_channel_id, priority) VALUES (?, ?, 0)').bind(id, scId),
      )
      created.push(id)
    }
    await batchRun(c.env, stmts, 100)
    return c.json({ created: await getChannels(c.env, created), skipped }, 201)
  },
)

app.openapi(
  route({ method: 'patch', path: '/lineup/channels/{id}', tags: T, summary: 'Update a lineup channel', params: IdParam, body: LineupChannelPatch, response: LineupChannel }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    await getChannel(c.env, id)
    await (await patchStatement(c.env, id, valid(c, 'json') as z.infer<typeof LineupChannelPatch>)).run()
    return c.json(await getChannel(c.env, id))
  },
)

const BulkPatch = z
  .object({ updates: z.array(LineupChannelPatch.extend({ id: z.string() })).min(1).max(2000) })
  .openapi('BulkChannelPatch')

app.openapi(
  route({
    method: 'patch',
    path: '/lineup/channels',
    tags: T,
    summary: 'Bulk update lineup channels',
    description: 'Each update is a partial channel with its id. Applied atomically per batch of 50.',
    body: BulkPatch,
    response: z.object({ updated: z.number() }),
  }),
  async (c) => {
    const { updates } = valid(c, 'json') as z.infer<typeof BulkPatch>
    const stmts = []
    for (const { id, ...p } of updates) stmts.push(await patchStatement(c.env, id, p))
    await batchRun(c.env, stmts)
    return c.json({ updated: updates.length })
  },
)

app.openapi(
  route({ method: 'delete', path: '/lineup/channels/{id}', tags: T, summary: 'Delete a lineup channel', params: IdParam, response: OkSchema }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    await c.env.DB.prepare('DELETE FROM lineup_channels WHERE id = ?').bind(id).run()
    return c.json({ ok: true })
  },
)

app.openapi(
  route({
    method: 'post',
    path: '/lineup/channels/bulk-delete',
    tags: T,
    summary: 'Delete many lineup channels',
    body: z.object({ ids: z.array(z.string()).min(1) }),
    response: z.object({ deleted: z.number() }),
  }),
  async (c) => {
    const { ids } = valid(c, 'json') as { ids: string[] }
    const r = await c.env.DB.prepare('DELETE FROM lineup_channels WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).run()
    return c.json({ deleted: r.meta.changes ?? 0 })
  },
)

const Scope = {
  ids: z.array(z.string()).optional().openapi({ description: 'Limit to these channels' }),
  categoryId: z.string().optional().openapi({ description: 'Limit to a category' }),
  dryRun: z.boolean().optional().openapi({ description: 'Return the changes without applying them' }),
}

async function scopedChannels(env: Env, s: { ids?: string[]; categoryId?: string }) {
  const where: string[] = []
  const args: unknown[] = []
  if (s.ids) {
    where.push('id IN (SELECT value FROM json_each(?))')
    args.push(JSON.stringify(s.ids))
  }
  if (s.categoryId) {
    where.push('category_id = ?')
    args.push(s.categoryId)
  }
  const { results } = await env.DB.prepare(
    `SELECT id, name, number, locked FROM lineup_channels ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY number, name`,
  )
    .bind(...args)
    .all<{ id: string; name: string; number: number | null; locked: number }>()
  return results
}

const Change = z.object({ id: z.string(), before: z.string(), after: z.string() })

const Rename = z
  .object({
    pattern: z.string().min(1).openapi({ description: 'JS regex', example: '\\s*\\(?(?:HD|FHD)\\)?$' }),
    replacement: z.string().openapi({ description: 'Replacement string ($1, $<name> supported)', example: '' }),
    flags: z.string().optional().openapi({ description: "Regex flags (default 'gi')" }),
    ...Scope,
  })
  .openapi('RenameRequest')

app.openapi(
  route({
    method: 'post',
    path: '/lineup/channels/rename',
    tags: T,
    summary: 'Regex find/replace across channel names',
    body: Rename,
    response: z.object({ changes: z.array(Change), applied: z.boolean() }),
  }),
  async (c) => {
    const b = valid(c, 'json') as z.infer<typeof Rename>
    let re: RegExp
    try {
      re = new RegExp(b.pattern, b.flags ?? 'gi')
    } catch (e) {
      throw new HttpError(400, `bad regex: ${e}`)
    }
    const changes = (await scopedChannels(c.env, b))
      .map((r) => ({ id: r.id, before: r.name, after: r.name.replace(re, b.replacement).replace(/\s{2,}/g, ' ').trim() }))
      .filter((x) => x.after && x.after !== x.before)
    if (!b.dryRun) {
      const now = Date.now()
      await batchRun(c.env, changes.map((x) => c.env.DB.prepare('UPDATE lineup_channels SET name = ?, updated_at = ? WHERE id = ?').bind(x.after, now, x.id)))
    }
    return c.json({ changes, applied: !b.dryRun })
  },
)

app.openapi(
  route({
    method: 'post',
    path: '/lineup/channels/clean-names',
    tags: T,
    summary: 'Apply heuristic cleanup (country prefixes, HD/FHD/4K tags, symbols) to names',
    body: z.object(Scope),
    response: z.object({ changes: z.array(Change), applied: z.boolean() }),
  }),
  async (c) => {
    const b = valid(c, 'json') as { ids?: string[]; categoryId?: string; dryRun?: boolean }
    const changes = (await scopedChannels(c.env, b))
      .map((r) => ({ id: r.id, before: r.name, after: cleanChannelName(r.name) }))
      .filter((x) => x.after !== x.before)
    if (!b.dryRun) {
      const now = Date.now()
      await batchRun(c.env, changes.map((x) => c.env.DB.prepare('UPDATE lineup_channels SET name = ?, updated_at = ? WHERE id = ?').bind(x.after, now, x.id)))
    }
    return c.json({ changes, applied: !b.dryRun })
  },
)

const Renumber = z
  .object({
    ids: z.array(z.string()).optional().openapi({ description: 'Channels in the desired order. If omitted, uses categoryId (current order) or the whole lineup.' }),
    categoryId: z.string().optional(),
    start: z.number().openapi({ example: 100 }),
    step: z.number().positive().optional(),
  })
  .openapi('RenumberRequest')

app.openapi(
  route({
    method: 'post',
    path: '/lineup/channels/renumber',
    tags: T,
    summary: 'Assign sequential channel numbers',
    body: Renumber,
    response: z.object({ updated: z.number() }),
  }),
  async (c) => {
    const b = valid(c, 'json') as z.infer<typeof Renumber>
    const ids = b.ids ?? (await scopedChannels(c.env, { categoryId: b.categoryId })).map((r) => r.id)
    const step = b.step ?? 1
    const now = Date.now()
    await batchRun(
      c.env,
      ids.map((id, i) =>
        c.env.DB.prepare('UPDATE lineup_channels SET number = ?, sort_order = ?, updated_at = ? WHERE id = ?').bind(b.start + i * step, i, now, id),
      ),
    )
    return c.json({ updated: ids.length })
  },
)

const Merge = z
  .object({
    targetId: z.string(),
    sourceIds: z.array(z.string()).min(1).openapi({ description: 'Channels whose streams are appended to target as backups, then deleted' }),
  })
  .openapi('MergeRequest')

app.openapi(
  route({
    method: 'post',
    path: '/lineup/channels/merge',
    tags: T,
    summary: 'Merge duplicate channels into one (streams become failovers)',
    body: Merge,
    response: LineupChannel,
  }),
  async (c) => {
    const b = valid(c, 'json') as z.infer<typeof Merge>
    const target = await getChannel(c.env, b.targetId)
    const others = await getChannels(c.env, b.sourceIds.filter((id) => id !== b.targetId))
    const have = new Set(target.streams.map((s) => s.sourceChannelId))
    let prio = target.streams.length
    const stmts: D1PreparedStatement[] = []
    for (const o of others) {
      for (const s of o.streams) {
        if (have.has(s.sourceChannelId)) continue
        have.add(s.sourceChannelId)
        stmts.push(
          c.env.DB.prepare('INSERT OR IGNORE INTO lineup_streams (lineup_channel_id, source_channel_id, priority) VALUES (?, ?, ?)').bind(
            target.id, s.sourceChannelId, prio++,
          ),
        )
      }
      if (!target.epgChannelId && o.epgChannelId) {
        stmts.push(
          c.env.DB.prepare('UPDATE lineup_channels SET epg_source_id = ?, epg_channel_id = ? WHERE id = ?').bind(o.epgSourceId, o.epgChannelId, target.id),
        )
        target.epgChannelId = o.epgChannelId
      }
      stmts.push(
        c.env.DB.prepare('UPDATE OR IGNORE event_channels SET lineup_channel_id = ? WHERE lineup_channel_id = ?').bind(target.id, o.id),
        c.env.DB.prepare('DELETE FROM lineup_channels WHERE id = ?').bind(o.id),
      )
    }
    await batchRun(c.env, stmts)
    return c.json(await getChannel(c.env, target.id))
  },
)

app.openapi(
  route({
    method: 'put',
    path: '/lineup/channels/{id}/streams',
    tags: T,
    summary: 'Replace the upstream streams of a channel (in failover order)',
    params: IdParam,
    body: z.object({ sourceChannelIds: z.array(z.string()) }),
    response: LineupChannel,
  }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    const { sourceChannelIds } = valid(c, 'json') as { sourceChannelIds: string[] }
    await getChannel(c.env, id)
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM lineup_streams WHERE lineup_channel_id = ?').bind(id),
      ...sourceChannelIds.map((sc, i) =>
        c.env.DB.prepare('INSERT INTO lineup_streams (lineup_channel_id, source_channel_id, priority) VALUES (?, ?, ?)').bind(id, sc, i),
      ),
    ])
    return c.json(await getChannel(c.env, id))
  },
)

const Suggestion = z.object({
  epgSourceId: z.string(),
  epgSourceName: z.string().nullable(),
  xmltvId: z.string(),
  displayName: z.string().nullable(),
  icon: z.string().nullable(),
  score: z.number(),
})

async function suggestFor(env: Env, name: string, opts: { epgSourceIds?: string[]; limit?: number }) {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 3)
  if (!words.length) return []
  const srcFilter = opts.epgSourceIds?.length ? 'AND ec.epg_source_id IN (SELECT value FROM json_each(?))' : ''
  const { results } = await env.DB.prepare(
    `SELECT ec.epg_source_id, e.name AS epg_source_name, e.priority, ec.xmltv_id, ec.display_name, ec.icon
     FROM epg_channels ec JOIN epg_sources e ON e.id = ec.epg_source_id
     WHERE (ec.display_name LIKE ? OR ec.xmltv_id LIKE ?) ${srcFilter} LIMIT 500`,
  )
    .bind(`%${words[0]}%`, `%${words[0]}%`, ...(srcFilter ? [JSON.stringify(opts.epgSourceIds)] : []))
    .all<Record<string, any>>()
  return results
    .map((r) => ({
      epgSourceId: r.epg_source_id,
      epgSourceName: r.epg_source_name,
      xmltvId: r.xmltv_id,
      displayName: r.display_name,
      icon: r.icon,
      score: Math.max(similarity(name, r.display_name ?? ''), similarity(name, r.xmltv_id) * 0.95),
      priority: r.priority as number,
    }))
    .sort((a, b) => b.score - a.score || a.priority - b.priority)
    .slice(0, opts.limit ?? 10)
    .map(({ priority: _p, ...s }) => s)
}

app.openapi(
  route({
    method: 'get',
    path: '/lineup/channels/{id}/epg-suggestions',
    tags: T,
    summary: 'Suggest EPG channels for a lineup channel (fuzzy name match)',
    params: IdParam,
    query: z.object({ q: z.string().optional().openapi({ description: 'Override search name' }) }),
    response: z.array(Suggestion),
  }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    const { q } = valid(c, 'query') as { q?: string }
    const ch = await getChannel(c.env, id)
    return c.json(await suggestFor(c.env, q || ch.name, { limit: 15 }))
  },
)

const AutoMap = z
  .object({
    ids: z.array(z.string()).optional(),
    epgSourceIds: z.array(z.string()).optional().openapi({ description: 'Only consider these EPG sources' }),
    minScore: z.number().min(0).max(1).optional().openapi({ description: 'Default 0.85' }),
    onlyUnmapped: z.boolean().optional().openapi({ description: 'Default true' }),
    dryRun: z.boolean().optional(),
  })
  .openapi('AutoMapEpgRequest')

app.openapi(
  route({
    method: 'post',
    path: '/lineup/auto-map-epg',
    tags: T,
    summary: 'Auto-map channels to EPG channels by name similarity',
    description: 'Afterwards call POST /api/epg/refresh to load programmes for newly mapped channels.',
    body: AutoMap,
    response: z.object({
      mapped: z.array(z.object({ id: z.string(), name: z.string(), epgSourceId: z.string(), xmltvId: z.string(), displayName: z.string().nullable(), score: z.number() })),
      unmatched: z.array(z.object({ id: z.string(), name: z.string(), best: Suggestion.nullable() })),
      applied: z.boolean(),
    }),
  }),
  async (c) => {
    const b = valid(c, 'json') as z.infer<typeof AutoMap>
    const where: string[] = ["kind = 'linear'"]
    const args: unknown[] = []
    if (b.onlyUnmapped !== false) where.push('epg_channel_id IS NULL')
    if (b.ids) {
      where.push('id IN (SELECT value FROM json_each(?))')
      args.push(JSON.stringify(b.ids))
    }
    const { results } = await c.env.DB.prepare(`SELECT id, name FROM lineup_channels WHERE ${where.join(' AND ')} LIMIT 1000`)
      .bind(...args)
      .all<{ id: string; name: string }>()
    const min = b.minScore ?? 0.85
    const mapped = []
    const unmatched = []
    for (const ch of results) {
      const [best] = await suggestFor(c.env, ch.name, { epgSourceIds: b.epgSourceIds, limit: 1 })
      if (best && best.score >= min) mapped.push({ id: ch.id, name: ch.name, epgSourceId: best.epgSourceId, xmltvId: best.xmltvId, displayName: best.displayName, score: best.score })
      else unmatched.push({ id: ch.id, name: ch.name, best: best ?? null })
    }
    if (!b.dryRun) {
      const now = Date.now()
      await batchRun(
        c.env,
        mapped.map((m) =>
          c.env.DB.prepare('UPDATE lineup_channels SET epg_source_id = ?, epg_channel_id = ?, updated_at = ? WHERE id = ?').bind(m.epgSourceId, m.xmltvId, now, m.id),
        ),
      )
    }
    return c.json({ mapped, unmatched, applied: !b.dryRun })
  },
)

app.openapi(
  route({
    method: 'get',
    path: '/lineup/channels/{id}/guide',
    tags: T,
    summary: "A channel's programme guide",
    params: IdParam,
    query: z.object({ from: z.coerce.number().optional(), to: z.coerce.number().optional() }),
    response: z.array(Programme),
  }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    const q = valid(c, 'query') as { from?: number; to?: number }
    const ch = await getChannel(c.env, id)
    if (!ch.epgChannelId || !ch.epgSourceId) return c.json([])
    const { results } = await c.env.DB.prepare(
      `SELECT epg_source_id AS epgSourceId, xmltv_id AS xmltvId, start, stop, title, subtitle, description, category, icon, episode
       FROM programmes WHERE epg_source_id = ? AND xmltv_id = ? AND stop > ? AND start < ? ORDER BY start`,
    )
      .bind(ch.epgSourceId, ch.epgChannelId, q.from ?? Date.now() - 3600_000, q.to ?? Date.now() + 86400_000)
      .all()
    return c.json(results as any)
  },
)

export default app
