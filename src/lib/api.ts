import type { z } from 'zod'
import type * as S from '@/server/api/schemas'

export type Source = z.infer<typeof S.Source>
export type SourceChannel = z.infer<typeof S.SourceChannel>
export type EpgSource = z.infer<typeof S.EpgSource>
export type EpgChannel = z.infer<typeof S.EpgChannel>
export type Programme = z.infer<typeof S.Programme>
export type Category = z.infer<typeof S.Category>
export type LineupChannel = z.infer<typeof S.LineupChannel>
export type LineupChannelPatch = z.infer<typeof S.LineupChannelPatch>
export type Event = z.infer<typeof S.Event>
export type Rule = z.infer<typeof S.Rule>
export type Token = z.infer<typeof S.Token>
export type Page<T> = { items: T[]; total: number; limit: number; offset: number }

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined' && !location.pathname.startsWith('/login')) {
      location.href = `/login?next=${encodeURIComponent(location.pathname)}`
    }
    const issues = data?.issues?.map((i: { path: string[]; message: string }) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new ApiError(res.status, issues ? `${data.error}: ${issues}` : (data?.error ?? res.statusText))
  }
  return data as T
}

export const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v))
  const s = u.toString()
  return s ? `?${s}` : ''
}

export function fmtTime(ms: number | null | undefined) {
  if (!ms) return '—'
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function fmtAgo(ms: number | null | undefined) {
  if (!ms) return 'never'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
