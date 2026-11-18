import { z } from '@hono/zod-openapi'
import { batchRun, bumpVersion } from '../../db'
import { getRule, previewRule, runAllRules, runRule, type RuleRow } from '../../events/rules'
import { newId } from '../../lib/ids'
import { eventStatus } from '../../output/lineup'
import { gamesForEvents, matchEvents } from '../../sports/match'
import { HttpError, IdParam, newRouter, notFound, route, valid } from '../hono'
import { Event, EventInput, EventPatch, EventStatus, OkSchema, PageQuery, Rule, RuleInput, RulePatch, paginated } from '../schemas'

const app = newRouter()
const T = ['Events']
const TR = ['Event rules']

app.use('*', async (c, next) => {
  await next()
  if (c.req.method !== 'GET' && c.res.status < 300) await bumpVersion(c.env, 'events_version')
})

const toMs = (v: number | string | null | undefined) => {
  if (v == null) return v as null | undefined
  if (typeof v === 'number') return v
  const t = Date.parse(v)
  if (Number.isNaN(t)) throw new HttpError(400, `invalid date: ${v}`)
  return t
}

async function loadEvents(env: Env, where = '', args: unknown[] = [], tail = '') {
  const { results } = await env.DB.prepare(
    `SELECT e.*, (SELECT json_group_array(json_object('lineupChannelId', lc.id, 'name', lc.name, 'number', lc.number, 'label', ec.label, 'priority', ec.priority))
                  FROM event_channels ec JOIN lineup_channels lc ON lc.id = ec.lineup_channel_id WHERE ec.event_id = e.id) AS chans
     FROM events e ${where} ${tail}`,
  )
    .bind(...args)
    .all<Record<string, any>>()
  return results.map(
    (e): z.infer<typeof Event> => ({
      id: e.id,
      title: e.title,
      subtitle: e.subtitle,
      description: e.description,
      sport: e.sport,
      league: e.league,
      image: e.image,
      startsAt: e.starts_at,
      endsAt: e.ends_at,
      status: eventStatus(e as any),
      statusOverride: e.status_override,
      hidden: !!e.hidden,
      origin: e.origin,
      ruleId: e.rule_id,
      locked: !!e.locked,
      metadata: e.metadata ? JSON.parse(e.metadata) : null,
      gameLeague: e.game_league ?? null,
      gameId: e.game_id ?? null,
      gameLink: e.game_link ?? null,
      channels: (JSON.parse(e.chans || '[]') as any[]).sort((a, b) => a.priority - b.priority),
      createdAt: e.created_at,
      updatedAt: e.updated_at,
    }),
  )
}

async function getEvent(env: Env, id: string) {
  const [e] = await loadEvents(env, 'WHERE e.id = ?', [id])
  if (!e) throw notFound('event')
  return e
}

const ListQuery = z.object({
  status: z.string().optional().openapi({ description: 'Comma list of scheduled,live,ended,cancelled. Default: scheduled,live' }),
  q: z.string().optional(),
  sport: z.string().optional(),
  origin: z.enum(['manual', 'rule']).optional(),
  ruleId: z.string().optional(),
  from: z.coerce.number().optional().openapi({ description: 'Only events starting at/after (epoch ms)' }),
  to: z.coerce.number().optional().openapi({ description: 'Only events starting before (epoch ms)' }),
  includeHidden: z.enum(['true', 'false']).optional(),
  withGames: z.enum(['true', 'false']).optional().openapi({ description: 'Attach the linked game (scores/status) to each event' }),
  ...PageQuery,
})

app.openapi(
  route({ method: 'get', path: '/events', tags: T, summary: 'List events', query: ListQuery, response: paginated(Event, 'EventPage') }),
  async (c) => {
    const q = valid(c, 'query') as z.infer<typeof ListQuery>
    const where: string[] = []
    const args: unknown[] = []
    if (q.includeHidden !== 'true') where.push('e.hidden = 0')
    if (q.q) {
      where.push('e.title LIKE ?')
      args.push(`%${q.q}%`)
    }
    if (q.sport) {
      where.push('e.sport = ? COLLATE NOCASE')
      args.push(q.sport)
    }
    if (q.origin) {
      where.push('e.origin = ?')
      args.push(q.origin)
    }
    if (q.ruleId) {
      where.push('e.rule_id = ?')
      args.push(q.ruleId)
    }
    if (q.from != null) {
      where.push('e.starts_at >= ?')
      args.push(q.from)
    }
    if (q.to != null) {
      where.push('e.starts_at < ?')
      args.push(q.to)
    }
    const statuses = (q.status ?? 'scheduled,live').split(',').map((s) => s.trim())
    const all = await loadEvents(c.env, where.length ? `WHERE ${where.join(' AND ')}` : '', args, 'ORDER BY e.starts_at IS NULL, e.starts_at, e.title')
    const filtered = all.filter((e) => statuses.includes(e.status))
    const limit = q.limit ?? 100
    const offset = q.offset ?? 0
    const page = filtered.slice(offset, offset + limit)
    if (q.withGames === 'true') {
      const games = await gamesForEvents(c.env, page)
      for (const e of page) (e as any).game = games.get(e.id) ?? null
    }
    return c.json({ items: page, total: filtered.length, limit, offset })
  },
)

