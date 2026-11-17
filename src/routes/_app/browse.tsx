import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Check, ListPlus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Field } from '@/components/app/field'
import { PageHeader, Pager } from '@/components/app/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useMutate } from '@/hooks/use-mutate'
import { api, qs, type Category, type Page, type Source, type SourceChannel } from '@/lib/api'

export const Route = createFileRoute('/_app/browse')({ component: Browse })

const PAGE = 100
const ALL = '__all'

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v)
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms)
    return () => clearTimeout(t)
  }, [v, ms])
  return d
}

function Browse() {
  const [q, setQ] = useState('')
  const [sourceId, setSourceId] = useState(ALL)
  const [category, setCategory] = useState(ALL)
  const [hideAdded, setHideAdded] = useState(false)
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const dq = useDebounced(q)

  useEffect(() => setOffset(0), [dq, sourceId, category, hideAdded])

  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api<Source[]>('/sources') })
  const cats = useQuery({
    queryKey: ['source-categories', sourceId],
    queryFn: () => api<{ sourceId: string; categoryName: string | null; count: number; inLineup: number }[]>(`/source-categories${qs({ sourceId: sourceId === ALL ? undefined : sourceId })}`),
  })
  const params = {
    q: dq,
    sourceId: sourceId === ALL ? undefined : sourceId,
    category: category === ALL ? undefined : category,
    inLineup: hideAdded ? 'false' : undefined,
    limit: PAGE,
    offset,
  }
  const list = useQuery({
    queryKey: ['source-channels', params],
    queryFn: () => api<Page<SourceChannel>>(`/source-channels${qs(params)}`),
    placeholderData: keepPreviousData,
  })
  const items = list.data?.items ?? []
  const catNames = useMemo(() => [...new Set((cats.data ?? []).map((c) => c.categoryName).filter(Boolean) as string[])], [cats.data])

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  const allOnPage = items.length > 0 && items.every((i) => selected.has(i.id))

  return (
    <>
      <PageHeader title="Browse sources" description="Find upstream channels and add them to your lineup.">
        <Button disabled={!selected.size} onClick={() => setAdding(true)}>
          <ListPlus /> Add {selected.size || ''} to lineup
        </Button>
      </PageHeader>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input className="w-64" placeholder="Search names… (* = wildcard)" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={sourceId} onValueChange={(v) => (setSourceId(v), setCategory(ALL))}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All sources</SelectItem>
            {sources.data?.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-96">
            <SelectItem value={ALL}>All categories</SelectItem>
            {catNames.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={hideAdded} onCheckedChange={setHideAdded} /> Hide added
        </label>
        {selected.size > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        )}
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox
                  checked={allOnPage}
                  onCheckedChange={(v) =>
                    setSelected((s) => {
                      const n = new Set(s)
                      for (const i of items) v ? n.add(i.id) : n.delete(i.id)
                      return n
                    })
                  }
                />
              </TableHead>
              <TableHead className="w-10" />
              <TableHead>Name</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>EPG id</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((c) => (
              <TableRow key={c.id} onClick={() => toggle(c.id)} className="cursor-pointer" data-state={selected.has(c.id) ? 'selected' : undefined}>
                <TableCell>
                  <Checkbox checked={selected.has(c.id)} onClick={(e) => e.stopPropagation()} onCheckedChange={() => toggle(c.id)} />
                </TableCell>
                <TableCell>{c.logo ? <img src={c.logo} alt="" className="size-6 object-contain" loading="lazy" /> : null}</TableCell>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell className="text-muted-foreground">{c.categoryName}</TableCell>
                <TableCell className="text-muted-foreground">{c.sourceName}</TableCell>
                <TableCell className="max-w-40 truncate font-mono text-xs text-muted-foreground">{c.epgChannelId}</TableCell>
                <TableCell>
                  {c.lineupChannelIds.length > 0 && (
                    <Badge variant="secondary">
                      <Check /> in lineup
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Pager total={list.data?.total ?? 0} offset={offset} pageSize={PAGE} onChange={setOffset} />
      {adding && (
        <AddDialog
          ids={[...selected]}
          onClose={(done) => {
            setAdding(false)
            if (done) setSelected(new Set())
          }}
        />
      )}
    </>
  )
}

const NEW = '__new'
const UPSTREAM = '__upstream'

function AddDialog({ ids, onClose }: { ids: string[]; onClose: (done: boolean) => void }) {
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<Category[]>('/lineup/categories') })
  const [cat, setCat] = useState<string>(UPSTREAM)
  const [newCat, setNewCat] = useState('')
  const [cleanNames, setCleanNames] = useState(true)
  const [kind, setKind] = useState<'linear' | 'event'>('linear')
  const add = useMutate(
    () =>
      api<{ created: unknown[]; skipped: string[] }>('/lineup/channels/from-source', {
        body: {
          sourceChannelIds: ids,
          cleanNames,
          kind,
          useSourceCategory: cat === UPSTREAM,
          categoryName: cat === NEW ? newCat : undefined,
          categoryId: cat !== NEW && cat !== UPSTREAM ? cat : undefined,
        },
      }),
    {
      invalidate: [['source-channels'], ['lineup'], ['categories'], ['stats']],
      onSuccess: (r) => {
        toast.success(`Added ${r.created.length} channel(s)${r.skipped.length ? `, skipped ${r.skipped.length} already in lineup` : ''}`)
        onClose(true)
      },
    },
  )
  return (
    <Dialog open onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add {ids.length} channel(s) to lineup</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Category">
            <Select value={cat} onValueChange={setCat}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UPSTREAM}>Same as upstream category</SelectItem>
                <SelectItem value={NEW}>New category…</SelectItem>
                {cats.data?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {cat === NEW && <Input placeholder="Category name" value={newCat} onChange={(e) => setNewCat(e.target.value)} autoFocus />}
          <Field label="Channel type">
            <Select value={kind} onValueChange={(v) => setKind(v as 'linear' | 'event')}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="linear">Regular channel</SelectItem>
                <SelectItem value="event">Event / PPV feed</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={cleanNames} onCheckedChange={setCleanNames} /> Clean up names (strip country prefixes, HD/FHD tags)
          </label>
        </div>
        <DialogFooter>
          <Button disabled={add.isPending || (cat === NEW && !newCat)} onClick={() => add.mutate(undefined)}>
            {add.isPending ? 'Adding…' : 'Add to lineup'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
