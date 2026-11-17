import { batchRun, bumpVersion } from '../db'
import { parseEventDate, stripDateText } from '../lib/dates'
import { newId, sha256Hex } from '../lib/ids'
import { cleanChannelName } from '../lib/names'
import { epgDays } from '../sync/epg'

export type RuleRow = {
  id: string
  name: string
  enabled: number
  kind: 'source_channel' | 'epg_programme'
  pattern: string
  flags: string
  source_ids: string | null
  category_pattern: string | null
  lineup_category_ids: string | null
  title_template: string | null
  sport: string | null
  league: string | null
  timezone: string
  default_duration_minutes: number
  auto_add_channel: number
  target_category_id: string | null
  require_date: number
}

export type RuleMatch = {
  dedupeKey: string
  title: string
  description: string | null
  image: string | null
  startsAt: number | null
  endsAt: number | null
  /** text the rule matched against */
  matchedText: string
  sourceChannelId?: string
  lineupChannelIds: string[]
}

function safeRegex(pattern: string, flags: string) {
  return new RegExp(pattern, flags.replace(/[^gimsuy]/g, '').replace('g', ''))
}

function fill(template: string, vars: Record<string, string | undefined>) {
  return template
    .replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] ?? '').trim())
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** "PPV 03: UFC 310 | 12/07 10PM ET" -> "UFC 310" */
export function defaultEventTitle(name: string) {
  let s = cleanChannelName(name)
  s = s.replace(/^\s*[A-Za-z+]{2,12}\s*\d{1,3}\s*[:|\-–]\s*/, '') // "PPV 03:", "NFL 05 -", "ESPN+ 12:"
  return stripDateText(s)
}

const jsonArr = (s: string | null): string[] | null => {
  if (!s) return null
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) && v.length ? v.map(String) : null
  } catch {
    return null
  }
}

async function matchSourceChannels(env: Env, rule: RuleRow): Promise<RuleMatch[]> {
  const re = safeRegex(rule.pattern, rule.flags)
  const catRe = rule.category_pattern ? safeRegex(rule.category_pattern, 'i') : null
  const sourceIds = jsonArr(rule.source_ids)
  const where = sourceIds ? `AND source_id IN (${sourceIds.map(() => '?').join(',')})` : ''
  const { results } = await env.DB.prepare(
    `SELECT id, name, category_name, logo FROM source_channels WHERE removed_at IS NULL ${where}`,
  )
    .bind(...(sourceIds ?? []))
    .all<{ id: string; name: string; category_name: string | null; logo: string | null }>()

  const durMs = rule.default_duration_minutes * 60_000
  const out: RuleMatch[] = []
  for (const sc of results) {
    if (catRe && !catRe.test(sc.category_name ?? '')) continue
    const m = re.exec(sc.name)
    if (!m) continue
    const g = m.groups ?? {}
    const dateText = [g.date, g.time].filter(Boolean).join(' ') || sc.name
    const parsed = parseEventDate(dateText, rule.timezone)
    if (rule.require_date && !parsed?.hasDate) continue
    const clean = defaultEventTitle(sc.name)
    const title = rule.title_template
      ? fill(rule.title_template, { ...g, name: sc.name, clean, category: sc.category_name ?? '' })
      : g.title?.trim() || clean
    // idle placeholders like "PPV 02" / "NFL 05" carry no event
    if (title.length < 3 || /^[A-Za-z+]{2,12}\s*\d{1,3}$/.test(title.trim())) continue
    out.push({
      dedupeKey: `r:${rule.id}:sc:${sc.id}:${(await sha256Hex(title)).slice(0, 10)}`,
      title,
      description: null,
      image: sc.logo,
      startsAt: parsed?.start ?? null,
      endsAt: parsed ? parsed.start + durMs : null,
      matchedText: sc.name,
      sourceChannelId: sc.id,
      lineupChannelIds: [],
    })
  }
  return out
}

