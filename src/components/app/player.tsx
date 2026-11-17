import { Copy, Loader2, Maximize2, Minimize2, RotateCw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

export type PlayerChannel = { id: string; name: string; number: number | null; logo: string | null }
type Playback = { url: string; format: 'hls' | 'ts'; secure: boolean; channelName: string }
type Status = { kind: 'resolving' } | { kind: 'loading' } | { kind: 'playing' } | { kind: 'error'; message: string; url?: string }

const START_TIMEOUT_MS = 15_000

/**
 * Floating mini player. Asks the server for a browser-playable URL, then plays it with Safari's
 * native HLS, hls.js, or mpegts.js (for raw .ts), falling back from HLS to TS once.
 */
export function Player({ channel, nowTitle, onClose }: { channel: PlayerChannel; nowTitle?: string | null; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [status, setStatus] = useState<Status>({ kind: 'resolving' })
  const [large, setLarge] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    let cleanup = null as (() => void) | null
    const el = video.current!

    async function start(format: 'hls' | 'ts'): Promise<void> {
      setStatus({ kind: 'resolving' })
      const pb = await api<Playback>(`/viewer/channels/${channel.id}/play?format=${format}`)
      if (cancelled) return
      if (!pb.secure && location.protocol === 'https:') {
        throw Object.assign(new Error("The provider only serves this stream over plain http, which browsers won't play on an https page."), { url: pb.url })
      }
      setStatus({ kind: 'loading' })
      cleanup = await attach(el, pb)
      await waitForPlayback(el)
    }

    ;(async () => {
      try {
        await start('hls')
      } catch (e) {
        if (cancelled) return
        cleanup?.()
        cleanup = null
        // second chance with the raw MPEG-TS stream
        try {
          await start('ts')
        } catch (e2) {
          if (cancelled) return
          const err = (e2 instanceof Error ? e2 : e) as Error & { url?: string }
          setStatus({ kind: 'error', message: err.message || String(err), url: err.url })
          return
        }
      }
      if (!cancelled) setStatus({ kind: 'playing' })
    })()

    return () => {
      cancelled = true
      cleanup?.()
      el.removeAttribute('src')
      el.load()
    }
  }, [channel.id, attempt])

  return (
    <div
      className={cn(
        'fixed z-50 overflow-hidden rounded-lg border bg-background shadow-2xl',
        large ? 'inset-x-2 bottom-2 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[min(960px,calc(100vw-2rem))]' : 'inset-x-2 bottom-2 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[420px]',
      )}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        {channel.logo && <img src={channel.logo} alt="" className="size-6 shrink-0 object-contain" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {channel.number != null && <span className="mr-1.5 text-muted-foreground">{channel.number}</span>}
            {channel.name}
          </div>
          {nowTitle && <div className="truncate text-xs text-muted-foreground">{nowTitle}</div>}
        </div>
        <Button size="icon" variant="ghost" className="hidden size-8 sm:inline-flex" title={large ? 'Smaller' : 'Larger'} onClick={() => setLarge((v) => !v)}>
          {large ? <Minimize2 /> : <Maximize2 />}
        </Button>
        <Button size="icon" variant="ghost" className="size-8" title="Close" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="relative aspect-video bg-black">
        <video ref={video} className="size-full" controls autoPlay playsInline />
        {(status.kind === 'resolving' || status.kind === 'loading') && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-white/80">
            <Loader2 className="size-6 animate-spin" />
            {status.kind === 'resolving' ? 'Finding the stream…' : 'Buffering…'}
          </div>
        )}
        {status.kind === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/85 p-4 text-center text-sm text-white">
            <p className="max-w-sm">{status.message}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
                <RotateCw /> Retry
              </Button>
              {status.url && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => navigator.clipboard.writeText(status.url!).then(() => toast.success('Stream URL copied — open it in VLC'))}
                >
                  <Copy /> Copy URL
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Hook the stream up to the <video>. Returns a teardown function. */
async function attach(el: HTMLVideoElement, pb: Playback): Promise<() => void> {
  if (pb.format === 'hls') {
    const { default: Hls } = await import('hls.js')
    if (Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: false, backBufferLength: 30 })
      let mediaRecoveries = 0
      const failed = new Promise<never>((_, reject) => {
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 2) {
            hls.recoverMediaError()
            return
          }
          reject(new Error(describeHlsError(data.details, data.response?.code)))
        })
      })
      ;(el as any).__failed = failed
      hls.loadSource(pb.url)
      hls.attachMedia(el)
      return () => hls.destroy()
    }
    if (el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = pb.url // Safari / iOS
      return () => {}
    }
    throw new Error("This browser can't play HLS streams.")
  }

  const mpegts = (await import('mpegts.js')).default
  if (!mpegts.isSupported()) throw new Error("This browser can't play MPEG-TS streams.")
  const player = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: pb.url }, { enableStashBuffer: false, liveBufferLatencyChasing: true })
  ;(el as any).__failed = new Promise<never>((_, reject) => {
    player.on(mpegts.Events.ERROR, (type: string, detail: string) => reject(new Error(`Stream error: ${type} / ${detail}`)))
  })
  player.attachMediaElement(el)
  player.load()
  return () => {
    player.destroy()
  }
}

/** Resolve once frames are playing; reject on player error or after a timeout. */
function waitForPlayback(el: HTMLVideoElement) {
  const failed: Promise<never> | undefined = (el as any).__failed
  return Promise.race([
    new Promise<void>((resolve, reject) => {
      const onPlaying = () => (cleanup(), resolve())
      const onError = () => (cleanup(), reject(new Error(el.error?.message || 'The stream could not be decoded.')))
      const timer = setTimeout(() => (cleanup(), reject(new Error('The stream did not start in time.'))), START_TIMEOUT_MS)
      const cleanup = () => {
        clearTimeout(timer)
        el.removeEventListener('playing', onPlaying)
        el.removeEventListener('error', onError)
      }
      el.addEventListener('playing', onPlaying)
      el.addEventListener('error', onError)
      // autoplay with sound can be refused; fall back to muted so something shows
      el.play().catch(() => {
        el.muted = true
        el.play().catch(() => {})
      })
    }),
    ...(failed ? [failed] : []),
  ])
}

function describeHlsError(details: string, code?: number) {
  if (code === 403 || code === 401) return 'The provider refused the stream (HTTP ' + code + '). Your connection limit may be reached.'
  if (details.includes('manifestLoad') || details.includes('Network')) return `Couldn't load the stream (${details}${code ? `, HTTP ${code}` : ''}).`
  return `Playback failed (${details}).`
}
