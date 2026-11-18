import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight, Clock, Play, Trophy } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Empty, PageHeader } from '@/components/app/page-header'
import { Player } from '@/components/app/player'
import { GameChip } from '@/components/app/game-chip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api, qs, type Game } from '@/lib/api'
import { cn } from '@/lib/utils'

type Programme = {
  start: number
  stop: number
  title: string
  subtitle: string | null
  description: string | null
  category: string | null
  icon: string | null
  episode: string | null
  eventId: string | null
}
type GuideChannel = { id: string; number: number | null; name: string; logo: string | null; kind: 'linear' | 'event'; hasEpg: boolean; programmes: Programme[] }
type GuideCategory = { id: string | null; name: string; channelCount: number }

export const Route = createFileRoute('/_app/guide')({
  validateSearch: (s: Record<string, unknown>) => ({
    cat: typeof s.cat === 'string' ? s.cat : undefined,
    day: typeof s.day === 'number' ? s.day : Number(s.day) || undefined,
  }),
  component: Guide,
})

const PPM = 4 // pixels per minute
const ROW = 60
const HOUR = 3600_000
const DAY = 24 * HOUR

const x = (ms: number, from: number) => ((ms - from) / 60_000) * PPM
const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

function startOfDay(offsetDays: number) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + offsetDays)
  return d.getTime()
}