app.openapi(
  route({
    method: 'get',
    path: '/events/{id}',
    tags: T,
    summary: 'Get an event',
    params: IdParam,
    query: z.object({ withGame: z.enum(['true', 'false']).optional() }),
    response: Event,
  }),
  async (c) => {
    const e = await getEvent(c.env, (valid(c, 'param') as { id: string }).id)
    if ((valid(c, 'query') as { withGame?: string }).withGame === 'true') (e as any).game = (await gamesForEvents(c.env, [e])).get(e.id) ?? null
    return c.json(e)
  },
)

function channelStmts(env: Env, id: string, channels: z.infer<typeof EventInput>['channels']) {
  if (!channels) return []
  return [
    env.DB.prepare('DELETE FROM event_channels WHERE event_id = ?').bind(id),
    ...channels.map((ch, i) =>
      env.DB.prepare('INSERT OR REPLACE INTO event_channels (event_id, lineup_channel_id, label, priority) VALUES (?, ?, ?, ?)').bind(
        id, ch.lineupChannelId, ch.label ?? null, ch.priority ?? i,
      ),
    ),
  ]
}

app.openapi(
  route({ method: 'post', path: '/events', tags: T, summary: 'Create an event', body: EventInput, response: Event, status: 201 }),
  async (c) => {
    const b = valid(c, 'json') as z.infer<typeof EventInput>
    const id = newId('ev')
    const now = Date.now()
    const starts = toMs(b.startsAt) ?? null
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO events (id, title, subtitle, description, sport, league, image, starts_at, ends_at, status_override, hidden, origin, locked, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
      ).bind(
        id, b.title, b.subtitle ?? null, b.description ?? null, b.sport ?? null, b.league ?? null, b.image ?? null, starts,
        toMs(b.endsAt) ?? (starts != null ? starts + 3 * 3600_000 : null), b.statusOverride ?? null, b.hidden ? 1 : 0,
        b.locked === false ? 0 : 1, b.metadata ? JSON.stringify(b.metadata) : null, now, now,
      ),
      ...channelStmts(c.env, id, b.channels),
    ])
    await matchEvents(c.env, { eventIds: [id] }).catch(() => {})
    return c.json(await getEvent(c.env, id), 201)
  },
)

const EVENT_COLS: Record<string, string> = {
  title: 'title', subtitle: 'subtitle', description: 'description', sport: 'sport', league: 'league', image: 'image',
  startsAt: 'starts_at', endsAt: 'ends_at', statusOverride: 'status_override', hidden: 'hidden', locked: 'locked', metadata: 'metadata',
}

async function patchEvent(env: Env, id: string, b: z.infer<typeof EventPatch>) {
  const sets: string[] = []
  const args: unknown[] = []
  for (const [k, v] of Object.entries(b)) {
    const col = EVENT_COLS[k]
    if (!col || v === undefined) continue
    sets.push(`${col} = ?`)
    args.push(
      k === 'startsAt' || k === 'endsAt' ? toMs(v as any) : k === 'metadata' ? (v ? JSON.stringify(v) : null) : typeof v === 'boolean' ? (v ? 1 : 0) : v,
    )
  }
  // editing a rule-generated event pins it so rule runs don't undo the change
  if (b.locked === undefined) sets.push('locked = 1')
  // the teams/time may have changed: drop automatic game links so they get re-matched
  if (b.title !== undefined || b.startsAt !== undefined || b.league !== undefined) sets.push("game_link = CASE WHEN game_link = 'auto' THEN NULL ELSE game_link END")
  sets.push('updated_at = ?')
  args.push(Date.now())
  return [env.DB.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id), ...channelStmts(env, id, b.channels)]
}

