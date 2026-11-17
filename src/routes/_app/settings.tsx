import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Copy, Download, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ConfirmButton } from '@/components/app/confirm'
import { PageHeader } from '@/components/app/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useMutate } from '@/hooks/use-mutate'
import { api, fmtAgo, type Token } from '@/lib/api'

export const Route = createFileRoute('/_app/settings')({ component: Settings })

function copy(text: string) {
  navigator.clipboard.writeText(text).then(() => toast.success('Copied'))
}

function Settings() {
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api<Token[]>('/tokens') })
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'output' | 'admin'>('output')
  const [created, setCreated] = useState<{ token: string; scope: string } | null>(null)
  const [outputToken, setOutputToken] = useState('')
  const create = useMutate(() => api<{ token: string }>('/tokens', { body: { name, scope } }), {
    invalidate: [['tokens']],
    onSuccess: (r) => {
      setCreated({ token: r.token, scope })
      if (scope === 'output') setOutputToken(r.token)
      setName('')
    },
  })
  const revoke = useMutate((id: string) => api(`/tokens/${id}`, { method: 'DELETE' }), { invalidate: [['tokens']], success: 'Revoked' })

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const t = outputToken || '<OUTPUT_TOKEN>'
  const urls = [
    ['M3U playlist', `${origin}/playlist.m3u?token=${t}`],
    ['M3U without events', `${origin}/playlist.m3u?events=none&token=${t}`],
    ['Events-only M3U', `${origin}/events.m3u?token=${t}`],
    ['XMLTV guide', `${origin}/epg.xml?token=${t}`],
    ['XMLTV guide (gzip)', `${origin}/epg.xml.gz?token=${t}`],
    ['Lineup JSON', `${origin}/api/output/lineup.json?token=${t}`],
    ['Events JSON', `${origin}/api/output/events.json?token=${t}`],
  ]

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Output URLs</CardTitle>
            <CardDescription>
              Give these to your player / downstream app. Paste an output token below (or create one) to fill them in. Add <code>&amp;tz=Europe/London</code> to
              change event times in the M3U.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Input placeholder="Output token" value={outputToken} onChange={(e) => setOutputToken(e.target.value)} className="font-mono" />
            {urls.map(([label, url]) => (
              <div key={label} className="flex items-center gap-2 text-sm">
                <span className="w-40 shrink-0 text-muted-foreground">{label}</span>
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{url}</code>
                <Button size="icon" variant="ghost" onClick={() => copy(url)}>
                  <Copy />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>API tokens</CardTitle>
            <CardDescription>
              <b>Output</b> tokens can only read the playlist, guide, streams and output JSON. <b>Admin</b> tokens have full API access — use one for agents.
              API docs: <a className="underline" href="/api/docs" target="_blank" rel="noreferrer">/api/docs</a> · agent guide:{' '}
              <a className="underline" href="/api/guide" target="_blank" rel="noreferrer">/api/guide</a>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                create.mutate(undefined)
              }}
            >
              <Input className="w-60" placeholder="Token name (e.g. TiviMate, Claude)" value={name} onChange={(e) => setName(e.target.value)} />
              <Select value={scope} onValueChange={(v) => setScope(v as 'output' | 'admin')}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="output">Output</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
              <Button disabled={!name || create.isPending}>
                <Plus /> Create
              </Button>
            </form>
            {created && (
              <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                <p className="mb-2">Copy this {created.scope} token now — it won't be shown again.</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all">{created.token}</code>
                  <Button size="icon" variant="ghost" onClick={() => copy(created.token)}>
                    <Copy />
                  </Button>
                </div>
              </div>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Token</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.data?.map((tk) => (
                  <TableRow key={tk.id}>
                    <TableCell>{tk.name}</TableCell>
                    <TableCell>
                      <Badge variant={tk.scope === 'admin' ? 'default' : 'secondary'}>{tk.scope}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{tk.prefix}…</TableCell>
                    <TableCell className="text-muted-foreground">{fmtAgo(tk.lastUsedAt)}</TableCell>
                    <TableCell className="text-right">
                      <ConfirmButton title={`Revoke “${tk.name}”?`} action="Revoke" onConfirm={() => revoke.mutate(tk.id)}>
                        <Button size="icon" variant="ghost">
                          <Trash2 />
                        </Button>
                      </ConfirmButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Backup</CardTitle>
            <CardDescription>Export categories, channels, streams, events and rules as JSON. Restore with POST /api/lineup/import.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" asChild>
              <a href="/api/lineup/export" download="lineup-backup.json">
                <Download /> Download backup
              </a>
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
