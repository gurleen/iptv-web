import puppeteer from '@cloudflare/puppeteer'
import { describeHttpError } from '../lib/http-errors'
import { clientFor } from '../sync/sources'

/**
 * Work out a URL the *viewer's browser* can play for a lineup channel.
 *
 * Provider stream URLs are usually plain http and redirect (often more than once) to a CDN. A page
 * served over https can't follow a redirect to http, so we follow the chain here, stop at the final
 * host without downloading any video, and hand back that URL upgraded to https. The browser then
 * streams straight from the CDN.
 */
export type Playback = { url: string; format: 'hls' | 'ts'; secure: boolean; channelName: string }

type StreamRow = {
  name: string
  stream_id: number
  base_url: string
  username: string
  password: string
  user_agent: string | null
  stream_format: string
  fetch_mode: string
}

const MAX_HOPS = 6
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

/** http://host[:80]/x -> https://host/x. Non-default http ports can't be guessed, so they stay http. */
export function upgradeToHttps(raw: string) {
  const u = new URL(raw)
  if (u.protocol === 'https:') return { url: u.toString(), secure: true }
  if (!u.port || u.port === '80') {
    u.protocol = 'https:'
    u.port = ''
    return { url: u.toString(), secure: true }
  }
  return { url: u.toString(), secure: false }
}

async function resolveDirect(url: string, ua: string) {
  let current = url
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const res = await fetch(current, { redirect: 'manual', headers: { 'user-agent': ua } })
    const loc = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel()
      current = new URL(loc, current).toString()
      continue
    }
    if (!res.ok) throw await describeHttpError('Stream lookup', current, res)
    await res.body?.cancel()
    return current
  }
  return current
}

/** Same, but through Browser Rendering for providers that block Worker traffic. */
async function resolveViaBrowser(env: Env, url: string, ua: string) {
  const browser = await puppeteer.launch(env.BROWSER)
  try {
    const page = await browser.newPage()
    await page.setUserAgent(ua)
    await page.setRequestInterception(true)
    const providerHost = new URL(url).hostname
    let last = url
    let captured: string | null = null
    page.on('request', (req) => {
      const u = req.url()
      last = u
      // once the chain leaves the provider we have the CDN URL: stop before any video is fetched
      if (new URL(u).hostname !== providerHost) {
        captured = u
        req.abort().catch(() => {})
      } else {
        req.continue().catch(() => {})
      }
    })
    const response = await page.goto(url, { timeout: 20_000, waitUntil: 'domcontentloaded' }).catch(() => null)
    if (!captured && response && response.status() >= 400) {
      throw new Error(`Stream lookup failed: HTTP ${response.status()} from ${new URL(last).host}`)
    }
    return captured ?? last
  } finally {
    await browser.close().catch(() => {})
  }
}

export async function resolvePlayback(env: Env, channelId: string, format: 'hls' | 'ts'): Promise<Playback> {
  const { results } = await env.DB.prepare(
    `SELECT lc.name, sc.stream_id, s.base_url, s.username, s.password, s.user_agent, s.stream_format, s.fetch_mode
     FROM lineup_streams ls
     JOIN source_channels sc ON sc.id = ls.source_channel_id
     JOIN sources s ON s.id = sc.source_id
     JOIN lineup_channels lc ON lc.id = ls.lineup_channel_id
     WHERE ls.lineup_channel_id = ? AND s.enabled = 1
     ORDER BY sc.removed_at IS NOT NULL, ls.priority, s.priority`,
  )
    .bind(channelId)
    .all<StreamRow>()
  const pick = results[0]
  if (!pick) throw new Error('This channel has no working upstream stream')

  const providerUrl = clientFor(pick).streamUrl(pick.stream_id, format === 'hls' ? 'm3u8' : 'ts')
  const ua = pick.user_agent || UA
  const final = pick.fetch_mode === 'browser' ? await resolveViaBrowser(env, providerUrl, ua) : await resolveDirect(providerUrl, ua)
  const { url, secure } = upgradeToHttps(final)
  return { url, format, secure, channelName: pick.name }
}
