import { newId, randomHex, sha256Hex } from './ids'

export type Scope = 'admin' | 'output'
export type AuthResult = { scope: Scope; via: 'session' | 'token' | 'env' } | null

const COOKIE = 'iptv_session'
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000

async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

function sessionSecret(env: Env) {
  const s = env.SESSION_SECRET || env.ADMIN_PASSWORD
  if (!s) throw new Error('SESSION_SECRET / ADMIN_PASSWORD not configured')
  return s
}

export function checkPassword(env: Env, password: string) {
  return !!env.ADMIN_PASSWORD && timingSafeEqual(password, env.ADMIN_PASSWORD)
}

export async function createSessionCookie(env: Env, secure: boolean) {
  const exp = Date.now() + SESSION_TTL_MS
  const value = `${exp}.${await hmac(sessionSecret(env), String(exp))}`
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`
}

export function clearSessionCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

function readCookie(req: Request, name: string) {
  const header = req.headers.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return null
}

export async function verifySession(env: Env, req: Request) {
  const raw = readCookie(req, COOKIE)
  if (!raw || !env.ADMIN_PASSWORD) return false
  const [exp, sig] = raw.split('.')
  if (!exp || !sig || Number(exp) < Date.now()) return false
  return timingSafeEqual(sig, await hmac(sessionSecret(env), exp))
}

/** Resolve the caller from (in order) session cookie, bearer header, or ?token= query. */
export async function authenticate(env: Env, req: Request): Promise<AuthResult> {
  if (await verifySession(env, req)) return { scope: 'admin', via: 'session' }

  const header = req.headers.get('authorization')
  let token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null
  token ??= new URL(req.url).searchParams.get('token')
  if (!token) return null

  if (env.API_TOKEN && timingSafeEqual(token, env.API_TOKEN)) return { scope: 'admin', via: 'env' }

  const hash = await sha256Hex(token)
  const row = await env.DB.prepare('SELECT id, scope FROM api_tokens WHERE token_hash = ?')
    .bind(hash)
    .first<{ id: string; scope: Scope }>()
  if (!row) return null
  // fire-and-forget usage stamp
  env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').bind(Date.now(), row.id).run().catch(() => {})
  return { scope: row.scope, via: 'token' }
}

export async function generateToken(env: Env, name: string, scope: Scope) {
  const token = `iptv_${scope === 'admin' ? 'a' : 'o'}_${randomHex(20)}`
  const id = newId('tok')
  await env.DB.prepare(
    'INSERT INTO api_tokens (id, name, scope, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, name, scope, await sha256Hex(token), token.slice(0, 12), Date.now())
    .run()
  return { id, token }
}
