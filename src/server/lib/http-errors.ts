import { directFetcher, type UpstreamFetcher } from './upstream'

/**
 * Turn a failed upstream response into an actionable message. Upstream IPTV providers often
 * block Cloudflare/datacenter IPs, so we try to say *who* rejected the request.
 * Never includes the request URL's query string (it carries credentials).
 */
export async function describeHttpError(label: string, url: string, res: Response, secrets: string[] = []) {
  const u = new URL(url)
  const target = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`
  const server = res.headers.get('server')
  const ctype = res.headers.get('content-type')
  const cfRay = res.headers.get('cf-ray')
  const mitigated = res.headers.get('cf-mitigated')

  let body = ''
  try {
    body = (await res.text()).slice(0, 4000)
  } catch {}
  const text = body
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  let snippet = text.slice(0, 200)
  for (const s of secrets) if (s) snippet = snippet.split(s).join('***')

  let diagnosis: string
  if (mitigated === 'challenge' || /just a moment|attention required|cf-chl|challenge-platform/i.test(body)) {
    diagnosis = "The provider is behind Cloudflare and served a bot challenge — its firewall is blocking requests from Workers. Try setting this source to fetch via browser."
  } else if (cfRay || /cloudflare/i.test(server ?? '')) {
    diagnosis = "The provider is behind Cloudflare and it rejected the request (common for Worker traffic). Try setting this source to fetch via browser."
  } else if (res.status === 403 || res.status === 401) {
    diagnosis = (res.status === 401 ? 'Rejected credentials or ' : 'Likely ') +
      'an IP block: many providers refuse datacenter/Cloudflare IPs. Try setting this source to fetch via browser.'
  } else if (res.status === 404) {
    diagnosis = 'Endpoint not found — check the server URL (and port).'
  } else if (res.status >= 500) {
    diagnosis = 'The provider returned a server error; it may be down or overloaded.'
  } else {
    diagnosis = 'Unexpected response from the provider.'
  }

  const details = [
    `server: ${server ?? 'n/a'}`,
    cfRay ? `cf-ray: ${cfRay}` : null,
    `content-type: ${ctype ?? 'n/a'}`,
    snippet ? `body: "${snippet}${text.length > 200 ? '…' : ''}"` : 'body: (empty)',
  ]
    .filter(Boolean)
    .join('; ')

  return new Error(`${label} failed: HTTP ${res.status} from ${target}. ${diagnosis} [${details}]`)
}

/** fetch() wrapper that turns network failures into readable errors (without leaking credentials). */
export async function fetchUpstream(
  label: string,
  url: string,
  init: { headers?: Record<string, string> },
  fetcher: UpstreamFetcher = directFetcher,
) {
  try {
    return await fetcher.fetch(url, init)
  } catch (e) {
    const u = new URL(url)
    throw new Error(
      `${label} failed: could not connect to ${u.protocol}//${u.host} (${e instanceof Error ? e.message : String(e)}). ` +
        'Check the server URL/port; some providers also drop connections from datacenter IPs.',
    )
  }
}
