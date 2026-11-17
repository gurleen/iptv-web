import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/app/page-header'
import { RecentJobs } from '@/components/app/recent-jobs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useJob } from '@/hooks/use-job'
import { api, fmtAgo, type EpgSource, type Job, type Source } from '@/lib/api'

export const Route = createFileRoute('/_app/')({ component: Dashboard })

type Stats = Record<string, number> & { lastFullRefresh: string | null }

function Stat({ label, value, to }: { label: string; value: number | undefined; to?: string }) {
  const body = (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value?.toLocaleString() ?? '—'}</CardTitle>
      </CardHeader>
    </Card>
  )
  return to ? <Link to={to}>{body}</Link> : body
}

function Dashboard() {
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => api<Stats>('/stats') })
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api<Source[]>('/sources') })
  const epg = useQuery({ queryKey: ['epg-sources'], queryFn: () => api<EpgSource[]>('/epg-sources') })
  const refresh = useJob({ invalidate: [['stats'], ['sources'], ['epg-sources'], ['lineup'], ['events']], success: () => 'Refresh complete' })
  const s = stats.data

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Last full refresh: ${s?.lastFullRefresh ? fmtAgo(Date.parse(s.lastFullRefresh)) : 'never'} · runs automatically every 6h`}
      >
        <Button onClick={() => refresh.start(() => api<Job>('/refresh', { method: 'POST' }), 'all', 'Refreshing sources, EPG and events…')} disabled={refresh.running}>
          <RefreshCw className={refresh.running ? 'animate-spin' : ''} /> {refresh.running ? 'Refreshing…' : 'Refresh everything'}
        </Button>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Lineup channels" value={s?.lineupEnabled} to="/lineup" />
        <Stat label="With guide data" value={s?.lineupWithEpg} to="/lineup" />
        <Stat label="Upcoming / live events" value={s?.eventsUpcoming} to="/events" />
        <Stat label="Upstream channels" value={s?.sourceChannels} to="/browse" />
      </div>

      {!!s?.lineupBroken && (
        <p className="mt-4 text-sm text-amber-600 dark:text-amber-400">
          {s.lineupBroken} lineup channel(s) have no working upstream stream.{' '}
          <Link to="/lineup" search={{ broken: true }} className="underline">
            Review
          </Link>
        </p>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sources</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {sources.data?.length === 0 && (
              <p className="text-muted-foreground">
                No sources yet. <Link to="/sources" className="underline">Add an Xtream provider</Link>.
              </p>
            )}
            {sources.data?.map((src) => (
              <div key={src.id} className="flex items-center justify-between gap-2">
                <span className="truncate">{src.name}</span>
                <span className="flex items-center gap-2 text-muted-foreground">
                  {src.channelCount?.toLocaleString()} ch · {fmtAgo(src.lastSyncAt)}
                  <Badge variant={src.lastSyncStatus === 'error' ? 'destructive' : 'secondary'}>{src.lastSyncStatus ?? 'pending'}</Badge>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">EPG</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {epg.data?.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-2">
                <span className="truncate">{e.name}</span>
                <span className="flex items-center gap-2 text-muted-foreground">
                  {e.programmeCount?.toLocaleString() ?? 0} prog · {fmtAgo(e.lastSyncAt)}
                  <Badge variant={e.lastSyncStatus === 'error' ? 'destructive' : 'secondary'}>{e.lastSyncStatus ?? 'pending'}</Badge>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      <RecentJobs names={Object.fromEntries([...(sources.data ?? []), ...(epg.data ?? [])].map((x) => [x.id, x.name]))} />
    </>
  )
}
