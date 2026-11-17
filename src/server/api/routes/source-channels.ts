import { z } from '@hono/zod-openapi'
import { newRouter, route, valid } from '../hono'
import { PageQuery, SourceChannel, boolQuery, paginated } from '../schemas'

const T = ['Source channels']
const app = newRouter()

export type SourceChannelRow = {
  id: string
  source_id: string
  source_name: string | null
  stream_id: number
  name: string
  category_name: string | null
  logo: string | null
  epg_channel_id: string | null
  removed_at: number | null
  lineup_ids: string | null
}

export const serializeSourceChannel = (r: SourceChannelRow): z.infer<typeof SourceChannel> => ({
  id: r.id,
  sourceId: r.source_id,
  sourceName: r.source_name,
  streamId: r.stream_id,
  name: r.name,
  categoryName: r.category_name,
  logo: r.logo,
  epgChannelId: r.epg_channel_id,
  removed: r.removed_at != null,
  lineupChannelIds: r.lineup_ids ? r.lineup_ids.split(',') : [],
})

const Query = z.object({
  q: z.string().optional().openapi({ description: 'Substring match on name (case-insensitive). Use * as wildcard.' }),
  regex: z.string().optional().openapi({ description: 'JS regex applied to name (applied after q/filters, max 20k rows scanned)' }),
  sourceId: z.string().optional(),
  category: z.string().optional().openapi({ description: 'Exact upstream category name' }),
  categoryLike: z.string().optional().openapi({ description: 'Substring match on upstream category name' }),
  inLineup: boolQuery.openapi({ description: 'true = only channels already in the lineup, false = only ones not in it' }),
  includeRemoved: boolQuery,
  ...PageQuery,
})

app.openapi(
  route({
    method: 'get',
    path: '/source-channels',
    tags: T,
    summary: 'Search upstream channels across all sources',
    query: Query,
    response: paginated(SourceChannel, 'SourceChannelPage'),
  }),
  async (c) => {
    const q = valid(c, 'query') as z.infer<typeof Query>
    const limit = q.limit ?? 100
    const offset = q.offset ?? 0
    const where: string[] = []
    const args: unknown[] = []
    if (!q.includeRemoved) where.push('sc.removed_at IS NULL')
    if (q.q) {
      where.push(`sc.name LIKE ? ESCAPE '\\'`)
      args.push(`%${q.q.replace(/[%_\\]/g, '\\$&').replace(/\*/g, '%')}%`)
    }
    if (q.sourceId) {
      where.push('sc.source_id = ?')
      args.push(q.sourceId)
    }
    if (q.category) {
      where.push('sc.category_name = ?')
      args.push(q.category)
    }
    if (q.categoryLike) {
      where.push('sc.category_name LIKE ?')
      args.push(`%${q.categoryLike}%`)
    }
    if (q.inLineup != null) where.push(`${q.inLineup ? '' : 'NOT '}EXISTS (SELECT 1 FROM lineup_streams ls WHERE ls.source_channel_id = sc.id)`)
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const select = `SELECT sc.*, s.name AS source_name,
        (SELECT group_concat(lineup_channel_id) FROM lineup_streams ls WHERE ls.source_channel_id = sc.id) AS lineup_ids
      FROM source_channels sc LEFT JOIN sources s ON s.id = sc.source_id ${w}
      ORDER BY s.priority, sc.category_name, sc.num, sc.name`

    if (q.regex) {
      let re: RegExp
      try {
        re = new RegExp(q.regex, 'i')
      } catch (e) {
        return c.json({ error: `bad regex: ${e}` }, 400)
      }
      const { results } = await c.env.DB.prepare(`${select} LIMIT 20000`).bind(...args).all<SourceChannelRow>()
      const matched = results.filter((r) => re.test(r.name))
      return c.json({ items: matched.slice(offset, offset + limit).map(serializeSourceChannel), total: matched.length, limit, offset })
    }

    const [{ results }, total] = await Promise.all([
      c.env.DB.prepare(`${select} LIMIT ? OFFSET ?`).bind(...args, limit, offset).all<SourceChannelRow>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM source_channels sc ${w}`).bind(...args).first<{ n: number }>(),
    ])
    return c.json({ items: results.map(serializeSourceChannel), total: total?.n ?? 0, limit, offset })
  },
)

app.openapi(
  route({
    method: 'get',
    path: '/source-categories',
    tags: T,
    summary: 'Upstream categories across sources with counts',
    query: z.object({ sourceId: z.string().optional() }),
    response: z.array(z.object({ sourceId: z.string(), sourceName: z.string().nullable(), categoryName: z.string().nullable(), count: z.number(), inLineup: z.number() })),
  }),
  async (c) => {
    const { sourceId } = valid(c, 'query') as { sourceId?: string }
    const { results } = await c.env.DB.prepare(
      `SELECT sc.source_id AS sourceId, s.name AS sourceName, sc.category_name AS categoryName, COUNT(*) AS count,
         SUM(EXISTS (SELECT 1 FROM lineup_streams ls WHERE ls.source_channel_id = sc.id)) AS inLineup
       FROM source_channels sc LEFT JOIN sources s ON s.id = sc.source_id
       WHERE sc.removed_at IS NULL ${sourceId ? 'AND sc.source_id = ?' : ''}
       GROUP BY sc.source_id, sc.category_name ORDER BY s.priority, sc.category_name`,
    )
      .bind(...(sourceId ? [sourceId] : []))
      .all()
    return c.json(results as any)
  },
)

export default app
