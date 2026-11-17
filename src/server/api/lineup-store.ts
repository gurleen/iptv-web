import type { z } from '@hono/zod-openapi'
import { bumpVersion } from '../db'
import { newId } from '../lib/ids'
import type { LineupChannel, LineupChannelPatch } from './schemas'
import { HttpError } from './hono'

type Row = Record<string, any>

export async function serializeChannels(env: Env, rows: Row[]): Promise<z.infer<typeof LineupChannel>[]> {
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const { results: streams } = await env.DB.prepare(
    `SELECT ls.lineup_channel_id, ls.source_channel_id, ls.priority, sc.name, sc.source_id, s.name AS source_name,
            sc.category_name, sc.removed_at
     FROM lineup_streams ls
     LEFT JOIN source_channels sc ON sc.id = ls.source_channel_id
     LEFT JOIN sources s ON s.id = sc.source_id
     WHERE ls.lineup_channel_id IN (SELECT value FROM json_each(?))
     ORDER BY ls.priority`,
  )
    .bind(JSON.stringify(ids))
    .all<Row>()
  const byCh = new Map<string, Row[]>()
  for (const s of streams) byCh.set(s.lineup_channel_id, [...(byCh.get(s.lineup_channel_id) ?? []), s])

  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    name: r.name,
    categoryId: r.category_id,
    categoryName: r.category_name ?? null,
    logo: r.logo,
    tvgId: r.tvg_id,
    epgSourceId: r.epg_source_id,
    epgChannelId: r.epg_channel_id,
    kind: r.kind,
    hideWhenIdle: !!r.hide_when_idle,
    enabled: !!r.enabled,
    sortOrder: r.sort_order,
    notes: r.notes,
    tags: r.tags ? JSON.parse(r.tags) : null,
    ruleId: r.rule_id,
    locked: !!r.locked,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    streams: (byCh.get(r.id) ?? []).map((s) => ({
      sourceChannelId: s.source_channel_id,
      priority: s.priority,
      name: s.name ?? null,
      sourceId: s.source_id ?? null,
      sourceName: s.source_name ?? null,
      categoryName: s.category_name ?? null,
      removed: s.removed_at != null,
    })),
  }))
}

export const CHANNEL_SELECT = `SELECT lc.*, c.name AS category_name FROM lineup_channels lc LEFT JOIN categories c ON c.id = lc.category_id`

export async function getChannels(env: Env, ids: string[]) {
  const { results } = await env.DB.prepare(`${CHANNEL_SELECT} WHERE lc.id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(ids))
    .all<Row>()
  const order = new Map(ids.map((id, i) => [id, i]))
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  return serializeChannels(env, results)
}

export async function getChannel(env: Env, id: string) {
  const [ch] = await getChannels(env, [id])
  if (!ch) throw new HttpError(404, 'lineup channel not found')
  return ch
}

/** Find a category by name (case-insensitive) or create it at the end. */
export async function ensureCategory(env: Env, name: string) {
  const existing = await env.DB.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE').bind(name).first<{ id: string }>()
  if (existing) return existing.id
  const id = newId('cat')
  const max = await env.DB.prepare('SELECT MAX(sort_order) AS m FROM categories').first<{ m: number | null }>()
  const now = Date.now()
  await env.DB.prepare('INSERT INTO categories (id, name, sort_order, hidden, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .bind(id, name, (max?.m ?? -1) + 1, now, now)
    .run()
  return id
}

const COLS: Record<string, string> = {
  number: 'number',
  name: 'name',
  categoryId: 'category_id',
  logo: 'logo',
  tvgId: 'tvg_id',
  epgSourceId: 'epg_source_id',
  epgChannelId: 'epg_channel_id',
  kind: 'kind',
  hideWhenIdle: 'hide_when_idle',
  enabled: 'enabled',
  sortOrder: 'sort_order',
  notes: 'notes',
  tags: 'tags',
  locked: 'locked',
}

/** Build an UPDATE statement for a channel patch (resolving categoryName first). */
export async function patchStatement(env: Env, id: string, patch: z.infer<typeof LineupChannelPatch>) {
  const p: Record<string, unknown> = { ...patch }
  if (patch.categoryName !== undefined) {
    p.categoryId = patch.categoryName ? await ensureCategory(env, patch.categoryName) : null
  }
  delete p.categoryName
  const sets: string[] = []
  const args: unknown[] = []
  for (const [k, v] of Object.entries(p)) {
    const col = COLS[k]
    if (!col || v === undefined) continue
    sets.push(`${col} = ?`)
    args.push(k === 'tags' ? (v ? JSON.stringify(v) : null) : typeof v === 'boolean' ? (v ? 1 : 0) : v)
  }
  sets.push('updated_at = ?')
  args.push(Date.now())
  return env.DB.prepare(`UPDATE lineup_channels SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id)
}

export async function nextNumber(env: Env) {
  const r = await env.DB.prepare('SELECT MAX(number) AS n FROM lineup_channels').first<{ n: number | null }>()
  return Math.floor(r?.n ?? 0) + 1
}

export const touchLineup = (env: Env) => bumpVersion(env, 'lineup_version')
