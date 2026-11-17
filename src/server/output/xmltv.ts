import { escapeXml, formatXmltvTime } from '../lib/xmltv'
import { epgDays } from '../sync/epg'
import { loadEvents, loadOutputChannels, outputVersion } from './lineup'
import { R2TextWriter } from './r2writer'

type Prog = {
  epg_source_id: string
  xmltv_id: string
  start: number
  stop: number
  title: string
  subtitle: string | null
  description: string | null
  category: string | null
  icon: string | null
  episode: string | null
}

function programmeXml(channel: string, p: Omit<Prog, 'epg_source_id' | 'xmltv_id'>) {
  let s = `<programme start="${formatXmltvTime(p.start)}" stop="${formatXmltvTime(p.stop)}" channel="${escapeXml(channel)}">`
  s += `<title>${escapeXml(p.title)}</title>`
  if (p.subtitle) s += `<sub-title>${escapeXml(p.subtitle)}</sub-title>`
  if (p.description) s += `<desc>${escapeXml(p.description)}</desc>`
  if (p.category) s += `<category>${escapeXml(p.category)}</category>`
  if (p.icon) s += `<icon src="${escapeXml(p.icon)}"/>`
  if (p.episode) s += `<episode-num system="onscreen">${escapeXml(p.episode)}</episode-num>`
  return s + '</programme>\n'
}

/** Generate the output XMLTV into R2. Returns the object key. */
async function generate(env: Env, key: string) {
  const w = new R2TextWriter(env.BUCKET, key, { httpMetadata: { contentType: 'application/xml; charset=utf-8' } })
  try {
    const channels = await loadOutputChannels(env)
    await w.write('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv generator-info-name="iptv-web">\n')
    for (const c of channels) {
      await w.write(
        `<channel id="${escapeXml(c.tvgId)}"><display-name>${escapeXml(c.name)}</display-name>` +
          `${c.number != null ? `<display-name>${c.number}</display-name>` : ''}` +
          `${c.logo ? `<icon src="${escapeXml(c.logo)}"/>` : ''}</channel>\n`,
      )
    }

    // guide data for mapped channels, fetched in batches of EPG keys
    const byKey = new Map<string, string[]>()
    for (const c of channels) {
      if (!c.epgSourceId || !c.epgChannelId) continue
      const k = `${c.epgSourceId}\u0000${c.epgChannelId}`
      byKey.set(k, [...(byKey.get(k) ?? []), c.tvgId])
    }
    const keys = [...byKey.keys()]
    const from = Date.now() - 12 * 3600_000
    const to = Date.now() + epgDays(env) * 86400_000
    for (let i = 0; i < keys.length; i += 40) {
      const batch = keys.slice(i, i + 40).map((k) => k.split('\u0000'))
      const { results } = await env.DB.prepare(
        `SELECT p.* FROM programmes p JOIN json_each(?1) j
           ON p.epg_source_id = j.value ->> '$[0]' AND p.xmltv_id = j.value ->> '$[1]'
         WHERE p.stop > ?2 AND p.start < ?3 ORDER BY p.epg_source_id, p.xmltv_id, p.start`,
      )
        .bind(JSON.stringify(batch), from, to)
        .all<Prog>()
      let chunk = ''
      for (const p of results) {
        for (const tvgId of byKey.get(`${p.epg_source_id}\u0000${p.xmltv_id}`) ?? []) chunk += programmeXml(tvgId, p)
      }
      await w.write(chunk)
    }

    // event channels without their own EPG get synthesized listings from events
    const eventChannels = new Map(channels.filter((c) => !c.epgChannelId).map((c) => [c.id, c]))
    if (eventChannels.size) {
      const events = await loadEvents(env)
      let chunk = ''
      for (const e of events) {
        if (e.startsAt == null) continue
        for (const ec of e.channels) {
          const c = eventChannels.get(ec.id)
          if (!c) continue
          chunk += programmeXml(c.tvgId, {
            start: e.startsAt,
            stop: e.endsAt ?? e.startsAt + 3 * 3600_000,
            title: e.title,
            subtitle: e.subtitle,
            description: e.description,
            category: e.sport,
            icon: e.image,
            episode: null,
          })
        }
      }
      await w.write(chunk)
    }
    await w.write('</tv>\n')
    await w.close()
  } catch (e) {
    await w.abort()
    throw e
  }
}

/** Return the cached XMLTV object for the current output version, generating it if needed. */
export async function getOutputXmltv(env: Env) {
  const version = await outputVersion(env)
  // also roll the cache every 30 min so the time window advances
  const slot = Math.floor(Date.now() / (30 * 60_000))
  const key = `output/epg-${version}-${slot}.xml`
  let obj = await env.BUCKET.get(key)
  if (!obj) {
    await generate(env, key)
    obj = await env.BUCKET.get(key)
    // clean up older generations
    const list = await env.BUCKET.list({ prefix: 'output/epg-' })
    const stale = list.objects.map((o) => o.key).filter((k) => k !== key)
    if (stale.length) await env.BUCKET.delete(stale)
  }
  if (!obj) throw new Error('failed to generate EPG')
  return obj
}
