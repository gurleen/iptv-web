import { describe, expect, it } from 'vitest'
import { describeHttpError } from '../src/server/lib/http-errors'

const URL_ = 'http://line.example.tv:8080/player_api.php?username=bob&password=s3cret'

describe('describeHttpError', () => {
  it('detects a Cloudflare challenge', async () => {
    const res = new Response('<html><title>Just a moment...</title></html>', {
      status: 403,
      headers: { server: 'cloudflare', 'cf-ray': 'abc-LHR', 'cf-mitigated': 'challenge', 'content-type': 'text/html' },
    })
    const e = await describeHttpError('Xtream login', URL_, res, ['bob', 's3cret'])
    expect(e.message).toContain('HTTP 403 from http://line.example.tv:8080')
    expect(e.message).toContain('bot challenge')
    expect(e.message).toContain('cf-ray: abc-LHR')
  })

  it('flags a plain 403 as a likely IP block and redacts credentials', async () => {
    const res = new Response('Forbidden for bob / s3cret', { status: 403, headers: { server: 'nginx' } })
    const e = await describeHttpError('Xtream login', URL_, res, ['bob', 's3cret'])
    expect(e.message).toContain('IP block')
    expect(e.message).toContain('server: nginx')
    expect(e.message).not.toContain('s3cret')
    expect(e.message).not.toContain('bob')
  })
})
