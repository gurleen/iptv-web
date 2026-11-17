import { Buffer } from 'node:buffer'
import puppeteer, { type Browser, type Page } from '@cloudflare/puppeteer'

/**
 * How we reach a provider. Most providers accept plain Worker fetch(); some block Worker traffic
 * (they key on the CF-Worker header), but still accept Cloudflare's headless browser.
 */
export interface UpstreamFetcher {
  fetch(url: string, init?: { headers?: Record<string, string> }): Promise<Response>
  close(): Promise<void>
}

export type FetchMode = 'direct' | 'browser'

export const directFetcher: UpstreamFetcher = {
  fetch: (url, init) => fetch(url, { headers: init?.headers }),
  close: async () => {},
}

/** Compressed bytes pulled from the page per CDP round trip (~1.4MB of base64 per message). */
const CHUNK = 1024 * 1024

/**
 * Fetches through a Browser Rendering session. The page navigates to the provider's origin and runs
 * fetch() there (same-origin, so no CORS), gzips the body in the page (XMLTV/JSON shrink ~10x), and we
 * pull it back in chunks, decoding base64 natively and gunzipping as a stream. Big EPG files never sit
 * in Worker memory at once, and the Worker does very little CPU work per byte.
 */
export class BrowserFetcher implements UpstreamFetcher {
  private browser: Browser | null = null
  private page: Page | null = null
  private origin: string | null = null
  private userAgent: string

  constructor(
    private env: Env,
    userAgent?: string | null,
  ) {
    this.userAgent = userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
  }

  private async pageFor(target: URL) {
    if (!this.browser) {
      if (!this.env.BROWSER) throw new Error('Browser Rendering binding (BROWSER) is not configured')
      this.browser = await puppeteer.launch(this.env.BROWSER, { keep_alive: 120_000 })
    }
    if (!this.page) {
      this.page = await this.browser.newPage()
      await this.page.setUserAgent(this.userAgent)
    }
    if (this.origin !== target.origin) {
      // Land on the provider's origin so the in-page fetch is same-origin. Errors (404 root,
      // download responses...) are fine as long as we end up on that host.
      await this.page.goto(`${target.origin}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
      this.origin = target.origin
    }
    return this.page
  }

  async fetch(url: string, init?: { headers?: Record<string, string> }): Promise<Response> {
    const target = new URL(url)
    const page = await this.pageFor(target)
    const headers = { ...(init?.headers ?? {}) }
    delete headers['user-agent'] // forbidden in page fetch; set via setUserAgent instead

    const meta = await page.evaluate(
      async (rawUrl: string, hdrs: Record<string, string>) => {
        const u = new URL(rawUrl)
        // http -> https redirects at the root put us on a different origin; follow the page's scheme
        if (location.hostname === u.hostname && location.protocol !== u.protocol) {
          u.protocol = location.protocol
          u.port = location.port
        }
        try {
          const r = await fetch(u.toString(), { headers: hdrs, credentials: 'omit' })
          const raw = await r.arrayBuffer()
          const gz = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
          ;(globalThis as any).__iptvBody = gz
          return { ok: true as const, status: r.status, headers: [...r.headers] as [string, string][], size: gz.byteLength, rawSize: raw.byteLength }
        } catch (e) {
          return { ok: false as const, error: String(e), page: location.href }
        }
      },
      url,
      headers,
    )
    if (!meta.ok) throw new Error(`browser fetch failed (${meta.error}; page at ${meta.page})`)

    let offset = 0
    const gzipped = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (offset >= meta.size) {
          controller.close()
          await page.evaluate(() => void delete (globalThis as any).__iptvBody).catch(() => {})
          return
        }
        const b64 = await page.evaluate(
          (start: number, len: number) => {
            const slice: Uint8Array = (globalThis as any).__iptvBody.subarray(start, start + len)
            let s = ''
            for (let i = 0; i < slice.length; i += 0x8000) s += String.fromCharCode(...slice.subarray(i, i + 0x8000))
            return btoa(s)
          },
          offset,
          CHUNK,
        )
        const bytes = new Uint8Array(Buffer.from(b64, 'base64'))
        offset += bytes.length
        controller.enqueue(bytes)
      },
    })
    const body = gzipped.pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>)
    // the page already decoded any Content-Encoding, so don't pass it on
    const h = new Headers(meta.headers.filter(([k]) => !/^(content-encoding|content-length|transfer-encoding)$/i.test(k)))
    return new Response(meta.status === 204 || meta.status === 304 ? null : body, { status: meta.status, headers: h })
  }

  async close() {
    await this.browser?.close().catch(() => {})
    this.browser = null
    this.page = null
    this.origin = null
  }
}

export function fetcherFor(env: Env, mode: string | null | undefined, userAgent?: string | null): UpstreamFetcher {
  return mode === 'browser' ? new BrowserFetcher(env, userAgent) : directFetcher
}
