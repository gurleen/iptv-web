import { describe, expect, it } from 'vitest'
import { upgradeToHttps } from '../src/server/output/playback'

describe('upgradeToHttps', () => {
  it('upgrades default-port http URLs', () => {
    expect(upgradeToHttps('http://cdn.example.com:80/live/play/abc/1')).toEqual({ url: 'https://cdn.example.com/live/play/abc/1', secure: true })
    expect(upgradeToHttps('http://cdn.example.com/x.m3u8')).toEqual({ url: 'https://cdn.example.com/x.m3u8', secure: true })
  })
  it('keeps https as is', () => {
    expect(upgradeToHttps('https://cdn.example.com:8443/x')).toEqual({ url: 'https://cdn.example.com:8443/x', secure: true })
  })
  it('cannot guess https for custom http ports', () => {
    expect(upgradeToHttps('http://1.2.3.4:8080/x').secure).toBe(false)
  })
})