async function matchProgrammes(env: Env, rule: RuleRow): Promise<RuleMatch[]> {
  const re = safeRegex(rule.pattern, rule.flags)
  const cats = jsonArr(rule.lineup_category_ids)
  const now = Date.now()
  const where = cats ? `AND lc.category_id IN (${cats.map(() => '?').join(',')})` : ''
  const { results } = await env.DB.prepare(
    `SELECT p.epg_source_id, p.xmltv_id, p.start, p.stop, p.title, p.subtitle, p.description, p.category, p.icon,
            group_concat(lc.id) AS channel_ids
     FROM programmes p
     JOIN lineup_channels lc ON lc.epg_source_id = p.epg_source_id AND lc.epg_channel_id = p.xmltv_id AND lc.enabled = 1
     WHERE p.stop > ? AND p.start < ? ${where}
     GROUP BY p.epg_source_id, p.xmltv_id, p.start`,
  )
    .bind(now - 6 * 3600_000, now + epgDays(env) * 86400_000, ...(cats ?? []))
    .all<{
      epg_source_id: string
      xmltv_id: string
      start: number
      stop: number
      title: string
      subtitle: string | null
      description: string | null
      category: string | null
      icon: string | null
      channel_ids: string
    }>()

  const out: RuleMatch[] = []
  for (const p of results) {
    const text = p.subtitle ? `${p.title} - ${p.subtitle}` : p.title
    const m = re.exec(text)
    if (!m) continue
    const g = m.groups ?? {}
    const title = rule.title_template
      ? fill(rule.title_template, { ...g, programme: p.title, subtitle: p.subtitle ?? '', category: p.category ?? '' })
      : g.title?.trim() || text
    out.push({
      dedupeKey: `r:${rule.id}:p:${p.epg_source_id}:${p.xmltv_id}:${p.start}`,
      title,
      description: p.description,
      image: p.icon,
      startsAt: p.start,
      endsAt: p.stop,
      matchedText: text,
      lineupChannelIds: p.channel_ids.split(','),
    })
  }
  return out
}

export async function getRule(env: Env, id: string) {
  return env.DB.prepare('SELECT * FROM event_rules WHERE id = ?').bind(id).first<RuleRow>()
}

/** Dry run: what would this rule produce right now? */
export async function previewRule(env: Env, rule: RuleRow) {
  return rule.kind === 'epg_programme' ? matchProgrammes(env, rule) : matchSourceChannels(env, rule)
}

async function nextChannelNumber(env: Env) {
  const r = await env.DB.prepare('SELECT MAX(number) AS n FROM lineup_channels').first<{ n: number | null }>()
  return Math.floor(r?.n ?? 0) + 1
}

