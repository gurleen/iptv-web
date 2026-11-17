import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { EyeOff, Lock, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ConfirmButton } from '@/components/app/confirm'
import { Field } from '@/components/app/field'
import { Empty, PageHeader } from '@/components/app/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useMutate } from '@/hooks/use-mutate'
import { api, fmtAgo, fmtTime, qs, type Category, type Event, type LineupChannel, type Page, type Rule } from '@/lib/api'

export const Route = createFileRoute('/_app/events')({ component: Events })

const STATUS_VARIANT = { live: 'destructive', scheduled: 'secondary', ended: 'outline', cancelled: 'outline' } as const
const INV = [['events'], ['rules'], ['lineup'], ['stats']]

function Events() {
  return (
    <>
      <PageHeader title="Events" description="Sports, PPV and other one-off events. Shown in the M3U and in /api/output/events.json." />
      <Tabs defaultValue="events">
        <TabsList>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
        </TabsList>
        <TabsContent value="events" className="pt-3">
          <EventList />
        </TabsContent>
        <TabsContent value="rules" className="pt-3">
          <RuleList />
        </TabsContent>
      </Tabs>
    </>
  )
}

function EventList() {
  const [status, setStatus] = useState('scheduled,live')
  const [editing, setEditing] = useState<Event | 'new' | null>(null)
  const list = useQuery({ queryKey: ['events', status], queryFn: () => api<Page<Event>>(`/events${qs({ status, limit: 500, includeHidden: 'true' })}`) })
  const patch = useMutate((v: { id: string; body: Record<string, unknown> }) => api(`/events/${v.id}`, { method: 'PATCH', body: v.body }), { invalidate: INV })
  const del = useMutate((id: string) => api(`/events/${id}`, { method: 'DELETE' }), { invalidate: INV, success: 'Deleted' })

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="scheduled,live">Upcoming & live</SelectItem>
            <SelectItem value="live">Live now</SelectItem>
            <SelectItem value="ended,cancelled">Past</SelectItem>
            <SelectItem value="scheduled,live,ended,cancelled">All</SelectItem>
          </SelectContent>
        </Select>
        <Button className="ml-auto" onClick={() => setEditing('new')}>
          <Plus /> New event
        </Button>
      </div>
      {list.data?.items.length === 0 ? (
        <Empty>No events. Create one, or add a rule that detects them from channel names or the guide.</Empty>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="hidden md:table-cell">When</TableHead>
                <TableHead>Event</TableHead>
                <TableHead className="hidden md:table-cell">Channels</TableHead>
                <TableHead className="hidden md:table-cell">Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data?.items.map((e) => (
                <TableRow key={e.id} className={e.hidden ? 'opacity-50' : ''}>
                  <TableCell className="whitespace-nowrap text-muted-foreground hidden md:table-cell">{e.startsAt ? fmtTime(e.startsAt) : 'TBA'}</TableCell>
                  <TableCell className="whitespace-normal">
                    <div className="mb-0.5 flex items-center gap-1.5 text-xs text-muted-foreground md:hidden">
                      <Badge variant={STATUS_VARIANT[e.status]}>{e.status}</Badge>
                      {e.startsAt ? fmtTime(e.startsAt) : 'TBA'}
                    </div>
                    <div className="flex items-center gap-1.5 font-medium">
                      {e.title}
                      {e.locked && e.origin === 'rule' && <Lock className="size-3 text-muted-foreground" />}
                      {e.hidden && <EyeOff className="size-3 text-muted-foreground" />}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {[e.sport, e.league, e.origin === 'rule' ? 'auto' : null].filter(Boolean).join(' · ')}
                      <span className="md:hidden">{e.channels.length ? ` · ${e.channels.map((c) => c.name).join(', ')}` : ''}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm hidden md:table-cell">
                    {e.channels.map((c) => c.name).join(', ') || <span className="text-muted-foreground">none</span>}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Badge variant={STATUS_VARIANT[e.status]}>{e.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button size="icon" variant="ghost" title={e.hidden ? 'Show' : 'Hide'} onClick={() => patch.mutate({ id: e.id, body: { hidden: !e.hidden } })}>
                      <EyeOff />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => setEditing(e)}>
                      <Pencil />
                    </Button>
                    <ConfirmButton title={`Delete “${e.title}”?`} description={e.origin === 'rule' ? 'Rules may recreate it — hide it instead to keep it out.' : undefined} onConfirm={() => del.mutate(e.id)}>
                      <Button size="icon" variant="ghost">
                        <Trash2 />
                      </Button>
                    </ConfirmButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {editing && <EventDialog event={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  )
}

const toLocalInput = (ms: number | null | undefined) => {
  if (!ms) return ''
  const d = new Date(ms)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

function EventDialog({ event, onClose }: { event: Event | null; onClose: () => void }) {
  const [f, setF] = useState({
    title: event?.title ?? '',
    sport: event?.sport ?? '',
    league: event?.league ?? '',
    description: event?.description ?? '',
    image: event?.image ?? '',
    startsAt: toLocalInput(event?.startsAt),
    endsAt: toLocalInput(event?.endsAt),
    statusOverride: event?.statusOverride ?? 'auto',
  })
  const [channels, setChannels] = useState(event?.channels.map((c) => ({ lineupChannelId: c.lineupChannelId, name: c.name, label: c.label })) ?? [])
  const [q, setQ] = useState('')
  const search = useQuery({
    queryKey: ['lineup', { q, limit: 10 }],
    queryFn: () => api<Page<LineupChannel>>(`/lineup/channels${qs({ q, limit: 10 })}`),
    enabled: q.length >= 2,
  })
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }))
  const save = useMutate(
    () => {
      const body = {
        title: f.title,
        sport: f.sport || null,
        league: f.league || null,
        description: f.description || null,
        image: f.image || null,
        startsAt: f.startsAt ? new Date(f.startsAt).getTime() : null,
        endsAt: f.endsAt ? new Date(f.endsAt).getTime() : null,
        statusOverride: f.statusOverride === 'auto' ? null : f.statusOverride,
        channels: channels.map((c, i) => ({ lineupChannelId: c.lineupChannelId, label: c.label || null, priority: i })),
      }
      return event ? api(`/events/${event.id}`, { method: 'PATCH', body }) : api('/events', { body })
    },
    { invalidate: INV, success: 'Saved', onSuccess: onClose },
  )
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{event ? 'Edit event' : 'New event'}</DialogTitle>
        </DialogHeader>
        {event?.origin === 'rule' && <p className="text-xs text-muted-foreground">Saving locks this event so its rule stops updating it.</p>}
        <div className="grid gap-3">
          <Field label="Title">
            <Input value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="UFC 310: Pantoja vs Asakura" />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Sport">
              <Input value={f.sport} onChange={(e) => set('sport', e.target.value)} placeholder="MMA" />
            </Field>
            <Field label="League">
              <Input value={f.league} onChange={(e) => set('league', e.target.value)} placeholder="UFC" />
            </Field>
            <Field label="Starts">
              <Input type="datetime-local" value={f.startsAt} onChange={(e) => set('startsAt', e.target.value)} />
            </Field>
            <Field label="Ends">
              <Input type="datetime-local" value={f.endsAt} onChange={(e) => set('endsAt', e.target.value)} />
            </Field>
          </div>
          <Field label="Status">
            <Select value={f.statusOverride} onValueChange={(v) => set('statusOverride', v)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Automatic (from times)</SelectItem>
                <SelectItem value="scheduled">Scheduled</SelectItem>
                <SelectItem value="live">Live</SelectItem>
                <SelectItem value="ended">Ended</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Image URL">
            <Input value={f.image} onChange={(e) => set('image', e.target.value)} />
          </Field>
          <Field label="Description">
            <Textarea rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
          <Field label="Channels">
            <div className="space-y-1">
              {channels.map((c, i) => (
                <div key={c.lineupChannelId} className="flex items-center gap-2">
                  <span className="flex-1 truncate text-sm">{c.name}</span>
                  <Input
                    className="h-8 w-36"
                    placeholder="Label (e.g. Spanish)"
                    value={c.label ?? ''}
                    onChange={(e) => setChannels(channels.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  />
                  <Button size="icon" variant="ghost" className="size-8" onClick={() => setChannels(channels.filter((_, j) => j !== i))}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <Input placeholder="Search lineup channels to link…" value={q} onChange={(e) => setQ(e.target.value)} />
              {search.data?.items
                .filter((r) => !channels.some((c) => c.lineupChannelId === r.id))
                .map((r) => (
                  <button
                    key={r.id}
                    className="block w-full rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
                    onClick={() => (setChannels([...channels, { lineupChannelId: r.id, name: r.name, label: null }]), setQ(''))}
                  >
                    {r.number != null && <span className="mr-2 text-muted-foreground">{r.number}</span>}
                    {r.name}
                  </button>
                ))}
            </div>
          </Field>
        </div>
        <DialogFooter>
          <Button disabled={!f.title || save.isPending} onClick={() => save.mutate(undefined)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RuleList() {
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api<Rule[]>('/event-rules') })
  const [editing, setEditing] = useState<Rule | 'new' | null>(null)
  const run = useMutate(() => api<{ matches?: number }[]>('/event-rules/run', { method: 'POST' }), {
    invalidate: INV,
    success: (r) => `Rules ran — ${r.reduce((a, x) => a + (x.matches ?? 0), 0)} matches`,
  })
  const toggle = useMutate((v: { id: string; enabled: boolean }) => api(`/event-rules/${v.id}`, { method: 'PATCH', body: { enabled: v.enabled } }), { invalidate: INV })
  const del = useMutate((id: string) => api(`/event-rules/${id}`, { method: 'DELETE' }), { invalidate: INV, success: 'Rule deleted' })
  return (
    <>
      <div className="mb-3 flex justify-end gap-2">
        <Button variant="outline" onClick={() => run.mutate(undefined)} disabled={run.isPending}>
          <Play /> Run all
        </Button>
        <Button onClick={() => setEditing('new')}>
          <Plus /> New rule
        </Button>
      </div>
      {rules.data?.length === 0 ? (
        <Empty>
          Rules turn provider PPV/event channels (e.g. “PPV 03: UFC 310 | 12/07 10PM ET”) or guide listings (e.g. “NFL: Bears at Packers”) into events automatically.
        </Empty>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden md:table-cell">Matches</TableHead>
                <TableHead className="hidden md:table-cell">Pattern</TableHead>
                <TableHead className="hidden md:table-cell">Last run</TableHead>
                <TableHead>On</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.data?.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium whitespace-normal">
                    {r.name}
                    <div className="text-xs font-normal text-muted-foreground">
                      {r.kind === 'source_channel' ? 'Upstream channel names' : 'Guide programmes'}
                      <span className="md:hidden"> · {r.lastRunMatches ?? 0} matches · ran {fmtAgo(r.lastRunAt)}</span>
                    </div>
                  </TableCell>
                  <TableCell className="tabular-nums hidden md:table-cell">{r.lastRunMatches ?? '—'}</TableCell>
                  <TableCell className="max-w-64 truncate font-mono text-xs hidden md:table-cell">{r.pattern}</TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell">{fmtAgo(r.lastRunAt)}</TableCell>
                  <TableCell>
                    <Switch checked={r.enabled} onCheckedChange={(v) => toggle.mutate({ id: r.id, enabled: v })} />
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button size="icon" variant="ghost" onClick={() => setEditing(r)}>
                      <Pencil />
                    </Button>
                    <ConfirmButton title={`Delete rule “${r.name}”?`} description="Its unlocked events and auto-created channels are removed too." onConfirm={() => del.mutate(r.id)}>
                      <Button size="icon" variant="ghost">
                        <Trash2 />
                      </Button>
                    </ConfirmButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {editing && <RuleDialog rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  )
}

const NONE = '__none'

function RuleDialog({ rule, onClose }: { rule: Rule | null; onClose: () => void }) {
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<Category[]>('/lineup/categories') })
  const [f, setF] = useState({
    name: rule?.name ?? '',
    kind: rule?.kind ?? ('source_channel' as Rule['kind']),
    pattern: rule?.pattern ?? '',
    categoryPattern: rule?.categoryPattern ?? '',
    titleTemplate: rule?.titleTemplate ?? '',
    sport: rule?.sport ?? '',
    league: rule?.league ?? '',
    timezone: rule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    defaultDurationMinutes: rule?.defaultDurationMinutes ?? 180,
    autoAddChannel: rule?.autoAddChannel ?? false,
    targetCategoryId: rule?.targetCategoryId ?? NONE,
    requireDate: rule?.requireDate ?? false,
  })
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }))
  const body = {
    ...f,
    categoryPattern: f.categoryPattern || null,
    titleTemplate: f.titleTemplate || null,
    sport: f.sport || null,
    league: f.league || null,
    targetCategoryId: f.targetCategoryId === NONE ? null : f.targetCategoryId,
  }
  const preview = useMutate(
    () => api<{ total: number; matches: { title: string; startsAt: number | null; matchedText: string }[] }>('/event-rules/preview', { body }),
    {},
  )
  const save = useMutate(() => (rule ? api(`/event-rules/${rule.id}`, { method: 'PATCH', body }) : api('/event-rules', { body })), {
    invalidate: INV,
    onSuccess: async () => {
      if (rule) await api(`/event-rules/${rule.id}/run`, { method: 'POST' }).catch(() => {})
      toast.success('Rule saved and run')
      onClose()
    },
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{rule ? 'Edit rule' : 'New event rule'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="PPV events" />
            </Field>
            <Field label="Match against">
              <Select value={f.kind} onValueChange={(v) => set('kind', v as Rule['kind'])}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="source_channel">Upstream channel names</SelectItem>
                  <SelectItem value="epg_programme">Guide programme titles</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field
            label="Pattern (regex)"
            hint="Named groups like (?<title>…) can be used in the title template. Dates/times are detected automatically (or use (?<date>…) / (?<time>…))."
          >
            <Input
              className="font-mono"
              value={f.pattern}
              onChange={(e) => set('pattern', e.target.value)}
              placeholder={f.kind === 'source_channel' ? '^PPV\\s*\\d+\\s*[:|]\\s*(?<title>.+)' : '^(NFL|NBA|NHL)\\b.*\\b(vs\\.?|at|@)\\b'}
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {f.kind === 'source_channel' && (
              <Field label="Upstream category must match (regex)">
                <Input className="font-mono" value={f.categoryPattern} onChange={(e) => set('categoryPattern', e.target.value)} placeholder="PPV|Events" />
              </Field>
            )}
            <Field label="Title template">
              <Input value={f.titleTemplate} onChange={(e) => set('titleTemplate', e.target.value)} placeholder="{title}" />
            </Field>
            <Field label="Sport">
              <Input value={f.sport} onChange={(e) => set('sport', e.target.value)} />
            </Field>
            <Field label="League">
              <Input value={f.league} onChange={(e) => set('league', e.target.value)} />
            </Field>
            <Field label="Timezone for parsed times">
              <Input value={f.timezone} onChange={(e) => set('timezone', e.target.value)} />
            </Field>
            <Field label="Default duration (min)">
              <Input type="number" value={f.defaultDurationMinutes} onChange={(e) => set('defaultDurationMinutes', Number(e.target.value))} />
            </Field>
          </div>
          {f.kind === 'source_channel' && (
            <div className="space-y-3 rounded-md border p-3">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={f.autoAddChannel} onCheckedChange={(v) => set('autoAddChannel', v)} /> Auto-create event channels in the lineup (hidden when idle)
              </label>
              {f.autoAddChannel && (
                <Select value={f.targetCategoryId} onValueChange={(v) => set('targetCategoryId', v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Uncategorized</SelectItem>
                    {cats.data?.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={f.requireDate} onCheckedChange={(v) => set('requireDate', v)} /> Skip channels without a date in the name
              </label>
            </div>
          )}
          {preview.data && (
            <div className="max-h-60 overflow-y-auto rounded-md border text-sm">
              <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">{preview.data.total} match(es)</p>
              {preview.data.matches.map((m, i) => (
                <div key={i} className="grid grid-cols-[110px_1fr] gap-2 border-b px-3 py-1 last:border-0">
                  <span className="text-muted-foreground">{m.startsAt ? fmtTime(m.startsAt) : 'no time'}</span>
                  <span className="truncate" title={m.matchedText}>
                    {m.title}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={!f.pattern || preview.isPending} onClick={() => preview.mutate(undefined)}>
            Preview
          </Button>
          <Button disabled={!f.name || !f.pattern || save.isPending} onClick={() => save.mutate(undefined)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
