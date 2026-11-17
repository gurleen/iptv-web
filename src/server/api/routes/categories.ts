import { z } from '@hono/zod-openapi'
import { batchRun } from '../../db'
import { newId } from '../../lib/ids'
import { HttpError, IdParam, newRouter, notFound, route, valid } from '../hono'
import { touchLineup } from '../lineup-store'
import { Category, CategoryInput, OkSchema } from '../schemas'

const T = ['Lineup categories']
const app = newRouter()

app.use('*', async (c, next) => {
  await next()
  if (c.req.method !== 'GET' && c.res.status < 300) await touchLineup(c.env)
})

const SELECT = `SELECT c.id, c.name, c.sort_order AS sortOrder, c.hidden,
  (SELECT COUNT(*) FROM lineup_channels lc WHERE lc.category_id = c.id) AS channelCount FROM categories c`

const ser = (r: any): z.infer<typeof Category> => ({ ...r, hidden: !!r.hidden })

async function getCat(env: Env, id: string) {
  const r = await env.DB.prepare(`${SELECT} WHERE c.id = ?`).bind(id).first()
  if (!r) throw notFound('category')
  return ser(r)
}

app.openapi(
  route({ method: 'get', path: '/lineup/categories', tags: T, summary: 'List categories in output order', response: z.array(Category) }),
  async (c) => {
    const { results } = await c.env.DB.prepare(`${SELECT} ORDER BY c.sort_order, c.name`).all()
    return c.json(results.map(ser))
  },
)

app.openapi(
  route({ method: 'post', path: '/lineup/categories', tags: T, summary: 'Create a category', body: CategoryInput, response: Category, status: 201 }),
  async (c) => {
    const b = valid(c, 'json') as z.infer<typeof CategoryInput>
    const dup = await c.env.DB.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE').bind(b.name).first()
    if (dup) throw new HttpError(409, 'category with that name exists')
    const id = newId('cat')
    const max = await c.env.DB.prepare('SELECT MAX(sort_order) AS m FROM categories').first<{ m: number | null }>()
    const now = Date.now()
    await c.env.DB.prepare('INSERT INTO categories (id, name, sort_order, hidden, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, b.name, b.sortOrder ?? (max?.m ?? -1) + 1, b.hidden ? 1 : 0, now, now)
      .run()
    return c.json(await getCat(c.env, id), 201)
  },
)

app.openapi(
  route({ method: 'patch', path: '/lineup/categories/{id}', tags: T, summary: 'Rename / hide / reorder a category', params: IdParam, body: CategoryInput.partial(), response: Category }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    const b = valid(c, 'json') as Partial<z.infer<typeof CategoryInput>>
    await getCat(c.env, id)
    await c.env.DB.prepare(
      `UPDATE categories SET name = COALESCE(?, name), sort_order = COALESCE(?, sort_order), hidden = COALESCE(?, hidden), updated_at = ? WHERE id = ?`,
    )
      .bind(b.name ?? null, b.sortOrder ?? null, b.hidden == null ? null : b.hidden ? 1 : 0, Date.now(), id)
      .run()
    return c.json(await getCat(c.env, id))
  },
)

app.openapi(
  route({
    method: 'delete',
    path: '/lineup/categories/{id}',
    tags: T,
    summary: 'Delete a category',
    description: 'Channels move to `moveTo` category if given, otherwise become uncategorized (or are deleted with deleteChannels=true).',
    params: IdParam,
    query: z.object({ moveTo: z.string().optional(), deleteChannels: z.enum(['true', 'false']).optional() }),
    response: OkSchema,
  }),
  async (c) => {
    const { id } = valid(c, 'param') as { id: string }
    const q = valid(c, 'query') as { moveTo?: string; deleteChannels?: string }
    await c.env.DB.batch([
      q.deleteChannels === 'true'
        ? c.env.DB.prepare('DELETE FROM lineup_channels WHERE category_id = ?').bind(id)
        : c.env.DB.prepare('UPDATE lineup_channels SET category_id = ? WHERE category_id = ?').bind(q.moveTo ?? null, id),
      c.env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id),
    ])
    return c.json({ ok: true })
  },
)

app.openapi(
  route({
    method: 'post',
    path: '/lineup/categories/reorder',
    tags: T,
    summary: 'Set category order',
    body: z.object({ ids: z.array(z.string()).min(1).openapi({ description: 'All (or some) category ids in desired order' }) }),
    response: OkSchema,
  }),
  async (c) => {
    const { ids } = valid(c, 'json') as { ids: string[] }
    await batchRun(c.env, ids.map((id, i) => c.env.DB.prepare('UPDATE categories SET sort_order = ? WHERE id = ?').bind(i, id)))
    return c.json({ ok: true })
  },
)

export default app
