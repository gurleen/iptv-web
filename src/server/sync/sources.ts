import { jsonChunks } from '../db'
import { XtreamClient } from '../lib/xtream'

export type SourceRow = {
  id: string
  name: string
  base_url: string
  username: string
  password: string
  user_agent: string | null
  stream_format: string
  enabled: number
}

export function clientFor(s: Pick<SourceRow, 'base_url' | 'username' | 'password' | 'user_agent'>) {
  return new XtreamClient({ baseUrl: s.base_url, username: s.username, password: s.password, userAgent: s.user_agent })
}

export async function getSourceRow(env: Env, id: string) {
  return env.DB.prepare('SELECT * FROM sources WHERE id = ?').bind(id).first<SourceRow>()
}

export type SyncResult = { sourceId: string; ok: boolean; channels?: number; removed?: number; error?: string }

/** Pull categories + live streams for one source and upsert into source_channels. */
export async function syncSource(env: Env, sourceId: string): Promise<SyncResult> {
  const src = await getSourceRow(env, sourceId)
  if (!src) return { sourceId, ok: false, error: 'not found' }
  const started = Date.now()
  try {
    const client = clientFor(src)
    const account = await client.account()
    const [cats, streams] = await Promise.all([client.liveCategories(), client.liveStreams()])
    const catNames = new Map(cats.map((c) => [String(c.category_id), c.category_name]))

    const rows = streams
      .filter((s) => s.stream_id != null && s.name)
      .map((s) => ({
        id: `${sourceId}:${s.stream_id}`,
        sid: Number(s.stream_id),
        n: String(s.name).trim(),
        c: s.category_id != null ? String(s.category_id) : null,
        cn: s.category_id != null ? (catNames.get(String(s.category_id)) ?? null) : null,
        l: s.stream_icon || null,
        e: s.epg_channel_id || null,
        num: s.num != null ? Number(s.num) : null,
        a: s.tv_archive ? 1 : 0,
      }))

    const stmts = jsonChunks(rows).map((chunk) =>
      env.DB.prepare(
        `INSERT INTO source_channels
           (id, source_id, stream_id, name, category_id, category_name, logo, epg_channel_id, num, tv_archive, seen_at, removed_at)
         SELECT j.value ->> 'id', ?1, j.value ->> 'sid', j.value ->> 'n', j.value ->> 'c', j.value ->> 'cn',
                j.value ->> 'l', j.value ->> 'e', j.value ->> 'num', j.value ->> 'a', ?2, NULL
         FROM json_each(?3) AS j
         WHERE true
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, category_id = excluded.category_id, category_name = excluded.category_name,
           logo = excluded.logo, epg_channel_id = excluded.epg_channel_id, num = excluded.num,
           tv_archive = excluded.tv_archive, seen_at = excluded.seen_at, removed_at = NULL`,
      ).bind(sourceId, started, chunk),
    )
    for (let i = 0; i < stmts.length; i += 5) await env.DB.batch(stmts.slice(i, i + 5))

    // mark streams that disappeared; purge long-gone ones that nothing references
    const removed = await env.DB.prepare(
      'UPDATE source_channels SET removed_at = ?1 WHERE source_id = ?2 AND seen_at < ?1 AND removed_at IS NULL',
    )
      .bind(started, sourceId)
      .run()
    await env.DB.prepare(
      `DELETE FROM source_channels WHERE source_id = ? AND removed_at IS NOT NULL AND removed_at < ?
         AND id NOT IN (SELECT source_channel_id FROM lineup_streams)`,
    )
      .bind(sourceId, started - 7 * 86400_000)
      .run()

    await env.DB.prepare(
      `UPDATE sources SET last_sync_at = ?, last_sync_status = 'ok', last_sync_error = NULL,
         account_info = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(Date.now(), JSON.stringify(account.user_info ?? {}), Date.now(), sourceId)
      .run()
    return { sourceId, ok: true, channels: rows.length, removed: removed.meta.changes ?? 0 }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await env.DB.prepare(
      `UPDATE sources SET last_sync_at = ?, last_sync_status = 'error', last_sync_error = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(Date.now(), error, Date.now(), sourceId)
      .run()
    return { sourceId, ok: false, error }
  }
}

export async function syncAllSources(env: Env) {
  const { results } = await env.DB.prepare('SELECT id FROM sources WHERE enabled = 1').all<{ id: string }>()
  const out: SyncResult[] = []
  for (const r of results) out.push(await syncSource(env, r.id))
  return out
}