app.openapi(
  route({
    method: 'patch',
    path: '/events/{id}',
    tags: T,
    summary: 'Update an event',
    description: 'Edits lock the event (locked=true) so event rules stop changing/deleting it, unless you pass locked explicitly.',
    params: IdParam,
    body: EventPatch,
    response: Event,
  }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    await getEvent(c.env, id)
    await c.env.DB.batch(await patchEvent(c.env, id, valid(c, 'json') as z.infer<typeof EventPatch>))
    await matchEvents(c.env, { eventIds: [id] }).catch(() => {})
    return c.json(await getEvent(c.env, id))
  },
)

app.openapi(
  route({
    method: 'patch',
    path: '/events',
    tags: T,
    summary: 'Bulk update events',
    body: z.object({ updates: z.array(EventPatch.extend({ id: z.string() })).min(1).max(1000) }),
    response: z.object({ updated: z.number() }),
  }),
  async (c) => {
    const { updates } = valid(c, 'json') as { updates: (z.infer<typeof EventPatch> & { id: string })[] }
    const stmts: D1PreparedStatement[] = []
    for (const { id, ...p } of updates) stmts.push(...(await patchEvent(c.env, id, p)))
    await batchRun(c.env, stmts)
    return c.json({ updated: updates.length })
  },
)

app.openapi(
  route({
    method: 'delete',
    path: '/events/{id}',
    tags: T,
    summary: 'Delete an event',
    description: 'Rule-generated events that still match will be recreated on the next run; hide them (hidden=true) instead.',
    params: IdParam,
    response: OkSchema,
  }),
  async (c) => {
    await c.env.DB.prepare('DELETE FROM events WHERE id = ?').bind((valid(c, 'param') as { id: string }).id).run()
    return c.json({ ok: true })
  },
)

// ---------------- rules ----------------

