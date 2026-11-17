import { z } from '@hono/zod-openapi'
import { getMeta } from '../../db'
import { checkPassword, clearSessionCookie, createSessionCookie, generateToken } from '../../lib/auth'
import { runFullRefresh } from '../../jobs'
import { HttpError, IdParam, newRouter, route, valid } from '../hono'
import { touchLineup } from '../lineup-store'
import { OkSchema, Token } from '../schemas'

const app = newRouter()

app.openapi(
  route({
    method: 'post',
    path: '/auth/login',
    tags: ['Auth'],
    summary: 'Log in to the web UI (sets a session cookie)',
    body: z.object({ password: z.string() }),
    response: OkSchema,
  }),
  async (c) => {
    const { password } = valid(c, 'json') as { password: string }
    if (!checkPassword(c.env, password)) throw new HttpError(401, 'invalid password')
    c.header('set-cookie', await createSessionCookie(c.env, new URL(c.req.url).protocol === 'https:'))
    return c.json({ ok: true })
  },
)

app.openapi(
  route({ method: 'post', path: '/auth/logout', tags: ['Auth'], summary: 'Log out', response: OkSchema }),
  async (c) => {
    c.header('set-cookie', clearSessionCookie())
    return c.json({ ok: true })
  },
)

app.openapi(
  route({
    method: 'get',
    path: '/auth/me',
    tags: ['Auth'],
    summary: 'Who am I',
    response: z.object({ scope: z.enum(['admin', 'output']), via: z.string() }),
  }),
  async (c) => c.json(c.get('auth')),
)

// ---- tokens ----
app.openapi(
  route({ method: 'get', path: '/tokens', tags: ['Tokens'], summary: 'List API tokens', response: z.array(Token) }),
  async (c) => {
    const { results } = await c.env.DB.prepare(
      'SELECT id, name, scope, prefix, last_used_at AS lastUsedAt, created_at AS createdAt FROM api_tokens ORDER BY created_at DESC',
    ).all()
    return c.json(results as any)
  },
)

app.openapi(
  route({
    method: 'post',
    path: '/tokens',
    tags: ['Tokens'],
    summary: 'Create an API token (the secret is only returned once)',
    description: 'scope=admin: full API access (give this to agents). scope=output: playlist/EPG/stream/output endpoints only (give this to players).',
    body: z.object({ name: z.string().min(1), scope: z.enum(['admin', 'output']) }),
    response: z.object({ id: z.string(), token: z.string() }),
    status: 201,
  }),
  async (c) => {
    const b = valid(c, 'json') as { name: string; scope: 'admin' | 'output' }
    return c.json(await generateToken(c.env, b.name, b.scope), 201)
  },
)

app.openapi(
  route({ method: 'delete', path: '/tokens/{id}', tags: ['Tokens'], summary: 'Revoke a token', params: IdParam, response: OkSchema }),
  async (c) => {
    await c.env.DB.prepare('DELETE FROM api_tokens WHERE id = ?').bind((valid(c, 'param') as { id: string }).id).run()
    return c.json({ ok: true })
  },
)

