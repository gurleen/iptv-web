import { swaggerUI } from '@hono/swagger-ui'
import { Hono } from 'hono'
import { authenticate } from '../lib/auth'
import { baseUrl } from '../output/lineup'
import { buildM3u } from '../output/m3u'
import { getOutputXmltv } from '../output/xmltv'
import { handleMcp } from '../mcp'
import { clientFor } from '../sync/sources'
import { AGENT_GUIDE } from './guide'
import { HttpError, newRouter, type AppEnv } from './hono'
import categories from './routes/categories'
import epg from './routes/epg'
import events from './routes/events'
import lineup from './routes/lineup'
import output from './routes/output'
import sourceChannels from './routes/source-channels'
import sources from './routes/sources'
import system from './routes/system'


const PUBLIC_API = new Set(['/api/auth/login', '/api/auth/logout', '/api/openapi.json', '/api/docs', '/api/guide'])

const api = newRouter()

api.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  if (PUBLIC_API.has(path)) return next()
  const auth = await authenticate(c.env, c.req.raw)
  if (!auth) return c.json({ error: 'unauthorized' }, 401)
  if (auth.scope !== 'admin' && !path.startsWith('/api/output/')) return c.json({ error: 'admin token required' }, 403)
  c.set('auth', auth)
  return next()
})

for (const r of [system, sources, sourceChannels, epg, categories, lineup, events, output]) api.route('/', r)

api.doc31('/openapi.json', (c) => ({
  openapi: '3.1.0',
  info: {
    title: 'IPTV Web API',
    version: '1.0.0',
    description:
      'Manage Xtream sources, EPG, the output lineup and events. Authenticate with `Authorization: Bearer <token>` (admin scope). See GET /api/guide for an agent-oriented walkthrough.',
  },
  servers: [{ url: `${baseUrl(c.env, c.req.raw)}/api` }],
  security: [{ bearer: [] }],
}))
api.openAPIRegistry.registerComponent('securitySchemes', 'bearer', { type: 'http', scheme: 'bearer' })
api.get('/docs', swaggerUI({ url: '/api/openapi.json' }))
api.get('/guide', (c) => c.text(AGENT_GUIDE.replaceAll('{{BASE}}', baseUrl(c.env, c.req.raw)), 200, { 'content-type': 'text/markdown; charset=utf-8' }))

/** Top-level worker app: /api/*, /playlist.m3u, /epg.xml(.gz), /stream/:id */
export const app = new Hono<AppEnv>()

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status)
  console.error(err)
  return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500)
})

app.route('/api', api)
app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

// --- MCP (Streamable HTTP, stateless). Auth: Authorization: Bearer <admin token> ---
app.all('/mcp', async (c) => {
  const auth = await authenticate(c.env, c.req.raw)
  if (!auth) return c.json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' })
  if (auth.scope !== 'admin') return c.json({ error: 'admin token required' }, 403)
  const authorization = c.req.header('authorization')
  const cookie = c.req.header('cookie')
  const origin = new URL(c.req.url).origin
  return handleMcp(c.req.raw, async (method, path, body) => {
    const headers: Record<string, string> = {}
    if (authorization) headers.authorization = authorization
    if (cookie) headers.cookie = cookie
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await app.fetch(
      new Request(`${origin}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      c.env,
      c.executionCtx,
    )
    const text = await res.text()
    let data: unknown = text
    try {
      data = text ? JSON.parse(text) : null
    } catch {}
    return { status: res.status, data }
  })
})

// --- player-facing outputs (output or admin scope; ?token= works for players) ---
const requireOutput = async (c: any, next: () => Promise<void>) => {
  const auth = await authenticate(c.env, c.req.raw)
  if (!auth) return c.text('unauthorized', 401)
  c.set('auth', auth)
  await next()
}

app.get('/playlist.m3u', requireOutput, async (c) => {
  const ev = c.req.query('events')
  const body = await buildM3u(c.env, {
    base: baseUrl(c.env, c.req.raw),
    token: c.req.query('token') ?? null,
    events: ev === 'none' || ev === 'false' ? 'none' : ev === 'only' ? 'only' : 'group',
    timezone: c.req.query('tz') || c.env.DEFAULT_TIMEZONE || 'UTC',
    eventsGroup: c.req.query('eventsGroup') || 'Events',
  })
  return c.body(body, 200, { 'content-type': 'audio/x-mpegurl; charset=utf-8', 'cache-control': 'no-store' })
})
app.get('/events.m3u', requireOutput, (c) => {
  const u = new URL(c.req.url)
  u.pathname = '/playlist.m3u'
  u.searchParams.set('events', 'only')
  return app.fetch(new Request(u, c.req.raw), c.env, c.executionCtx)
})

app.get('/epg.xml', requireOutput, async (c) => {
  const obj = await getOutputXmltv(c.env)
  return new Response(obj.body, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'max-age=300' } })
})
app.get('/epg.xml.gz', requireOutput, async (c) => {
  const obj = await getOutputXmltv(c.env)
  return new Response(obj.body.pipeThrough(new CompressionStream('gzip')), {
    headers: { 'content-type': 'application/gzip', 'cache-control': 'max-age=300' },
  })
})

app.get('/stream/:file', requireOutput, async (c) => {
  const [id, ext] = c.req.param('file').split('.')
  const { results } = await c.env.DB.prepare(
    `SELECT sc.stream_id, sc.removed_at, s.base_url, s.username, s.password, s.user_agent, s.stream_format
     FROM lineup_streams ls
     JOIN source_channels sc ON sc.id = ls.source_channel_id
     JOIN sources s ON s.id = sc.source_id
     JOIN lineup_channels lc ON lc.id = ls.lineup_channel_id
     WHERE ls.lineup_channel_id = ? AND s.enabled = 1 AND lc.enabled = 1
     ORDER BY sc.removed_at IS NOT NULL, ls.priority, s.priority`,
  )
    .bind(id)
    .all<Record<string, any>>()
  const pick = results[0]
  if (!pick) return c.text('channel not found', 404)
  const format = ext === 'm3u8' || ext === 'ts' ? ext : pick.stream_format
  return c.redirect(clientFor(pick as any).streamUrl(pick.stream_id, format), 302)
})
