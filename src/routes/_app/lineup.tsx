import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ArrowDown, ArrowUp, ChevronDown, FolderCog, Eye, EyeOff, Lock, Pencil, Plus, Trash2, Tv2, Wand2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmButton } from '@/components/app/confirm'
import { ChannelDialog } from '@/components/app/channel-dialog'
import { Empty, PageHeader, Pager } from '@/components/app/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useMutate } from '@/hooks/use-mutate'
import { api, qs, type Category, type LineupChannel, type Page } from '@/lib/api'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/lineup')({
  validateSearch: (s: Record<string, unknown>) => ({ broken: s.broken === true || s.broken === 'true' ? true : undefined }),
  component: Lineup,
})

const PAGE = 200
const INV = [['lineup'], ['categories'], ['stats']]

function Lineup() {
  const search = Route.useSearch()
  const [categoryId, setCategoryId] = useState<string | undefined>()
  const [q, setQ] = useState('')
  const [noEpg, setNoEpg] = useState(false)
  const [broken, setBroken] = useState(!!search.broken)
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<LineupChannel | 'new' | null>(null)
  const [tool, setTool] = useState<'rename' | 'renumber' | null>(null)
  const [catsOpen, setCatsOpen] = useState(false)

  useEffect(() => setOffset(0), [categoryId, q, noEpg, broken])

  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<Category[]>('/lineup/categories') })
  const params = { categoryId, q, hasEpg: noEpg ? 'false' : undefined, brokenStreams: broken ? 'true' : undefined, limit: PAGE, offset }
  const list = useQuery({
    queryKey: ['lineup', params],
    queryFn: () => api<Page<LineupChannel>>(`/lineup/channels${qs(params)}`),
    placeholderData: keepPreviousData,
  })
  const items = list.data?.items ?? []
  const sel = [...selected]

  const patch = useMutate((v: { id: string; patch: Record<string, unknown> }) => api(`/lineup/channels/${v.id}`, { method: 'PATCH', body: v.patch }), {
    invalidate: INV,
  })
  const bulk = useMutate((updates: Record<string, unknown>[]) => api('/lineup/channels', { method: 'PATCH', body: { updates } }), {
    invalidate: INV,
    success: (r: any) => `Updated ${r.updated} channel(s)`,
  })
  const bulkDelete = useMutate(() => api<{ deleted: number }>('/lineup/channels/bulk-delete', { body: { ids: sel } }), {
    invalidate: INV,
    success: (r) => `Deleted ${r.deleted}`,
    onSuccess: () => setSelected(new Set()),
  })
  const clean = useMutate(() => api<{ changes: unknown[] }>('/lineup/channels/clean-names', { body: { ids: sel } }), {
    invalidate: INV,
    success: (r) => `Renamed ${r.changes.length}`,
  })
  const merge = useMutate(() => api('/lineup/channels/merge', { body: { targetId: sel[0], sourceIds: sel.slice(1) } }), {
    invalidate: INV,
    success: 'Merged — extra streams kept as backups',
    onSuccess: () => setSelected(new Set()),
  })
  const autoMap = useMutate(() => api<{ mapped: unknown[]; unmatched: unknown[] }>('/lineup/auto-map-epg', { body: { ids: sel.length ? sel : undefined } }), {
    invalidate: INV,
    onSuccess: (r) => toast.success(`Mapped ${r.mapped.length}, ${r.unmatched.length} without a confident match. Refresh EPG to load guide data.`),
  })

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  return (
    <>
      <PageHeader title="Lineup" description="Your cleaned-up output. Order here = order in the M3U.">
        <Button variant="outline" onClick={() => autoMap.mutate(undefined)} disabled={autoMap.isPending}>
          <Wand2 /> Auto-map EPG{sel.length ? ` (${sel.length})` : ''}
        </Button>
        <Button onClick={() => setEditing('new')}>
          <Plus /> New channel
        </Button>
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <div className="hidden lg:block">
          <CategoryList cats={cats.data ?? []} value={categoryId} onChange={setCategoryId} />
        </div>

        <div className="min-w-0">
          {/* phones/tablets: category picker + a panel for managing categories */}
          <div className="mb-3 flex gap-2 lg:hidden">
            <Select value={categoryId ?? '__all'} onValueChange={(v) => setCategoryId(v === '__all' ? undefined : v)}>
              <SelectTrigger className="min-w-0 flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All channels</SelectItem>
                <SelectItem value="none">Uncategorized</SelectItem>
                {cats.data?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} ({c.channelCount})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={() => setCatsOpen(true)}>
              <FolderCog /> Categories
            </Button>
          </div>
          <Sheet open={catsOpen} onOpenChange={setCatsOpen}>
            <SheetContent side="left" className="w-72 overflow-y-auto p-4">
              <SheetTitle className="mb-2">Categories</SheetTitle>
              <CategoryList
                cats={cats.data ?? []}
                value={categoryId}
                onChange={(v) => {
                  setCategoryId(v)
                  setCatsOpen(false)
                }}
                touch
              />
            </SheetContent>
          </Sheet>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input className="w-full sm:w-56" placeholder="Filter by name…" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={noEpg} onCheckedChange={setNoEpg} /> No EPG
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={broken} onCheckedChange={setBroken} /> Broken streams
            </label>
            <div className="ml-auto flex gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={!sel.length}>
                    {sel.length} selected <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Move to category</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
                      <DropdownMenuItem onClick={() => bulk.mutate(sel.map((id) => ({ id, categoryId: null })))}>Uncategorized</DropdownMenuItem>
                      {cats.data?.map((c) => (
                        <DropdownMenuItem key={c.id} onClick={() => bulk.mutate(sel.map((id) => ({ id, categoryId: c.id })))}>
                          {c.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuItem onClick={() => bulk.mutate(sel.map((id) => ({ id, enabled: true })))}>Enable</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => bulk.mutate(sel.map((id) => ({ id, enabled: false })))}>Disable</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => clean.mutate(undefined)}>Clean names</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setTool('rename')}>Find & replace in names…</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setTool('renumber')}>Renumber…</DropdownMenuItem>
                  <DropdownMenuItem disabled={sel.length < 2} onClick={() => merge.mutate(undefined)}>
                    Merge into first selected
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive" onClick={() => bulkDelete.mutate(undefined)}>
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {list.data && !items.length ? (
            <Empty>No channels here. Use “Browse sources” to add some.</Empty>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <Checkbox
                        checked={items.length > 0 && items.every((i) => selected.has(i.id))}
                        onCheckedChange={(v) =>
                          setSelected((s) => {
                            const n = new Set(s)
                            for (const i of items) v ? n.add(i.id) : n.delete(i.id)
                            return n
                          })
                        }
                      />
                    </TableHead>
                    <TableHead className="w-14 md:w-20">#</TableHead>
                    <TableHead className="w-10 hidden md:table-cell" />
                    <TableHead>Name</TableHead>
                    <TableHead className="hidden md:table-cell">Category</TableHead>
                    <TableHead className="hidden md:table-cell">EPG</TableHead>
                    <TableHead className="hidden md:table-cell">Streams</TableHead>
                    <TableHead className="w-12">On</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((ch) => {
                    const live = ch.streams.filter((s) => !s.removed).length
                    return (
                      <TableRow key={ch.id} data-state={selected.has(ch.id) ? 'selected' : undefined} className={ch.enabled ? '' : 'opacity-50'}>
                        <TableCell>
                          <Checkbox checked={selected.has(ch.id)} onCheckedChange={() => toggle(ch.id)} />
                        </TableCell>
                        <TableCell>
                          <InlineEdit
                            className="w-11 tabular-nums md:w-16"
                            value={ch.number == null ? '' : String(ch.number)}
                            onSave={(v) => patch.mutate({ id: ch.id, patch: { number: v === '' ? null : Number(v) } })}
                          />
                        </TableCell>
                        <TableCell className="hidden md:table-cell">{ch.logo ? <img src={ch.logo} alt="" className="size-6 object-contain" loading="lazy" /> : null}</TableCell>
                        <TableCell className="max-w-0 md:max-w-none">
                          <div className="flex items-center gap-1.5">
                            <InlineEdit className="w-full min-w-0 md:min-w-48" value={ch.name} onSave={(v) => v && patch.mutate({ id: ch.id, patch: { name: v } })} />
                            {ch.kind === 'event' && (
                              <Badge variant="outline" title={ch.hideWhenIdle ? 'Hidden when no event' : undefined}>
                                event
                              </Badge>
                            )}
                            {ch.locked && <Lock className="size-3 shrink-0 text-muted-foreground" />}
                          </div>
                          <div className="truncate px-1 text-xs text-muted-foreground md:hidden">
                            {ch.categoryName ?? 'Uncategorized'}
                            {!ch.epgChannelId && ' · no EPG'}
                            {live < ch.streams.length && <span className="text-destructive"> · {ch.streams.length - live} broken</span>}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground hidden md:table-cell">{ch.categoryName ?? '—'}</TableCell>
                        <TableCell className="hidden md:table-cell">
                          {ch.epgChannelId ? (
                            <span className="block max-w-36 truncate font-mono text-xs" title={ch.epgChannelId}>
                              {ch.epgChannelId}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">none</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <Badge variant={live ? 'secondary' : 'destructive'}>
                            {live}/{ch.streams.length}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Switch checked={ch.enabled} onCheckedChange={(v) => patch.mutate({ id: ch.id, patch: { enabled: v } })} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Button size="icon" variant="ghost" onClick={() => setEditing(ch)}>
                            <Pencil />
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          <Pager total={list.data?.total ?? 0} offset={offset} pageSize={PAGE} onChange={setOffset} />
        </div>
      </div>

      {editing && <ChannelDialog channel={editing === 'new' ? null : editing} categories={cats.data ?? []} onClose={() => setEditing(null)} />}
      {tool === 'rename' && <RenameDialog ids={sel} onClose={() => setTool(null)} />}
      {tool === 'renumber' && <RenumberDialog ids={items.filter((i) => selected.has(i.id)).map((i) => i.id)} onClose={() => setTool(null)} />}
    </>
  )
}

function InlineEdit({ value, onSave, className }: { value: string; onSave: (v: string) => void; className?: string }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <input
      className={cn('rounded-sm border border-transparent bg-transparent px-1 py-0.5 hover:border-input focus:border-ring focus:outline-none', className)}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onSave(v.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setV(value)
      }}
    />
  )
}

function CategoryList({ cats, value, onChange, touch }: { cats: Category[]; value?: string; onChange: (v?: string) => void; touch?: boolean }) {
  const [name, setName] = useState('')
  const create = useMutate(() => api('/lineup/categories', { body: { name } }), { invalidate: INV, onSuccess: () => setName('') })
  const reorder = useMutate((ids: string[]) => api('/lineup/categories/reorder', { body: { ids } }), { invalidate: INV })
  const patch = useMutate((v: { id: string; body: Record<string, unknown> }) => api(`/lineup/categories/${v.id}`, { method: 'PATCH', body: v.body }), {
    invalidate: INV,
  })
  const del = useMutate((id: string) => api(`/lineup/categories/${id}`, { method: 'DELETE' }), { invalidate: INV, onSuccess: () => onChange(undefined) })
  const move = (i: number, d: -1 | 1) => {
    const ids = cats.map((c) => c.id)
    const j = i + d
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    reorder.mutate(ids)
  }
  const item = 'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent'
  return (
    <div className="space-y-1">
      <button className={cn(item, !value && 'bg-accent font-medium')} onClick={() => onChange(undefined)}>
        All channels
      </button>
      <button className={cn(item, value === 'none' && 'bg-accent font-medium')} onClick={() => onChange('none')}>
        Uncategorized
      </button>
      <div className="my-2 border-t" />
      {cats.map((c, i) => (
        <div key={c.id} className={cn('group', item, value === c.id && 'bg-accent font-medium', c.hidden && 'opacity-60')}>
          <button className="min-w-0 flex-1 truncate text-left" onClick={() => onChange(c.id)}>
            {c.name} <span className="text-xs text-muted-foreground">{c.channelCount}</span>
          </button>
          <span className={cn('shrink-0 gap-0.5 group-hover:flex', touch ? 'flex gap-2.5' : 'hidden')}>
            <ArrowUp className="size-3.5 cursor-pointer" onClick={() => move(i, -1)} />
            <ArrowDown className="size-3.5 cursor-pointer" onClick={() => move(i, 1)} />
            {c.hidden ? (
              <EyeOff className="size-3.5 cursor-pointer" onClick={() => patch.mutate({ id: c.id, body: { hidden: false } })} />
            ) : (
              <Eye className="size-3.5 cursor-pointer" onClick={() => patch.mutate({ id: c.id, body: { hidden: true } })} />
            )}
            <Pencil
              className="size-3.5 cursor-pointer"
              onClick={() => {
                const n = prompt('Rename category', c.name)
                if (n && n !== c.name) patch.mutate({ id: c.id, body: { name: n } })
              }}
            />
            <ConfirmButton title={`Delete “${c.name}”?`} description="Its channels become uncategorized." onConfirm={() => del.mutate(c.id)}>
              <Trash2 className="size-3.5 cursor-pointer" />
            </ConfirmButton>
          </span>
        </div>
      ))}
      <form
        className="flex gap-1 pt-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (name) create.mutate(undefined)
        }}
      >
        <Input className="h-8" placeholder="New category" value={name} onChange={(e) => setName(e.target.value)} />
        <Button size="icon" className="size-8" disabled={!name}>
          <Plus />
        </Button>
      </form>
      <p className="flex items-center gap-1 px-1 pt-2 text-xs text-muted-foreground">
        <Tv2 className="size-3" /> Hidden categories are left out of outputs.
      </p>
    </div>
  )
}

function RenameDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const [pattern, setPattern] = useState('')
  const [replacement, setReplacement] = useState('')
  const body = { pattern, replacement, ids: ids.length ? ids : undefined }
  const preview = useQuery({
    queryKey: ['rename-preview', body],
    queryFn: () => api<{ changes: { id: string; before: string; after: string }[] }>('/lineup/channels/rename', { body: { ...body, dryRun: true } }),
    enabled: !!pattern,
    retry: false,
  })
  const apply = useMutate(() => api<{ changes: unknown[] }>('/lineup/channels/rename', { body }), {
    invalidate: INV,
    success: (r) => `Renamed ${r.changes.length}`,
    onSuccess: onClose,
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Find & replace in {ids.length ? `${ids.length} selected` : 'all'} channel names</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Input placeholder="Regex, e.g. \s*\(east\)$" value={pattern} onChange={(e) => setPattern(e.target.value)} className="font-mono" />
          <Input placeholder="Replacement ($1 ok)" value={replacement} onChange={(e) => setReplacement(e.target.value)} className="font-mono" />
        </div>
        <div className="max-h-72 overflow-y-auto rounded-md border text-sm">
          {preview.error && <p className="p-3 text-destructive">{String((preview.error as Error).message)}</p>}
          {preview.data?.changes.slice(0, 200).map((c) => (
            <div key={c.id} className="grid grid-cols-2 gap-2 border-b px-3 py-1 last:border-0">
              <span className="truncate text-muted-foreground line-through">{c.before}</span>
              <span className="truncate">{c.after}</span>
            </div>
          ))}
          {preview.data && !preview.data.changes.length && <p className="p-3 text-muted-foreground">No changes.</p>}
        </div>
        <DialogFooter>
          <Button disabled={!preview.data?.changes.length || apply.isPending} onClick={() => apply.mutate(undefined)}>
            Apply {preview.data?.changes.length ?? 0} change(s)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RenumberDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const [start, setStart] = useState('1')
  const [step, setStep] = useState('1')
  const apply = useMutate(() => api('/lineup/channels/renumber', { body: { ids, start: Number(start), step: Number(step) } }), {
    invalidate: INV,
    success: 'Renumbered',
    onSuccess: onClose,
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Renumber {ids.length} channel(s) in current order</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          <Input type="number" value={start} onChange={(e) => setStart(e.target.value)} placeholder="Start" />
          <Input type="number" value={step} onChange={(e) => setStep(e.target.value)} placeholder="Step" />
        </div>
        <DialogFooter>
          <Button onClick={() => apply.mutate(undefined)} disabled={apply.isPending}>
            Renumber
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