function useNarrow() {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const on = () => setNarrow(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return narrow
}

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

function Guide() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const day = search.day ?? 0
  const now = useNow()
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<{ p: Programme; ch: GuideChannel } | null>(null)
  const [playing, setPlaying] = useState<GuideChannel | null>(null)
  const linkedGame = useQuery({
    queryKey: ['event-game', selected?.p.eventId],
    queryFn: () => api<{ game?: Game | null }>(`/events/${selected!.p.eventId}?withGame=true`),
    enabled: !!selected?.p.eventId,
    select: (e) => e.game ?? null,
  })
  const scroller = useRef<HTMLDivElement>(null)
  const narrow = useNarrow()
  const LEFT = narrow ? 120 : 220 // channel column width

  const cats = useQuery({ queryKey: ['viewer-categories'], queryFn: () => api<{ categories: GuideCategory[]; epgDays: number }>('/viewer/categories') })
  const catKey = (c: GuideCategory) => c.id ?? 'none'
  const activeCat = search.cat ?? (cats.data?.categories[0] ? catKey(cats.data.categories[0]) : undefined)

  const from = startOfDay(day)
  const to = from + DAY
  const guide = useQuery({
    queryKey: ['viewer-guide', activeCat, from],
    queryFn: () => api<{ from: number; to: number; channels: GuideChannel[] }>(`/viewer/guide${qs({ categoryId: activeCat, from, to })}`),
    enabled: !!activeCat,
    placeholderData: keepPreviousData,
    refetchInterval: 5 * 60_000,
  })

  const channels = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const list = guide.data?.channels ?? []
    return f ? list.filter((c) => c.name.toLowerCase().includes(f) || String(c.number ?? '').startsWith(f)) : list
  }, [guide.data, filter])

  const width = x(to, from)
  const nowX = x(now, from)
  const showNow = now >= from && now < to

  // jump to "now" (or the start of the day) when the category or day changes
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !guide.data) return
    el.scrollLeft = showNow ? Math.max(0, nowX - 30 * PPM) : 0
  }, [activeCat, from, !!guide.data, narrow]) // eslint-disable-line react-hooks/exhaustive-deps

  const scrollBy = (hours: number) => scroller.current?.scrollBy({ left: hours * 60 * PPM, behavior: 'smooth' })
  const jumpNow = () => {
    if (day !== 0) navigate({ search: (s) => ({ ...s, day: undefined }) })
    else scroller.current?.scrollTo({ left: Math.max(0, nowX - 30 * PPM), behavior: 'smooth' })
  }

  const days = Array.from({ length: Math.max(1, cats.data?.epgDays ?? 3) }, (_, i) => i)
  const ticks = Array.from({ length: 48 }, (_, i) => from + i * 30 * 60_000)

  return (
    <>
      <PageHeader title="Guide" description="Your output lineup as players see it, category by category." />

      {cats.data && !cats.data.categories.length ? (
        <Empty>Nothing in the output yet. Add channels to your lineup first.</Empty>
      ) : (
        <>
          <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
            {cats.data?.categories.map((c) => (
              <button
                key={catKey(c)}
                onClick={() => navigate({ search: (s) => ({ ...s, cat: catKey(c) }) })}
                className={cn(
                  'shrink-0 rounded-full border px-3 py-1 text-sm transition-colors',
                  activeCat === catKey(c) ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
                )}
              >
                {c.name} <span className="opacity-60">{c.channelCount}</span>
              </button>
            ))}
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="flex gap-1">
              {days.map((d) => (
                <Button
                  key={d}
                  size="sm"
                  variant={d === day ? 'default' : 'outline'}
                  onClick={() => navigate({ search: (s) => ({ ...s, day: d || undefined }) })}
                >
                  {d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : new Date(startOfDay(d)).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                </Button>
              ))}
            </div>
            <Button size="sm" variant="outline" onClick={jumpNow}>
              <Clock /> Now
            </Button>
            <Button size="icon" variant="outline" className="size-8" onClick={() => scrollBy(-3)} title="Back 3 hours">
              <ChevronLeft />
            </Button>
            <Button size="icon" variant="outline" className="size-8" onClick={() => scrollBy(3)} title="Forward 3 hours">
              <ChevronRight />
            </Button>
            <Input className="ml-auto h-8 w-52" placeholder="Filter channels…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>

          <div ref={scroller} className="relative h-[calc(100vh-260px)] min-h-96 overflow-auto rounded-lg border">
            <div style={{ width: LEFT + width }} className="relative">
              {/* time header */}
              <div className="sticky top-0 z-30 flex h-9 border-b bg-background">
                <div style={{ width: LEFT }} className="sticky left-0 z-10 shrink-0 border-r bg-background" />
                <div className="relative" style={{ width }}>
                  {ticks.map((t) => (
                    <div key={t} className="absolute top-0 flex h-full items-center border-l pl-1.5 text-xs text-muted-foreground" style={{ left: x(t, from), width: 30 * PPM }}>
                      {fmtClock(t)}
                    </div>
                  ))}
                </div>
              </div>

              {/* rows */}
              <div className="relative">
                {showNow && (
                  <div className="pointer-events-none absolute top-0 bottom-0 z-20 w-0.5 bg-red-500" style={{ left: LEFT + nowX }}>
                    <div className="absolute -top-1 -left-1 size-2.5 rounded-full bg-red-500" />
                  </div>
                )}
                {channels.map((ch) => (
                  <div key={ch.id} className="flex border-b last:border-b-0" style={{ height: ROW }}>
                    <button
                      type="button"
                      onClick={() => setPlaying(ch)}
                      title={`Watch ${ch.name}`}
                      style={{ width: LEFT }}
                      className={cn(
                        'group sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r bg-background px-2 text-left hover:bg-accent',
                        playing?.id === ch.id && 'bg-accent',
                      )}
                    >
                      <span className="relative w-7 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:w-9">
                        <span className={cn('group-hover:invisible', playing?.id === ch.id && 'invisible')}>{ch.number ?? ''}</span>
                        <Play
                          className={cn(
                            'absolute top-1/2 right-0 size-4 -translate-y-1/2 fill-current text-foreground',
                            playing?.id === ch.id ? 'visible text-red-500' : 'invisible group-hover:visible',
                          )}
                        />
                      </span>
                      <div className="hidden size-9 shrink-0 items-center justify-center overflow-hidden rounded bg-muted/50 sm:flex">
                        {ch.logo ? <img src={ch.logo} alt="" className="max-h-full max-w-full object-contain" loading="lazy" /> : null}
                      </div>
                      <span className="min-w-0 truncate text-sm font-medium">{ch.name}</span>
                    </button>
                    <div className="relative" style={{ width }}>
                      {ch.programmes.length === 0 && (
                        <div className="absolute inset-y-1 left-1 right-1 flex items-center rounded-md border border-dashed text-xs text-muted-foreground">
                          {/* sticky so the label stays visible however far the row is scrolled */}
                          <span className="sticky px-3" style={{ left: LEFT }}>
                            {ch.hasEpg ? 'No guide data for this day' : ch.kind === 'event' ? 'No scheduled events' : 'No EPG mapped'}
                          </span>
                        </div>
                      )}
                      {ch.programmes.map((p) => {
                        const left = Math.max(0, x(p.start, from))
                        const right = Math.min(width, x(p.stop, from))
                        const live = now >= p.start && now < p.stop
                        const past = p.stop <= now
                        return (
                          <button
                            key={`${p.start}-${p.eventId ?? ''}`}
                            onClick={() => setSelected({ p, ch })}
                            className={cn(
                              'absolute inset-y-1 overflow-hidden rounded-md border px-2 text-left transition-colors hover:border-primary/60 hover:bg-accent',
                              live ? 'border-primary/40 bg-primary/10' : 'bg-card',
                              past && 'text-muted-foreground opacity-70',
                              p.eventId && 'border-l-4 border-l-amber-500',
                            )}
                            style={{ left: left + 1, width: Math.max(2, right - left - 2) }}
                            title={`${p.title} · ${fmtClock(p.start)}–${fmtClock(p.stop)}`}
                          >
                            <div className="truncate text-sm leading-tight font-medium">{p.title}</div>
                            <div className="truncate text-xs text-muted-foreground">
                              {fmtClock(p.start)}–{fmtClock(p.stop)}
                              {p.subtitle ? ` · ${p.subtitle}` : ''}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
                {guide.data && !channels.length && <div className="p-8 text-center text-sm text-muted-foreground">No channels match.</div>}
              </div>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Click a channel to watch it. Entries with an amber edge come from events. Guide data is only stored for channels mapped to an EPG source.
          </p>
        </>
      )}

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        {selected && (
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 pr-6">
                {selected.p.eventId && <Trophy className="size-4 shrink-0 text-amber-500" />}
                {selected.p.title}
              </DialogTitle>
              <DialogDescription>
                {selected.ch.number != null ? `${selected.ch.number} · ` : ''}
                {selected.ch.name} ·{' '}
                {new Date(selected.p.start).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}–
                {fmtClock(selected.p.stop)}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-1.5">
                {now >= selected.p.start && now < selected.p.stop && <Badge variant="destructive">Live now</Badge>}
                {selected.p.category && <Badge variant="secondary">{selected.p.category}</Badge>}
                {selected.p.episode && <Badge variant="outline">{selected.p.episode}</Badge>}
                <Badge variant="outline">{Math.round((selected.p.stop - selected.p.start) / 60_000)} min</Badge>
              </div>
              {linkedGame.data && <GameChip game={linkedGame.data} className="w-full max-w-xs text-sm" />}
              {selected.p.subtitle && <p className="font-medium">{selected.p.subtitle}</p>}
              {selected.p.icon && <img src={selected.p.icon} alt="" className="max-h-48 rounded-md" />}
              <p className="whitespace-pre-line text-muted-foreground">{selected.p.description ?? 'No description.'}</p>
              <Button
                onClick={() => {
                  setPlaying(selected.ch)
                  setSelected(null)
                }}
              >
                <Play className="fill-current" /> Watch {selected.ch.name}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>

      {playing && (
        <Player
          key={playing.id}
          channel={playing}
          nowTitle={playing.programmes.find((p) => now >= p.start && now < p.stop)?.title}
          onClose={() => setPlaying(null)}
        />
      )}
    </>
  )
}