// ---- system ----
app.openapi(
  route({
    method: 'get',
    path: '/stats',
    tags: ['System'],
    summary: 'Counts and sync status overview',
    response: z.object({
      sources: z.number(),
      sourceChannels: z.number(),
      epgSources: z.number(),
      epgChannels: z.number(),
      programmes: z.number(),
      lineupChannels: z.number(),
      lineupEnabled: z.number(),
      lineupWithEpg: z.number(),
      lineupBroken: z.number(),
      categories: z.number(),
      eventsUpcoming: z.number(),
      rules: z.number(),
      lastFullRefresh: z.string().nullable(),
    }),
  }),
  async (c) => {
    const now = Date.now()
    const r = await c.env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM sources) AS sources,
        (SELECT COUNT(*) FROM source_channels WHERE removed_at IS NULL) AS sourceChannels,
        (SELECT COUNT(*) FROM epg_sources) AS epgSources,
        (SELECT COUNT(*) FROM epg_channels) AS epgChannels,
        (SELECT COUNT(*) FROM programmes) AS programmes,
        (SELECT COUNT(*) FROM lineup_channels) AS lineupChannels,
        (SELECT COUNT(*) FROM lineup_channels WHERE enabled = 1) AS lineupEnabled,
        (SELECT COUNT(*) FROM lineup_channels WHERE epg_channel_id IS NOT NULL) AS lineupWithEpg,
        (SELECT COUNT(*) FROM lineup_channels lc WHERE NOT EXISTS (
            SELECT 1 FROM lineup_streams ls JOIN source_channels sc ON sc.id = ls.source_channel_id
            WHERE ls.lineup_channel_id = lc.id AND sc.removed_at IS NULL)) AS lineupBroken,
        (SELECT COUNT(*) FROM categories) AS categories,
        (SELECT COUNT(*) FROM events WHERE hidden = 0 AND (ends_at IS NULL OR ends_at > ?)) AS eventsUpcoming,
        (SELECT COUNT(*) FROM event_rules) AS rules`,
    )
      .bind(now)
      .first<Record<string, number>>()
    return c.json({ ...(r as any), lastFullRefresh: await getMeta(c.env, 'last_full_refresh') })
  },
)

app.openapi(
  route({
    method: 'post',
    path: '/refresh',
    tags: ['System'],
    summary: 'Full refresh: sync all sources, refresh all EPG, run all event rules',
    response: z.object({ sources: z.array(z.any()), epg: z.array(z.any()), rules: z.array(z.any()) }),
  }),
  async (c) => {
    const r = await runFullRefresh(c.env)
    await touchLineup(c.env)
    return c.json(r)
  },
)

// ---- backup ----
const Snapshot = z
  .object({
    version: z.literal(1),
    exportedAt: z.number(),
    categories: z.array(z.record(z.string(), z.any())),
    channels: z.array(z.record(z.string(), z.any())),
    streams: z.array(z.record(z.string(), z.any())),
    events: z.array(z.record(z.string(), z.any())),
    eventChannels: z.array(z.record(z.string(), z.any())),
    rules: z.array(z.record(z.string(), z.any())),
  })
  .openapi('LineupSnapshot')

const TABLES = [
  ['categories', 'categories'],
  ['channels', 'lineup_channels'],
  ['streams', 'lineup_streams'],
  ['rules', 'event_rules'],
  ['events', 'events'],
  ['eventChannels', 'event_channels'],
] as const

app.openapi(
  route({
    method: 'get',
    path: '/lineup/export',
    tags: ['Backup'],
    summary: 'Export the full lineup (categories, channels, streams, events, rules) as a snapshot',
    response: Snapshot,
  }),
  async (c) => {
    const out: Record<string, unknown> = { version: 1, exportedAt: Date.now() }
    for (const [k, t] of TABLES) out[k] = (await c.env.DB.prepare(`SELECT * FROM ${t}`).all()).results
    return c.json(out as any)
  },
)

app.openapi(
  route({
    method: 'post',
    path: '/lineup/import',
    tags: ['Backup'],
    summary: 'Replace the lineup with a snapshot from /lineup/export',
    description: 'Destructive: deletes current categories/channels/events/rules first. Streams pointing at unknown upstream channels are dropped.',
    body: Snapshot,
    response: OkSchema,
  }),
  async (c) => {
    const snap = valid(c, 'json') as z.infer<typeof Snapshot>
    const stmts: D1PreparedStatement[] = [
      'DELETE FROM event_channels', 'DELETE FROM events', 'DELETE FROM lineup_streams', 'DELETE FROM lineup_channels',
      'DELETE FROM event_rules', 'DELETE FROM categories',
    ].map((s) => c.env.DB.prepare(s))
    for (const [k, t] of TABLES) {
      for (const row of snap[k] as Record<string, unknown>[]) {
        const cols = Object.keys(row).filter((col) => /^[a-z_]+$/.test(col))
        const verb = t === 'lineup_streams' ? 'INSERT OR IGNORE' : 'INSERT'
        const sql =
          t === 'lineup_streams'
            ? `${verb} INTO ${t} (${cols.join(',')}) SELECT ${cols.map(() => '?').join(',')} WHERE EXISTS (SELECT 1 FROM source_channels WHERE id = ?)`
            : `${verb} INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
        const vals = cols.map((col) => row[col] ?? null)
        stmts.push(c.env.DB.prepare(sql).bind(...vals, ...(t === 'lineup_streams' ? [row.source_channel_id] : [])))
      }
    }
    // D1 batches are transactional; for big imports this spans multiple transactions
    for (let i = 0; i < stmts.length; i += 100) await c.env.DB.batch(stmts.slice(i, i + 100))
    await touchLineup(c.env)
    return c.json({ ok: true })
  },
)

export default app
