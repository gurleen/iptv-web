import { describe, expect, it } from 'vitest'
import { parseEventDate, stripDateText } from '../src/server/lib/dates'
import { cleanChannelName, similarity } from '../src/server/lib/names'
import { parseXmltv, parseXmltvTime } from '../src/server/lib/xmltv'
import { defaultEventTitle } from '../src/server/events/rules'

const NOW = Date.UTC(2026, 10, 17, 18, 0) // 2026-11-17 13:00 ET

describe('cleanChannelName', () => {
  it.each([
    ['US: ESPN 2 FHD', 'ESPN 2'],
    ['|UK| Sky Sports Main Event ᴴᴰ', 'Sky Sports Main Event'],
    ['USA ➾ CNN (Backup)', 'CNN'],
    ['[CA] TSN 1 HD', 'TSN 1'],
    ['HBO', 'HBO'],
    ['A&E 4K', 'A&E'],
  ])('%s -> %s', (a, b) => expect(cleanChannelName(a)).toBe(b))

  it('scores similar names highly', () => {
    expect(similarity('ESPN 2', 'ESPN2.us')).toBeGreaterThan(0.8)
    expect(similarity('ESPN 2', 'CNN')).toBeLessThan(0.3)
  })
})

describe('parseEventDate', () => {
  it('parses M/D + 12h time + tz', () => {
    const r = parseEventDate('PPV 03: UFC 310 | Sat 12/07 10:00 PM ET', 'UTC', NOW)!
    expect(new Date(r.start).toISOString()).toBe('2026-12-08T03:00:00.000Z')
    expect(r.hasDate).toBe(true)
  })
  it('parses ISO date + 24h', () => {
    const r = parseEventDate('NFL 05 - Bears @ Packers (2026-11-22 13:00)', 'America/Chicago', NOW)!
    expect(new Date(r.start).toISOString()).toBe('2026-11-22T19:00:00.000Z')
  })
  it('parses month name and EDT', () => {
    const r = parseEventDate('Boxing: Canelo v Crawford - Sep 13 9PM EDT', 'UTC', Date.UTC(2026, 8, 1))!
    expect(new Date(r.start).toISOString()).toBe('2026-09-14T01:00:00.000Z')
  })
  it('rolls year for January events seen in December', () => {
    const r = parseEventDate('Event Jan 3 8pm ET', 'UTC', Date.UTC(2026, 11, 20))!
    expect(new Date(r.start).getUTCFullYear()).toBe(2027)
  })
  it('time only = today', () => {
    const r = parseEventDate('NBA: Lakers vs Celtics @ 7:30pm', 'America/New_York', NOW)!
    expect(new Date(r.start).toISOString()).toBe('2026-11-18T00:30:00.000Z')
    expect(r.hasDate).toBe(false)
  })
  it('returns null without date/time', () => {
    expect(parseEventDate('PPV 04', 'UTC', NOW)).toBeNull()
  })
  it('strips date text for titles', () => {
    expect(stripDateText('UFC 310 | Sat 12/07 10:00 PM ET')).toBe('UFC 310')
    expect(defaultEventTitle('PPV 03: UFC 310 Pantoja vs Asakura | Sat 12/07 10:00 PM ET')).toBe('UFC 310 Pantoja vs Asakura')
  })
})

describe('xmltv', () => {
  it('parses times with offsets', () => {
    expect(parseXmltvTime('20261117180000 +0100')).toBe(Date.UTC(2026, 10, 17, 17))
    expect(parseXmltvTime('20261117180000')).toBe(Date.UTC(2026, 10, 17, 18))
  })

  it('streams channels and programmes across chunk boundaries', async () => {
    const xml = `<?xml version="1.0"?><tv>
      <channel id="espn.us"><display-name>ESPN &amp; Co</display-name><icon src="http://x/e.png"/></channel>
      <channel id="cnn.us"><display-name>CNN</display-name></channel>
      <programme start="20261117180000 +0000" stop="20261117190000 +0000" channel="espn.us">
        <title lang="en">SportsCenter</title><desc><![CDATA[News & highlights]]></desc><category>Sports</category>
      </programme>
      <programme start="20261117180000 +0000" stop="20261117190000 +0000" channel="cnn.us"><title>News</title></programme>
    </tv>`
    const bytes = new TextEncoder().encode(xml)
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7))
        c.close()
      },
    })
    const chans: string[] = []
    const progs: { title: string; description: string | null }[] = []
    await parseXmltv(stream, {
      channel: (c) => void chans.push(`${c.id}=${c.displayName}`),
      wantProgramme: (id) => id === 'espn.us',
      programme: (p) => void progs.push(p),
    })
    expect(chans).toEqual(['espn.us=ESPN & Co', 'cnn.us=CNN'])
    expect(progs).toHaveLength(1)
    expect(progs[0].title).toBe('SportsCenter')
    expect(progs[0].description).toBe('News & highlights')
  })

  it('handles gzip input', async () => {
    const xml = '<tv><channel id="a"><display-name>A</display-name></channel></tv>'
    const gz = new Blob([xml]).stream().pipeThrough(new CompressionStream('gzip'))
    const chans: string[] = []
    await parseXmltv(gz as ReadableStream<Uint8Array>, { channel: (c) => void chans.push(c.id) })
    expect(chans).toEqual(['a'])
  })
})

describe('xmltv performance', () => {
  it('parses a large guide in linear time', async () => {
    const parts = ['<tv>']
    for (let c = 0; c < 500; c++) parts.push(`<channel id="c${c}"><display-name>C${c}</display-name></channel>`)
    for (let i = 0; i < 100_000; i++) {
      parts.push(`<programme start="20261117180000 +0000" stop="20261117190000 +0000" channel="c${i % 500}"><title>Show ${i}</title><desc>Some description text for the programme number ${i}</desc></programme>`)
    }
    parts.push('</tv>')
    const bytes = new TextEncoder().encode(parts.join('\n'))
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) {
        for (let i = 0; i < bytes.length; i += 65536) ctl.enqueue(bytes.slice(i, i + 65536))
        ctl.close()
      },
    })
    let n = 0
    const t0 = performance.now()
    await parseXmltv(stream, { wantProgramme: (id) => id === 'c1', programme: () => void n++ })
    const ms = performance.now() - t0
    expect(n).toBe(200)
    expect(ms).toBeLessThan(3000) // ~19MB; was quadratic before
  })
})
