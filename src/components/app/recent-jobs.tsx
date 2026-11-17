import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { api, fmtAgo, type Job } from '@/lib/api'

const LABEL: Record<Job['type'], string> = {
  source_sync: 'Source sync',
  epg_refresh: 'EPG refresh',
  rules: 'Event rules',
  full_refresh: 'Full refresh',
}
const VARIANT = { queued: 'outline', running: 'secondary', done: 'secondary', error: 'destructive' } as const

export function RecentJobs({ names }: { names: Record<string, string> }) {
  const jobs = useQuery({
    queryKey: ['recent-jobs'],
    queryFn: () => api<Job[]>('/jobs?limit=10'),
    refetchInterval: (q) => (q.state.data?.some((j) => j.state === 'queued' || j.state === 'running') ? 3000 : 30000),
  })
  if (!jobs.data?.length) return null
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="text-base">Background jobs</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm">
        {jobs.data.map((j) => {
          const secs = j.startedAt ? Math.round(((j.finishedAt ?? Date.now()) - j.startedAt) / 1000) : null
          return (
            <div key={j.id} className="flex items-center gap-2">
              <span className="w-28 shrink-0">{LABEL[j.type]}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={j.error ?? undefined}>
                {j.targetId && j.targetId !== 'full' ? (names[j.targetId] ?? j.targetId) : 'all'}
                {j.error ? ` — ${j.error}` : ''}
              </span>
              <span className="text-xs text-muted-foreground">
                {fmtAgo(j.createdAt)}
                {secs != null ? ` · ${secs}s` : ''}
              </span>
              <Badge variant={VARIANT[j.state]}>{j.state}</Badge>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
