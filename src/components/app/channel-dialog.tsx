import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Search, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Field } from '@/components/app/field'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useMutate } from '@/hooks/use-mutate'
import { api, fmtTime, qs, type Category, type LineupChannel, type Page, type Programme, type SourceChannel } from '@/lib/api'

const NONE = '__none'
type StreamRef = { sourceChannelId: string; name: string | null; sourceName: string | null; removed: boolean }

export function ChannelDialog({ channel, categories, onClose }: { channel: LineupChannel | null; categories: Category[]; onClose: () => void }) {
  const [f, setF] = useState({
    name: channel?.name ?? '',
    number: channel?.number == null ? '' : String(channel.number),
    categoryId: channel?.categoryId ?? NONE,
    logo: channel?.logo ?? '',
    tvgId: channel?.tvgId ?? '',
    kind: channel?.kind ?? 'linear',
    hideWhenIdle: channel?.hideWhenIdle ?? false,
    enabled: channel?.enabled ?? true,
    locked: channel?.locked ?? false,
    notes: channel?.notes ?? '',
    epgSourceId: channel?.epgSourceId ?? null,
    epgChannelId: channel?.epgChannelId ?? null,
  })
  const [streams, setStreams] = useState<StreamRef[]>(channel?.streams ?? [])
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }))

  const save = useMutate(
    async () => {
      const body = {
        name: f.name,
        number: f.number === '' ? null : Number(f.number),
        categoryId: f.categoryId === NONE ? null : f.categoryId,
        logo: f.logo || null,
        tvgId: f.tvgId || null,
        kind: f.kind,
        hideWhenIdle: f.hideWhenIdle,
        enabled: f.enabled,
        locked: f.locked,
        notes: f.notes || null,
        epgSourceId: f.epgChannelId ? f.epgSourceId : null,
        epgChannelId: f.epgChannelId,
      }
      const ids = streams.map((s) => s.sourceChannelId)
      if (!channel) return api('/lineup/channels', { body: { ...body, streams: ids } })
      await api(`/lineup/channels/${channel.id}`, { method: 'PATCH', body })
      const changed = ids.join() !== channel.streams.map((s) => s.sourceChannelId).join()
      if (changed) await api(`/lineup/channels/${channel.id}/streams`, { method: 'PUT', body: { sourceChannelIds: ids } })
    },
    { invalidate: [['lineup'], ['categories'], ['stats']], success: 'Saved', onSuccess: onClose },
  )
  const del = useMutate(() => api(`/lineup/channels/${channel!.id}`, { method: 'DELETE' }), {
    invalidate: [['lineup'], ['categories'], ['stats']],
    success: 'Deleted',
    onSuccess: onClose,
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{channel ? `Edit ${channel.name}` : 'New channel'}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="details">
          <TabsList>
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="streams">Streams ({streams.length})</TabsTrigger>
            <TabsTrigger value="epg">EPG</TabsTrigger>
          </TabsList>

          <TabsContent value="details" className="grid gap-3 pt-2">
            <div className="grid grid-cols-[1fr_88px] gap-3">
              <Field label="Name">
                <Input value={f.name} onChange={(e) => set('name', e.target.value)} />
              </Field>
              <Field label="Number">
                <Input type="number" value={f.number} onChange={(e) => set('number', e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Category">
                <Select value={f.categoryId} onValueChange={(v) => set('categoryId', v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Uncategorized</SelectItem>
                    {categories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Type">
                <Select value={f.kind} onValueChange={(v) => set('kind', v as 'linear' | 'event')}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="linear">Regular channel</SelectItem>
                    <SelectItem value="event">Event / PPV feed</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field label="Logo URL">
              <div className="flex gap-2">
                <Input value={f.logo} onChange={(e) => set('logo', e.target.value)} />
                {f.logo && <img src={f.logo} alt="" className="size-9 rounded border object-contain" />}
              </div>
            </Field>
            <Field label="tvg-id override" hint="Defaults to the channel id. Only change if a downstream app expects a specific id.">
              <Input value={f.tvgId} onChange={(e) => set('tvgId', e.target.value)} placeholder={channel?.id} />
            </Field>
            <Field label="Notes">
              <Textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>
            <div className="flex flex-wrap gap-5 text-sm">
              <label className="flex items-center gap-2">
                <Switch checked={f.enabled} onCheckedChange={(v) => set('enabled', v)} /> Enabled
              </label>
              {f.kind === 'event' && (
                <label className="flex items-center gap-2">
                  <Switch checked={f.hideWhenIdle} onCheckedChange={(v) => set('hideWhenIdle', v)} /> Hide when no event
                </label>
              )}
              <label className="flex items-center gap-2" title="Event rules won't rename or delete locked channels">
                <Switch checked={f.locked} onCheckedChange={(v) => set('locked', v)} /> Locked
              </label>
            </div>
          </TabsContent>

          <TabsContent value="streams" className="pt-2">
            <StreamsEditor streams={streams} onChange={setStreams} />
          </TabsContent>

          <TabsContent value="epg" className="pt-2">
            <EpgEditor
              channelId={channel?.id}
              name={f.name}
              value={{ epgSourceId: f.epgSourceId, epgChannelId: f.epgChannelId }}
              onChange={(v) => setF((p) => ({ ...p, ...v }))}
            />
          </TabsContent>
        </Tabs>
        <DialogFooter className="gap-2 sm:justify-between">
          {channel ? (
            <Button variant="ghost" className="text-destructive" onClick={() => del.mutate(undefined)}>
              <Trash2 /> Delete
            </Button>
          ) : (
            <span />
          )}
          <Button disabled={!f.name || save.isPending} onClick={() => save.mutate(undefined)}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StreamsEditor({ streams, onChange }: { streams: StreamRef[]; onChange: (s: StreamRef[]) => void }) {
  const [q, setQ] = useState('')
  const results = useQuery({
    queryKey: ['source-channels', { q, limit: 15 }],
    queryFn: () => api<Page<SourceChannel>>(`/source-channels${qs({ q, limit: 15 })}`),
    enabled: q.length >= 2,
  })
  const move = (i: number, d: number) => {
    const n = [...streams]
    const j = i + d
    if (j < 0 || j >= n.length) return
    ;[n[i], n[j]] = [n[j], n[i]]
    onChange(n)
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">The first working stream is used; the rest are backups.</p>
      <div className="space-y-1">
        {streams.map((s, i) => (
          <div key={s.sourceChannelId} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
            <span className="w-5 text-muted-foreground">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate">{s.name ?? s.sourceChannelId}</span>
            <span className="text-xs text-muted-foreground">{s.sourceName}</span>
            {s.removed && <Badge variant="destructive">gone</Badge>}
            <ArrowUp className="size-4 cursor-pointer" onClick={() => move(i, -1)} />
            <ArrowDown className="size-4 cursor-pointer" onClick={() => move(i, 1)} />
            <X className="size-4 cursor-pointer" onClick={() => onChange(streams.filter((x) => x !== s))} />
          </div>
        ))}
        {!streams.length && <p className="text-sm text-muted-foreground">No streams — this channel won't appear in outputs.</p>}
      </div>
      <div className="relative">
        <Search className="absolute top-2.5 left-2 size-4 text-muted-foreground" />
        <Input className="pl-8" placeholder="Search upstream channels to add…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="space-y-1">
        {results.data?.items
          .filter((r) => !streams.some((s) => s.sourceChannelId === r.id))
          .map((r) => (
            <button
              key={r.id}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
              onClick={() => onChange([...streams, { sourceChannelId: r.id, name: r.name, sourceName: r.sourceName, removed: false }])}
            >
              <span className="flex-1 truncate">{r.name}</span>
              <span className="text-xs text-muted-foreground">
                {r.categoryName} · {r.sourceName}
              </span>
            </button>
          ))}
      </div>
    </div>
  )
}

type Suggestion = { epgSourceId: string; epgSourceName: string | null; xmltvId: string; displayName: string | null; score: number }

function EpgEditor({
  channelId,
  name,
  value,
  onChange,
}: {
  channelId?: string
  name: string
  value: { epgSourceId: string | null; epgChannelId: string | null }
  onChange: (v: { epgSourceId: string | null; epgChannelId: string | null }) => void
}) {
  const [q, setQ] = useState('')
  useEffect(() => setQ(name), [name])
  const sugg = useQuery({
    queryKey: ['epg-suggest', channelId, q],
    queryFn: () => api<Suggestion[]>(`/lineup/channels/${channelId}/epg-suggestions${qs({ q })}`),
    enabled: !!channelId && q.length >= 2,
  })
  const guide = useQuery({
    queryKey: ['guide', channelId, value.epgChannelId],
    queryFn: () => api<Programme[]>(`/lineup/channels/${channelId}/guide`),
    enabled: !!channelId && !!value.epgChannelId,
  })
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
        {value.epgChannelId ? (
          <span>
            Mapped to <code className="text-xs">{value.epgChannelId}</code>
          </span>
        ) : (
          <span className="text-muted-foreground">Not mapped</span>
        )}
        {value.epgChannelId && (
          <Button size="sm" variant="ghost" onClick={() => onChange({ epgSourceId: null, epgChannelId: null })}>
            Clear
          </Button>
        )}
      </div>
      {!channelId ? (
        <p className="text-sm text-muted-foreground">Save the channel first, then map its guide.</p>
      ) : (
        <>
          <Input placeholder="Search EPG channels…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {sugg.data?.map((s) => (
              <button
                key={`${s.epgSourceId}:${s.xmltvId}`}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
                onClick={() => onChange({ epgSourceId: s.epgSourceId, epgChannelId: s.xmltvId })}
              >
                <span className="flex-1 truncate">{s.displayName}</span>
                <code className="max-w-40 truncate text-xs text-muted-foreground">{s.xmltvId}</code>
                <span className="text-xs text-muted-foreground">{s.epgSourceName}</span>
                <Badge variant="outline">{Math.round(s.score * 100)}%</Badge>
              </button>
            ))}
          </div>
          {value.epgChannelId && (
            <div className="space-y-1 border-t pt-2 text-sm">
              <p className="text-xs font-medium text-muted-foreground">Upcoming (after save + EPG refresh)</p>
              {guide.data?.slice(0, 6).map((p) => (
                <div key={p.start} className="flex gap-2">
                  <span className="w-28 shrink-0 text-muted-foreground">{fmtTime(p.start)}</span>
                  <span className="truncate">{p.title}</span>
                </div>
              ))}
              {guide.data?.length === 0 && <p className="text-xs text-muted-foreground">No programmes stored yet.</p>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