const ruleSer = (r: any): z.infer<typeof Rule> => ({
  id: r.id,
  name: r.name,
  enabled: !!r.enabled,
  kind: r.kind,
  pattern: r.pattern,
  flags: r.flags,
  sourceIds: r.source_ids ? JSON.parse(r.source_ids) : null,
  categoryPattern: r.category_pattern,
  lineupCategoryIds: r.lineup_category_ids ? JSON.parse(r.lineup_category_ids) : null,
  titleTemplate: r.title_template,
  sport: r.sport,
  league: r.league,
  timezone: r.timezone,
  defaultDurationMinutes: r.default_duration_minutes,
  autoAddChannel: !!r.auto_add_channel,
  targetCategoryId: r.target_category_id,
  requireDate: !!r.require_date,
  lastRunAt: r.last_run_at,
  lastRunMatches: r.last_run_matches,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const RULE_COLS: Record<string, string> = {
  name: 'name', enabled: 'enabled', kind: 'kind', pattern: 'pattern', flags: 'flags', sourceIds: 'source_ids',
  categoryPattern: 'category_pattern', lineupCategoryIds: 'lineup_category_ids', titleTemplate: 'title_template', sport: 'sport',
  league: 'league', timezone: 'timezone', defaultDurationMinutes: 'default_duration_minutes', autoAddChannel: 'auto_add_channel',
  targetCategoryId: 'target_category_id', requireDate: 'require_date',
}

function ruleValues(b: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(b)) {
    const col = RULE_COLS[k]
    if (!col || v === undefined) continue
    out[col] = Array.isArray(v) ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v
  }
  if (typeof b.pattern === 'string') {
    try {
      new RegExp(b.pattern)
    } catch (e) {
      throw new HttpError(400, `bad pattern: ${e}`)
    }
  }
  return out
}

async function getRuleOr404(env: Env, id: string) {
  const r = await getRule(env, id)
  if (!r) throw notFound('rule')
  return r
}

app.openapi(
  route({ method: 'get', path: '/event-rules', tags: TR, summary: 'List event rules', response: z.array(Rule) }),
  async (c) => {
    const { results } = await c.env.DB.prepare('SELECT * FROM event_rules ORDER BY name').all()
    return c.json(results.map(ruleSer))
  },
)

const PreviewItem = z.object({
  title: z.string(),
  startsAt: z.number().nullable(),
  endsAt: z.number().nullable(),
  matchedText: z.string(),
  sourceChannelId: z.string().optional(),
  lineupChannelIds: z.array(z.string()),
})

app.openapi(
  route({
    method: 'post',
    path: '/event-rules/preview',
    tags: TR,
    summary: 'Dry-run an unsaved rule definition',
    description: 'Use this to iterate on a pattern before saving. Returns the first 200 matches.',
    body: RuleInput,
    response: z.object({ total: z.number(), matches: z.array(PreviewItem) }),
  }),
  async (c) => {
    const b = valid(c, 'json') as z.infer<typeof RuleInput>
    const v = ruleValues(b)
    const rule = {
      id: 'preview', enabled: 1, flags: 'i', timezone: c.env.DEFAULT_TIMEZONE || 'America/New_York', default_duration_minutes: 180,
      auto_add_channel: 0, require_date: 0, source_ids: null, category_pattern: null, lineup_category_ids: null, title_template: null,
      sport: null, league: null, target_category_id: null, ...v,
    } as unknown as RuleRow
    const matches = await previewRule(c.env, rule)
    return c.json({ total: matches.length, matches: matches.slice(0, 200).map(({ dedupeKey: _d, description: _x, image: _i, ...m }) => m) })
  },
)

app.openapi(
  route({ method: 'post', path: '/event-rules', tags: TR, summary: 'Create an event rule', body: RuleInput.extend({ runNow: z.boolean().optional() }), response: Rule, status: 201 }),
  async (c) => {
    const b = valid(c, 'json') as z.infer<typeof RuleInput> & { runNow?: boolean }
    const v = ruleValues(b)
    const id = newId('rule')
    const now = Date.now()
    v.timezone ??= c.env.DEFAULT_TIMEZONE || 'America/New_York'
    const cols = ['id', ...Object.keys(v), 'created_at', 'updated_at']
    await c.env.DB.prepare(`INSERT INTO event_rules (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .bind(id, ...Object.values(v), now, now)
      .run()
    const rule = await getRuleOr404(c.env, id)
    if (b.runNow !== false && rule.enabled) await runRule(c.env, rule)
    return c.json(ruleSer(await getRuleOr404(c.env, id)), 201)
  },
)

app.openapi(
  route({ method: 'patch', path: '/event-rules/{id}', tags: TR, summary: 'Update an event rule', params: IdParam, body: RulePatch, response: Rule }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    await getRuleOr404(c.env, id)
    const v = ruleValues(valid(c, 'json') as Record<string, unknown>)
    v.updated_at = Date.now()
    await c.env.DB.prepare(`UPDATE event_rules SET ${Object.keys(v).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .bind(...Object.values(v), id)
      .run()
    return c.json(ruleSer(await getRuleOr404(c.env, id)))
  },
)

app.openapi(
  route({
    method: 'delete',
    path: '/event-rules/{id}',
    tags: TR,
    summary: 'Delete a rule',
    description: 'Also removes its unlocked events and auto-created channels unless keepEvents=true.',
    params: IdParam,
    query: z.object({ keepEvents: z.enum(['true', 'false']).optional() }),
    response: OkSchema,
  }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    const { keepEvents } = valid(c, 'query') as { keepEvents?: string }
    const stmts = [c.env.DB.prepare('DELETE FROM event_rules WHERE id = ?').bind(id)]
    if (keepEvents !== 'true') {
      stmts.push(
        c.env.DB.prepare('DELETE FROM events WHERE rule_id = ? AND locked = 0').bind(id),
        c.env.DB.prepare('DELETE FROM lineup_channels WHERE rule_id = ? AND locked = 0').bind(id),
      )
    }
    await c.env.DB.batch(stmts)
    return c.json({ ok: true })
  },
)

app.openapi(
  route({
    method: 'get',
    path: '/event-rules/{id}/preview',
    tags: TR,
    summary: 'Dry-run a saved rule',
    params: IdParam,
    response: z.object({ total: z.number(), matches: z.array(PreviewItem) }),
  }),
  async (c) => {
    const rule = await getRuleOr404(c.env, (valid(c, 'param') as { id: string }).id)
    const matches = await previewRule(c.env, rule)
    return c.json({ total: matches.length, matches: matches.slice(0, 200).map(({ dedupeKey: _d, description: _x, image: _i, ...m }) => m) })
  },
)

const RunResult = z.object({ ruleId: z.string(), matches: z.number().optional(), error: z.string().optional() })

app.openapi(
  route({ method: 'post', path: '/event-rules/{id}/run', tags: TR, summary: 'Run one rule now', params: IdParam, response: RunResult }),
  async (c) => {
    const rule = await getRuleOr404(c.env, (valid(c, 'param') as { id: string }).id)
    return c.json(await runRule(c.env, rule))
  },
)

app.openapi(
  route({ method: 'post', path: '/event-rules/run', tags: TR, summary: 'Run all enabled rules now', response: z.array(RunResult) }),
  async (c) => c.json(await runAllRules(c.env)),
)

export { EventStatus }
export default app
