/** Minimal Xtream Codes player_api client (live TV only). */

export type XtreamCreds = {
  baseUrl: string
  username: string
  password: string
  userAgent?: string | null
}

export type XtreamCategory = { category_id: string; category_name: string; parent_id?: number }

export type XtreamLiveStream = {
  num?: number
  name: string
  stream_type?: string
  stream_id: number
  stream_icon?: string | null
  epg_channel_id?: string | null
  added?: string
  category_id?: string | null
  category_ids?: number[]
  tv_archive?: number
  direct_source?: string
}

export type XtreamAccount = {
  user_info?: {
    username?: string
    status?: string
    exp_date?: string | null
    is_trial?: string
    active_cons?: string | number
    max_connections?: string | number
    auth?: number
    message?: string
  }
  server_info?: Record<string, unknown>
}

export function normalizeBaseUrl(url: string) {
  let u = url.trim()
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`
  // tolerate people pasting a full player_api.php / get.php URL
  u = u.replace(/\/(player_api|get|xmltv)\.php.*$/i, '')
  return u.replace(/\/+$/, '')
}

export class XtreamClient {
  constructor(private creds: XtreamCreds) {}

  private get base() {
    return normalizeBaseUrl(this.creds.baseUrl)
  }

  private headers() {
    return { 'user-agent': this.creds.userAgent || 'IPTVSmartersPro', accept: 'application/json' }
  }

  private apiUrl(action?: string, extra: Record<string, string> = {}) {
    const u = new URL(`${this.base}/player_api.php`)
    u.searchParams.set('username', this.creds.username)
    u.searchParams.set('password', this.creds.password)
    if (action) u.searchParams.set('action', action)
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v)
    return u.toString()
  }

  private async get<T>(action?: string, extra?: Record<string, string>): Promise<T> {
    const res = await fetch(this.apiUrl(action, extra), { headers: this.headers() })
    if (!res.ok) throw new Error(`Xtream ${action ?? 'auth'} failed: HTTP ${res.status}`)
    const text = await res.text()
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(`Xtream ${action ?? 'auth'} returned non-JSON: ${text.slice(0, 120)}`)
    }
  }

  async account(): Promise<XtreamAccount> {
    const info = await this.get<XtreamAccount>()
    if (!info?.user_info || info.user_info.auth === 0) {
      throw new Error(info?.user_info?.message || 'Authentication failed')
    }
    return info
  }

  async liveCategories() {
    const r = await this.get<XtreamCategory[] | null>('get_live_categories')
    return Array.isArray(r) ? r : []
  }

  async liveStreams() {
    const r = await this.get<XtreamLiveStream[] | null>('get_live_streams')
    return Array.isArray(r) ? r : []
  }

  xmltvUrl() {
    const u = new URL(`${this.base}/xmltv.php`)
    u.searchParams.set('username', this.creds.username)
    u.searchParams.set('password', this.creds.password)
    return u.toString()
  }

  streamUrl(streamId: number, format: string) {
    const ext = format === 'm3u8' ? 'm3u8' : 'ts'
    return `${this.base}/live/${encodeURIComponent(this.creds.username)}/${encodeURIComponent(this.creds.password)}/${streamId}.${ext}`
  }
}
