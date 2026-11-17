/**
 * Streaming XMLTV reader/writer. Never holds the whole document in memory, which matters
 * because provider EPGs are often 50-300MB and Workers have 128MB of RAM.
 */

export type XmltvChannel = { id: string; displayName: string | null; icon: string | null }
export type XmltvProgramme = {
  channel: string
  start: number
  stop: number
  title: string
  subtitle: string | null
  description: string | null
  category: string | null
  icon: string | null
  episode: string | null
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeEntities(s: string) {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

export function escapeXml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // strip characters that are illegal in XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

function stripCdata(s: string) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tag))) out[m[1]] = decodeEntities(m[3] ?? m[4] ?? '')
  return out
}

function childText(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml)
  if (!m) return null
  const v = decodeEntities(stripCdata(m[1])).trim()
  return v || null
}

function childAttr(xml: string, name: string, attr: string): string | null {
  const m = new RegExp(`<${name}\\s[^>]*>`, 'i').exec(xml)
  return m ? (attrs(m[0])[attr] ?? null) : null
}

/** "20261117180000 +0000" -> epoch ms. Missing offset = UTC. */
export function parseXmltvTime(s: string | undefined): number | null {
  if (!s) return null
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*([+-]\d{2}:?\d{2}|Z)?/.exec(s.trim())
  if (!m) return null
  const [, y, mo, d, h = '00', mi = '00', se = '00', tz] = m
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se)
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1
    const digits = tz.slice(1).replace(':', '')
    t -= sign * (+digits.slice(0, 2) * 60 + +digits.slice(2, 4)) * 60_000
  }
  return t
}

export function formatXmltvTime(ms: number) {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`
}

/** Transparently gunzip if the stream starts with the gzip magic bytes. */
export async function maybeGunzip(stream: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const reader = stream.getReader()
  const first = await reader.read()
  const head = first.value ?? new Uint8Array()
  const rest = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length) controller.enqueue(head)
      if (first.done) controller.close()
    },
    async pull(controller) {
      const { value, done } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  if (head[0] === 0x1f && head[1] === 0x8b) {
    return rest.pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>)
  }
  return rest
}

export type XmltvHandlers = {
  channel?: (c: XmltvChannel) => void | Promise<void>
  /** Return quickly - called for every programme in the file. */
  programme?: (p: XmltvProgramme) => void | Promise<void>
  /** Called with the raw channel attribute before full programme parsing; return false to skip. */
  wantProgramme?: (channelId: string) => boolean
}

export async function parseXmltv(stream: ReadableStream<Uint8Array>, h: XmltvHandlers) {
  const decoded = (await maybeGunzip(stream)).pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>)
  const reader = decoded.getReader()
  let buf = ''
  let done = false

  while (!done) {
    const r = await reader.read()
    if (r.done) done = true
    else buf += r.value

    let pos = 0
    // Cache the next-tag positions: re-scanning the rest of the buffer for '<channel' before every
    // programme made parsing quadratic (most files have no channels left after the header).
    let ci = buf.indexOf('<channel', pos)
    let pi = buf.indexOf('<programme', pos)
    for (;;) {
      if (ci !== -1 && ci < pos) ci = buf.indexOf('<channel', pos)
      if (pi !== -1 && pi < pos) pi = buf.indexOf('<programme', pos)
      if (ci === -1 && pi === -1) {
        // keep only a small tail in case a tag name is split across chunks
        pos = Math.max(pos, buf.length - 16)
        break
      }
      const isChannel = ci !== -1 && (pi === -1 || ci < pi)
      const start = isChannel ? ci : pi
      const name = isChannel ? 'channel' : 'programme'
      const openEnd = buf.indexOf('>', start)
      if (openEnd === -1) {
        pos = start
        break
      }
      const openTag = buf.slice(start, openEnd + 1)
      let end: number
      if (buf[openEnd - 1] === '/') end = openEnd + 1
      else {
        const close = buf.indexOf(`</${name}>`, openEnd)
        if (close === -1) {
          pos = start
          break
        }
        end = close + name.length + 3
      }
      const el = buf.slice(start, end)
      pos = end

      const a = attrs(openTag)
      if (isChannel) {
        if (h.channel && a.id) {
          await h.channel({
            id: a.id,
            displayName: childText(el, 'display-name'),
            icon: childAttr(el, 'icon', 'src'),
          })
        }
      } else if (h.programme && a.channel && (!h.wantProgramme || h.wantProgramme(a.channel))) {
        const s = parseXmltvTime(a.start)
        const e = parseXmltvTime(a.stop)
        const title = childText(el, 'title')
        if (s != null && title) {
          await h.programme({
            channel: a.channel,
            start: s,
            stop: e ?? s + 3600_000,
            title,
            subtitle: childText(el, 'sub-title'),
            description: childText(el, 'desc'),
            category: childText(el, 'category'),
            icon: childAttr(el, 'icon', 'src'),
            episode: childText(el, 'episode-num'),
          })
        }
      }
    }
    buf = buf.slice(pos)
  }
}