/** Apply one rule: upsert events, maintain auto channels, delete stale unlocked events. */
export async function runRule(env: Env, rule: RuleRow) {
  const matches = await previewRule(env, rule)
  const now = Date.now()
  const stmts: D1PreparedStatement[] = []
  let channelsChanged = false

  // source_channel rules: resolve lineup channels for each matched upstream stream
  if (rule.kind === 'source_channel') {
    const { results: links } = await env.DB.prepare(
      `SELECT ls.source_channel_id, lc.id, lc.rule_id, lc.locked, lc.name
       FROM lineup_streams ls JOIN lineup_channels lc ON lc.id = ls.lineup_channel_id`,
    ).all<{ source_channel_id: string; id: string; rule_id: string | null; locked: number; name: string }>()
    const bySc = new Map<string, typeof links>()
    for (const l of links) bySc.set(l.source_channel_id, [...(bySc.get(l.source_channel_id) ?? []), l])

    let nextNum: number | null = null
    for (const m of matches) {
      const existing = bySc.get(m.sourceChannelId!) ?? []
      m.lineupChannelIds = existing.map((e) => e.id)
      const own = existing.find((e) => e.rule_id === rule.id)
      if (rule.auto_add_channel) {
        if (own) {
          if (!own.locked && own.name !== m.title) {
            stmts.push(
              env.DB.prepare('UPDATE lineup_channels SET name = ?, logo = COALESCE(logo, ?), updated_at = ? WHERE id = ?').bind(
                m.title, m.image, now, own.id,
              ),
            )
            channelsChanged = true
          }
        } else if (!existing.length) {
          nextNum ??= await nextChannelNumber(env)
          const id = newId('ch')
          stmts.push(
            env.DB.prepare(
              `INSERT INTO lineup_channels (id, number, name, category_id, logo, kind, hide_when_idle, enabled, rule_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'event', 1, 1, ?, ?, ?)`,
            ).bind(id, nextNum++, m.title, rule.target_category_id, m.image, rule.id, now, now),
            env.DB.prepare('INSERT INTO lineup_streams (lineup_channel_id, source_channel_id, priority) VALUES (?, ?, 0)').bind(
              id, m.sourceChannelId!,
            ),
          )
          m.lineupChannelIds = [id]
          channelsChanged = true
        }
      }
    }
  }

  for (const m of matches) {
    const id = newId('ev')
    stmts.push(
      env.DB.prepare(
        `INSERT INTO events (id, title, description, sport, league, image, starts_at, ends_at, origin, rule_id, dedupe_key, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rule', ?, ?, ?, ?, ?)
         ON CONFLICT(dedupe_key) DO UPDATE SET
           title = excluded.title, description = COALESCE(excluded.description, events.description),
           sport = excluded.sport, league = excluded.league, image = COALESCE(events.image, excluded.image),
           starts_at = excluded.starts_at, ends_at = excluded.ends_at, metadata = excluded.metadata, updated_at = excluded.updated_at
         WHERE events.locked = 0`,
      ).bind(
        id, m.title, m.description, rule.sport, rule.league, m.image, m.startsAt, m.endsAt, rule.id, m.dedupeKey,
        JSON.stringify({ matchedText: m.matchedText, sourceChannelId: m.sourceChannelId ?? null }), now, now,
      ),
      // relink channels for unlocked events
      env.DB.prepare(
        `DELETE FROM event_channels WHERE event_id = (SELECT id FROM events WHERE dedupe_key = ? AND locked = 0)`,
      ).bind(m.dedupeKey),
    )
    m.lineupChannelIds.forEach((chId, i) => {
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO event_channels (event_id, lineup_channel_id, priority)
           SELECT id, ?, ? FROM events WHERE dedupe_key = ? AND locked = 0`,
        ).bind(chId, i, m.dedupeKey),
      )
    })
  }

  await batchRun(env, stmts)

  // remove stale, unlocked events produced by this rule
  const keys = matches.map((m) => m.dedupeKey)
  await env.DB.prepare(
    `DELETE FROM events WHERE rule_id = ?1 AND locked = 0
       AND dedupe_key NOT IN (SELECT value FROM json_each(?2))`,
  )
    .bind(rule.id, JSON.stringify(keys))
    .run()

  // auto channels whose upstream stream vanished
  if (rule.auto_add_channel) {
    const del = await env.DB.prepare(
      `DELETE FROM lineup_channels WHERE rule_id = ? AND locked = 0 AND id NOT IN (
         SELECT ls.lineup_channel_id FROM lineup_streams ls
         JOIN source_channels sc ON sc.id = ls.source_channel_id WHERE sc.removed_at IS NULL)`,
    )
      .bind(rule.id)
      .run()
    if (del.meta.changes) channelsChanged = true
  }

  await env.DB.prepare('UPDATE event_rules SET last_run_at = ?, last_run_matches = ? WHERE id = ?')
    .bind(now, matches.length, rule.id)
    .run()
  if (channelsChanged) await bumpVersion(env, 'lineup_version')
  await bumpVersion(env, 'events_version')
  return { ruleId: rule.id, matches: matches.length }
}

export async function runAllRules(env: Env) {
  const { results } = await env.DB.prepare('SELECT * FROM event_rules WHERE enabled = 1').all<RuleRow>()
  const out: { ruleId: string; matches?: number; error?: string }[] = []
  for (const r of results) {
    try {
      out.push(await runRule(env, r))
    } catch (e) {
      out.push({ ruleId: r.id, error: e instanceof Error ? e.message : String(e) })
    }
  }
  // prune rule events that ended over a day ago
  await env.DB.prepare(`DELETE FROM events WHERE origin = 'rule' AND locked = 0 AND ends_at IS NOT NULL AND ends_at < ?`)
    .bind(Date.now() - 24 * 3600_000)
    .run()
  return out
}
