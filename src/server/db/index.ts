import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

export type DB = ReturnType<typeof getDb>

export function getDb(env: Env) {
  return drizzle(env.DB, { schema })
}

export { schema }

/** Read a value from the meta table. */
export async function getMeta(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first<{ value: string }>()
  return row?.value ?? null
}

export async function setMeta(env: Env, key: string, value: string) {
  await env.DB.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
    .bind(key, value)
    .run()
}

/** Bump a version counter. Used to invalidate cached outputs (EPG XML). */
export async function bumpVersion(env: Env, key: 'lineup_version' | 'epg_version' | 'events_version') {
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
  )
    .bind(key)
    .run()
}

/** Run D1 statements in batches (D1 caps statements per batch). */
export async function batchRun(env: Env, stmts: D1PreparedStatement[], size = 50) {
  for (let i = 0; i < stmts.length; i += size) {
    await env.DB.batch(stmts.slice(i, i + size))
  }
}

/** Split rows into JSON chunks below D1's 2MB bound-value limit, for json_each() bulk inserts. */
export function jsonChunks<T>(rows: T[], maxBytes = 900_000): string[] {
  const chunks: string[] = []
  let cur: string[] = []
  let size = 2
  for (const r of rows) {
    const s = JSON.stringify(r)
    if (size + s.length + 1 > maxBytes && cur.length) {
      chunks.push(`[${cur.join(',')}]`)
      cur = []
      size = 2
    }
    cur.push(s)
    size += s.length + 1
  }
  if (cur.length) chunks.push(`[${cur.join(',')}]`)
  return chunks
}
