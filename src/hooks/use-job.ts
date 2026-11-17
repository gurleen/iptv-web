import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api, type Job } from '@/lib/api'

const FINISHED = ['done', 'error']

/**
 * Start a background job and follow it until it finishes. Children of fan-out jobs (full refresh,
 * refresh all EPG) are followed too, so "running" stays true until the whole batch is done.
 */
export function useJob(opts: { invalidate?: string[][]; success?: (job: Job) => string } = {}) {
  const qc = useQueryClient()
  const [ids, setIds] = useState<string[]>([])
  const [key, setKey] = useState<string | null>(null)
  const toastId = useRef<string | number | undefined>(undefined)

  const jobs = useQuery({
    queryKey: ['jobs', ids],
    queryFn: () => Promise.all(ids.map((id) => api<Job>(`/jobs/${id}`))),
    enabled: ids.length > 0,
    refetchInterval: 2000,
  })

  useEffect(() => {
    const list = jobs.data
    if (!list?.length || list.length !== ids.length) return
    // follow fan-out children
    const children = list.flatMap((j) => ((j.result as any)?.queued ?? []).map((c: { id: string }) => c.id)).filter((id: string) => !ids.includes(id))
    if (children.length) {
      setIds((cur) => [...cur, ...children])
      return
    }
    if (!list.every((j) => FINISHED.includes(j.state))) return
    const failed = list.filter((j) => j.state === 'error')
    toast.dismiss(toastId.current)
    if (failed.length) toast.error(failed.map((j) => j.error).join('\n'), { duration: 15000 })
    else toast.success(opts.success ? opts.success(list[0]) : 'Done')
    for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k })
    qc.invalidateQueries({ queryKey: ['recent-jobs'] })
    setIds([])
    setKey(null)
  }, [jobs.data]) // eslint-disable-line react-hooks/exhaustive-deps

  async function start(fn: () => Promise<Job | Job[] | { job: Job | null }>, runKey = 'default', label = 'Running in the background…') {
    try {
      const r = await fn()
      const list = Array.isArray(r) ? r : 'job' in r ? (r.job ? [r.job] : []) : [r]
      if (!list.length) return
      setKey(runKey)
      setIds(list.map((j) => j.id))
      toastId.current = toast.loading(label, { description: 'You can leave this page; it keeps going.' })
      qc.invalidateQueries({ queryKey: ['recent-jobs'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  return { start, running: ids.length > 0, runningKey: key }
}
