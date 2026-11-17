import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
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
import { useMutate } from '@/hooks/use-mutate'
import { api, fmtAgo, type Source } from '@/lib/api'

export const Route = createFileRoute('/_app/sources')({ component: Sources })

type Form = { name: string; baseUrl: string; username: string; password: string; streamFormat: 'ts' | 'm3u8'; fetchMode: 'direct' | 'browser'; userAgent: string; enabled: boolean; priority: number; createEpgSource: boolean }
const blank: Form = { name: '', baseUrl: '', username: '', password: '', streamFormat: 'ts', fetchMode: 'direct', userAgent: '', enabled: true, priority: 100, createEpgSource: true }

function Sources() {
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api<Source[]>('/sources') })
  const [editing, setEditing] = useState<{ id?: string; form: Form } | null>(null)
  const inv = [['sources'], ['stats'], ['epg-sources'], ['source-channels']]

  const sync = useMutate((id: string) => api<{ ok: boolean; channels?: number; error?: string }>(`/sources/${id}/sync`, { method: 'POST' }), {
    invalidate: inv,
    onSuccess: (r) => (r.ok ? toast.success(`Synced ${r.channels} channels`) : toast.error(r.error)),
  })
  const del = useMutate((id: string) => api(`/sources/${id}`, { method: 'DELETE' }), { invalidate: inv, success: 'Source deleted' })

  return (
    <>
      <PageHeader title="Sources" description="Xtream Codes providers. Channels are re-synced every 6 hours.">
        <Button onClick={() => setEditing({ form: blank })}>
          <Plus /> Add source
        </Button>
      </PageHeader>

      {sources.data?.length === 0 ? (
        <Empty>No sources yet. Add your Xtream provider's URL, username and password.</Empty>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Server</TableHead>
                <TableHead>Channels</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Last sync</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.data?.map((s) => {
                const info = (s.accountInfo ?? {}) as Record<string, string>
                const exp = info.exp_date ? new Date(Number(info.exp_date) * 1000).toLocaleDateString() : null
                return (
                  <TableRow key={s.id} className={s.enabled ? '' : 'opacity-50'}>
                    <TableCell className="font-medium">
                      {s.name}
                      {s.fetchMode === 'browser' && (
                        <Badge variant="outline" className="ml-2" title="API and EPG calls go through Cloudflare Browser Rendering">
                          via browser
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="max-w-48 truncate text-muted-foreground">{s.baseUrl}</TableCell>
                    <TableCell className="tabular-nums">{s.channelCount?.toLocaleString()}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {info.status ?? '—'}
                      {info.max_connections ? ` · ${info.active_cons ?? 0}/${info.max_connections} conn` : ''}
                      {exp ? ` · exp ${exp}` : ''}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant={s.lastSyncStatus === 'error' ? 'destructive' : 'secondary'} title={s.lastSyncError ?? ''}>
                          {s.lastSyncStatus ?? 'pending'}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{fmtAgo(s.lastSyncAt)}</span>
                      </div>
                      {s.lastSyncError && <p className="mt-1 max-w-64 truncate text-xs text-destructive">{s.lastSyncError}</p>}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button size="icon" variant="ghost" title="Sync now" disabled={sync.isPending} onClick={() => sync.mutate(s.id)}>
                        <RefreshCw className={sync.isPending && sync.variables === s.id ? 'animate-spin' : ''} />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Edit"
                        onClick={() =>
                          setEditing({
                            id: s.id,
                            form: { ...blank, ...s, userAgent: s.userAgent ?? '', password: '', createEpgSource: false },
                          })
                        }
                      >
                        <Pencil />
                      </Button>
                      <ConfirmButton
                        title={`Delete ${s.name}?`}
                        description="Its channels will be removed from lineup channels that use them."
                        onConfirm={() => del.mutate(s.id)}
                      >
                        <Button size="icon" variant="ghost" title="Delete">
                          <Trash2 />
                        </Button>
                      </ConfirmButton>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {editing && <SourceDialog key={editing.id ?? 'new'} id={editing.id} initial={editing.form} onClose={() => setEditing(null)} />}
    </>
  )
}

function SourceDialog({ id, initial, onClose }: { id?: string; initial: Form; onClose: () => void }) {
  const [f, setF] = useState(initial)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }))
  const save = useMutate(
    async () => {
      const body: Record<string, unknown> = { ...f, userAgent: f.userAgent || null }
      if (id) {
        delete body.createEpgSource
        if (!f.password) delete body.password
        return api(`/sources/${id}`, { method: 'PATCH', body })
      }
      return api('/sources', { body })
    },
    { invalidate: [['sources'], ['stats'], ['epg-sources']], success: id ? 'Saved' : 'Source added and synced', onSuccess: onClose },
  )
  const test = useMutate(() => api<{ ok: boolean; error?: string; account?: any }>('/sources/test', { body: f }), {
    onSuccess: (r) => (r.ok ? toast.success(`OK — ${r.account?.status ?? 'active'}, max ${r.account?.max_connections ?? '?'} connections`) : toast.error(r.error)),
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{id ? 'Edit source' : 'Add Xtream source'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Name">
            <Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="My provider" />
          </Field>
          <Field label="Server URL">
            <Input value={f.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="http://line.provider.tv:8080" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username">
              <Input value={f.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" />
            </Field>
            <Field label={id ? 'Password (leave blank to keep)' : 'Password'}>
              <Input type="password" value={f.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Stream format">
              <Select value={f.streamFormat} onValueChange={(v) => set('streamFormat', v as 'ts' | 'm3u8')}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ts">MPEG-TS (.ts)</SelectItem>
                  <SelectItem value="m3u8">HLS (.m3u8)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Priority (lower wins)">
              <Input type="number" value={f.priority} onChange={(e) => set('priority', Number(e.target.value))} />
            </Field>
          </div>
          <Field
            label="Connect via"
            hint="If the provider returns HTTP 403 to the Worker, use the browser: login, channel sync and provider EPG go through Cloudflare's headless Chrome. Playback is unaffected."
          >
            <Select value={f.fetchMode} onValueChange={(v) => set('fetchMode', v as 'direct' | 'browser')}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="direct">Direct (fastest)</SelectItem>
                <SelectItem value="browser">Cloudflare Browser (for providers that block Workers)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="User-Agent (optional)">
            <Input value={f.userAgent} onChange={(e) => set('userAgent', e.target.value)} placeholder="IPTVSmartersPro" />
          </Field>
          <div className="flex flex-wrap gap-6 pt-1">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={f.enabled} onCheckedChange={(v) => set('enabled', v)} /> Enabled
            </label>
            {!id && (
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={f.createEpgSource} onCheckedChange={(v) => set('createEpgSource', v)} /> Use provider EPG
              </label>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={test.isPending || !f.password} onClick={() => test.mutate(undefined)}>
            {test.isPending ? 'Testing…' : 'Test'}
          </Button>
          <Button disabled={save.isPending || !f.name || !f.baseUrl || !f.username || (!id && !f.password)} onClick={() => save.mutate(undefined)}>
            {save.isPending ? (id ? 'Saving…' : 'Adding & syncing…') : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
