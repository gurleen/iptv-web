import { bumpVersion, jsonChunks } from '../db'
import { parseXmltv, type XmltvChannel, type XmltvProgramme } from '../lib/xmltv'
import { clientFor, getSourceRow } from './sources'

type EpgSourceRow = {
  id: string
  name: string
  type: 'xmltv' | 'xtream'
  url: string | null
  source_id: string | null
  enabled: number
}

export function epgDays(env: Env) {
  const n = Number(env.EPG_DAYS)
  return Number.isFinite(n) && n > 0 ? Math.min(n, 14) : 3
}

async function resolveUrl(env: Env, row: EpgSourceRow) {
  if (row.type === 'xtream') {
    if (!row.source_id) throw new Error('xtream EPG source has no linked source')
    const src = await getSourceRow(env, row.source_id)
    if (!src) throw new Error('linked source missing')
    return { url: clientFor(src).xmltvUrl(), userAgent: src.user_agent }
  }
  if (!row.url) throw new Error('no URL')
  return { url: row.url, userAgent: null }
}

export type EpgSyncResult = { epgSourceId: string; ok: boolean; channels?: number; programmes?: number; error?: string }

/**
 * Stream an XMLTV feed: record every <channel> (for mapping) and store programmes only for
 * channels that are mapped into the lineup, within the configured window.
 */
export async function syncEpgSource(env: Env, epgSourceId: string): Promise<EpgSyncResult> {
  const row = await env.DB.prepare('SELECT * FROM epg_sources WHERE id = ?').bind(epgSourceId).first<EpgSourceRow>()
  if (!row) return { epgSourceId, ok: false, error: 'not found' }
  const started = Date.now()
  try {
    const { url, userAgent } = await resolveUrl(env, row)
    const res = await fetch(url, { headers: { 'user-agent': userAgent || 'Mozilla/5.0 iptv-web', accept: '*/*' } })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

    const { results: mapped } = await env.DB.prepare(
      'SELECT DISTINCT epg_channel_id AS id FROM lineup_channels WHERE epg_source_id = ? AND epg_channel_id IS NOT NULL',
    )
      .bind(epgSourceId)
      .all<{ id: string }>()
    const wanted = new Set(mapped.map((m) => m.id))

    const from = started - 12 * 3600_000
    const to = started + epgDays(env) * 86400_000

    const channels: XmltvChannel[] = []
    let progBuf: XmltvProgramme[] = []
    let progCount = 0

    // replace this source's programmes
    await env.DB.prepare('DELETE FROM programmes WHERE epg_source_id = ?').bind(epgSourceId).run()

    const flushProgs = async () => {
      if (!progBuf.length) return
      const rows = progBuf.map((p) => ({
        x: p.channel, s: p.start, e: p.stop, t: p.title, st: p.subtitle,
        d: p.description?.slice(0, 2000) ?? null, c: p.category, i: p.icon, ep: p.episode,
      }))
      progBuf = []
      const stmts = jsonChunks(rows).map((chunk) =>
        env.DB.prepare(
          `INSERT OR REPLACE INTO programmes
             (epg_source_id, xmltv_id, start, stop, title, subtitle, description, category, icon, episode)
           SELECT ?1, j.value ->> 'x', j.value ->> 's', j.value ->> 'e', j.value ->> 't', j.value ->> 'st',
                  j.value ->> 'd', j.value ->> 'c', j.value ->> 'i', j.value ->> 'ep'
           FROM json_each(?2) AS j`,
        ).bind(epgSourceId, chunk),
      )
      await env.DB.batch(stmts)
    }

    await parseXmltv(res.body, {
      channel: (c) => {
        channels.push(c)
      },
      wantProgramme: (id) => wanted.has(id),
      programme: async (p) => {
        if (p.stop < from || p.start > to) return
        progBuf.push(p)
        progCount++
        if (progBuf.length >= 2000) await flushProgs()
      },
    })
    await flushProgs()

    // upsert channel list, drop ones no longer present
    const chRows = channels.map((c) => ({ x: c.id, n: c.displayName, i: c.icon }))
    const stmts = jsonChunks(chRows).map((chunk) =>
      env.DB.prepare(
        `INSERT INTO epg_channels (epg_source_id, xmltv_id, display_name, icon, seen_at)
         SELECT ?1, j.value ->> 'x', j.value ->> 'n', j.value ->> 'i', ?2 FROM json_each(?3) AS j WHERE true
         ON CONFLICT(epg_source_id, xmltv_id) DO UPDATE SET
           display_name = excluded.display_name, icon = excluded.icon, seen_at = excluded.seen_at`,
      ).bind(epgSourceId, started, chunk),
    )
    for (let i = 0; i < stmts.length; i += 5) await env.DB.batch(stmts.slice(i, i + 5))
    await env.DB.prepare('DELETE FROM epg_channels WHERE epg_source_id = ? AND seen_at < ?').bind(epgSourceId, started).run()

    await env.DB.prepare(
      `UPDATE epg_sources SET last_sync_at = ?, last_sync_status = 'ok', last_sync_error = NULL,
         channel_count = ?, programme_count = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(Date.now(), channels.length, progCount, Date.now(), epgSourceId)
      .run()
    await bumpVersion(env, 'epg_version')
    return { epgSourceId, ok: true, channels: channels.length, programmes: progCount }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await env.DB.prepare(
      `UPDATE epg_sources SET last_sync_at = ?, last_sync_status = 'error', last_sync_error = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(Date.now(), error, Date.now(), epgSourceId)
      .run()
    return { epgSourceId, ok: false, error }
  }
}

export async function syncAllEpg(env: Env) {
  const { results } = await env.DB.prepare('SELECT id FROM epg_sources WHERE enabled = 1 ORDER BY priority').all<{ id: string }>()
  const out: EpgSyncResult[] = []
  for (const r of results) out.push(await syncEpgSource(env, r.id))
  // trim old programmes
  await env.DB.prepare('DELETE FROM programmes WHERE stop < ?').bind(Date.now() - 24 * 3600_000).run()
  return out
}
