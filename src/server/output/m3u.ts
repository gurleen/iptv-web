import { formatEventTime, loadEvents, loadOutputChannels, streamUrl } from './lineup'

const attr = (s: string | number | null | undefined) => String(s ?? '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ')
const title = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/,/g, '').replace(/\s{2,}/g, ' ').trim()

export type M3uOptions = {
  base: string
  token: string | null
  /** none = channels only, group = add an events group, only = events only */
  events: 'none' | 'group' | 'only'
  timezone: string
  eventsGroup: string
}

export async function buildM3u(env: Env, o: M3uOptions) {
  const tokenQ = o.token ? `?token=${encodeURIComponent(o.token)}` : ''
  const epg = `${o.base}/epg.xml${tokenQ}`
  const lines = [`#EXTM3U url-tvg="${epg}" x-tvg-url="${epg}"`]

  const channels = await loadOutputChannels(env)
  if (o.events !== 'only') {
    for (const c of channels) {
      lines.push(
        `#EXTINF:-1 tvg-id="${attr(c.tvgId)}" tvg-name="${attr(c.name)}" tvg-logo="${attr(c.logo)}"` +
          `${c.number != null ? ` tvg-chno="${c.number}" channel-number="${c.number}"` : ''}` +
          ` group-title="${attr(c.category ?? 'Uncategorized')}"${c.kind === 'event' ? ' x-channel-kind="event"' : ''},${title(c.name)}`,
        streamUrl(o.base, c, o.token),
      )
    }
  }

  if (o.events !== 'none') {
    const byId = new Map(channels.map((c) => [c.id, c]))
    const events = await loadEvents(env, { hoursAhead: 48 })
    for (const e of events) {
      const ch = e.channels.map((c) => byId.get(c.id)).find(Boolean)
      if (!ch) continue
      const when = e.status === 'live' ? 'LIVE' : formatEventTime(e.startsAt, o.timezone)
      const name = when ? `${e.title} (${when})` : e.title
      const group = e.sport ? `${o.eventsGroup}: ${e.sport}` : o.eventsGroup
      lines.push(
        `#EXTINF:-1 tvg-id="${attr(ch.tvgId)}" tvg-name="${attr(e.title)}" tvg-logo="${attr(e.image ?? ch.logo)}"` +
          ` group-title="${attr(group)}" x-event-id="${e.id}" x-event-status="${e.status}"` +
          `${e.startsAt ? ` x-event-start="${new Date(e.startsAt).toISOString()}"` : ''}` +
          `${e.endsAt ? ` x-event-end="${new Date(e.endsAt).toISOString()}"` : ''}` +
          `${e.league ? ` x-event-league="${attr(e.league)}"` : ''},${title(name)}`,
        streamUrl(o.base, ch, o.token),
      )
    }
  }
  return lines.join('\n') + '\n'
}
