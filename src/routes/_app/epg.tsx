import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ConfirmButton } from '@/components/app/confirm'
import { Field } from '@/components/app/field'
import { PageHeader } from '@/components/app/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useMutate } from '@/hooks/use-mutate'
import { api, fmtAgo, type EpgSource } from '@/lib/api'

export const Route = createFileRoute('/_app/epg')({ component: Epg })

function Epg() {
  const list = useQuery({ queryKey: ['epg-sources'], queryFn: () => api<EpgSource[]>('/epg-sources') })
  const [adding, setAdding] = useState(false)
  const inv = [['epg-sources'], ['stats']]
  const refreshOne = useMutate((id: string) => api<{ ok: boolean; programmes?: number; error?: string }>(`/epg-sources/${id}/refresh`, { method: 'POST' }), {
    invalidate: inv,
    onSuccess: (r) => (r.ok ? toast.success(`Loaded ${r.programmes} programmes`) : toast.error(r.error)),
  })
  const refreshAll = useMutate(() => api('/epg/refresh', { method: 'POST' }), { invalidate: inv, success: 'EPG refreshed' })
  const toggle = useMutate((v: { id: string; enabled: boolean }) => api(`/epg-sources/${v.id}`, { method: 'PATCH', body: { enabled: v.enabled } }), { invalidate: inv })
  const del = useMutate((id: string) => api(`/epg-sources/${id}`, { method: 'DELETE' }), { invalidate: inv, success: 'Deleted' })

  return (
    <>
      <PageHeader
        title="EPG sources"
        description="Guide data is only stored for channels mapped in your lineup. Refresh after changing mappings."
      >
        <Button variant="outline" onClick={() => refreshAll.mutate(undefined)} disabled={refreshAll.isPending}>
          <RefreshCw className={refreshAll.isPending ? 'animate-spin' : ''} /> Refresh all
        </Button>
        <Button onClick={() => setAdding(true)}>
          <Plus /> Add XMLTV
        </Button>
      </PageHeader>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Channels</TableHead>
              <TableHead>Stored programmes</TableHead>
              <TableHead>Last refresh</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data?.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="font-medium">
                  {e.name}
                  {e.url && <div className="max-w-72 truncate text-xs text-muted-foreground">{e.url}</div>}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{e.type === 'xtream' ? 'Provider' : 'XMLTV'}</Badge>
                </TableCell>
                <TableCell className="tabular-nums">{e.channelCount?.toLocaleString() ?? '—'}</TableCell>
                <TableCell className="tabular-nums">{e.programmeCount?.toLocaleString() ?? '—'}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Badge variant={e.lastSyncStatus === 'error' ? 'destructive' : 'secondary'}>{e.lastSyncStatus ?? 'pending'}</Badge>
                    <span className="text-xs text-muted-foreground">{fmtAgo(e.lastSyncAt)}</span>
                  </div>
                  {e.lastSyncError && <p className="mt-1 max-w-64 truncate text-xs text-destructive">{e.lastSyncError}</p>}
                </TableCell>
                <TableCell>
                  <Switch checked={e.enabled} onCheckedChange={(v) => toggle.mutate({ id: e.id, enabled: v })} />
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  <Button size="icon" variant="ghost" title="Refresh" disabled={refreshOne.isPending} onClick={() => refreshOne.mutate(e.id)}>
                    <RefreshCw className={refreshOne.isPending && refreshOne.variables === e.id ? 'animate-spin' : ''} />
                  </Button>
                  <ConfirmButton title={`Delete ${e.name}?`} description="Channels mapped to it lose their guide." onConfirm={() => del.mutate(e.id)}>
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
      {adding && <AddDialog onClose={() => setAdding(false)} />}
    </>
  )
}

function AddDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const add = useMutate(() => api<{ sync: { ok: boolean; channels?: number; error?: string } }>('/epg-sources', { body: { name, url, type: 'xmltv' } }), {
    invalidate: [['epg-sources']],
    onSuccess: (r) => {
      if (r.sync?.ok) toast.success(`Added — ${r.sync.channels} channels found`)
      else toast.warning(`Added, but refresh failed: ${r.sync?.error}`)
      onClose()
    },
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add XMLTV source</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="epg.example" />
          </Field>
          <Field label="URL" hint="Plain or gzipped XMLTV (.xml / .xml.gz).">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/guide.xml.gz" />
          </Field>
        </div>
        <DialogFooter>
          <Button disabled={!name || !url || add.isPending} onClick={() => add.mutate(undefined)}>
            {add.isPending ? 'Adding…' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
