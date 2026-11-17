import { bumpVersion, setMeta } from './db'
import { runAllRules } from './events/rules'
import { newId } from './lib/ids'
import { syncEpgSource } from './sync/epg'
import { syncSource } from './sync/sources'

export type JobType = 'source_sync' | 'epg_refresh' | 'rules' | 'full_refresh'
export type JobState = 'queued' | 'running' | 'done' | 'error'
export type Job = {
  id: string
  type: JobType
  targetId: string | null
  state: JobState
  result: unknown
  error: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

/** A job stuck in "running" longer than this was killed (deploy, crash) — report it as failed. */
const STALE_MS = 20 * 60_000

function rowToJob(r: Record<string, any>): Job {
  const stale = r.state === 'running' && r.started_at && Date.now() - r.started_at > STALE_MS
  return {
    id: r.id,
    type: r.type,
    targetId: r.target_id,
    state: stale ? 'error' : r.state,
    result: r.result ? JSON.parse(r.result) : null,
    error: stale ? 'Job stopped unexpectedly (timed out or the Worker restarted)' : r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }
}

export async function getJob(env: Env, id: string) {
  const r = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first()
  return r ? rowToJob(r) : null
}

export async function listJobs(env: Env, limit = 30) {
  const { results } = await env.DB.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').bind(limit).all()
  return results.map(rowToJob)
}

/**
 * Queue a job. If an identical job (same type + target) is already queued or running, that one is
 * returned instead, so repeated clicks don't pile up work.
 */
export async function enqueueJob(env: Env, type: JobType, targetId: string | null = null): Promise<Job> {
  const existing = await env.DB.prepare(
    `SELECT * FROM jobs WHERE type = ? AND COALESCE(target_id, '') = ? AND state IN ('queued', 'running')
       AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(type, targetId ?? '', Date.now() - STALE_MS)
    .first()
  if (existing) return rowToJob(existing)

  const id = newId('job')
  const now = Date.now()
  await env.DB.prepare('INSERT INTO jobs (id, type, target_id, state, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, type, targetId, 'queued', now)
    .run()
  await env.JOBS.send({ jobId: id })
  // keep the table small
  await env.DB.prepare('DELETE FROM jobs WHERE created_at < ?').bind(now - 7 * 86400_000).run()
  return (await getJob(env, id))!
}

async function run(env: Env, job: Job): Promise<unknown> {
  switch (job.type) {
    case 'source_sync':
      if (!job.targetId) throw new Error('source_sync needs a target')
      return syncSource(env, job.targetId)
    case 'epg_refresh':
      if (job.targetId) return syncEpgSource(env, job.targetId)
      {
        const { results } = await env.DB.prepare('SELECT id FROM epg_sources WHERE enabled = 1 ORDER BY priority').all<{ id: string }>()
        const children: Job[] = []
        for (const e of results) children.push(await enqueueJob(env, 'epg_refresh', e.id))
        children.push(await enqueueJob(env, 'rules'))
        await env.DB.prepare('DELETE FROM programmes WHERE stop < ?').bind(Date.now() - 24 * 3600_000).run()
        return { queued: children.map((c) => ({ id: c.id, type: c.type, targetId: c.targetId })) }
      }
    case 'rules': {
      const rules = await runAllRules(env)
      if (job.targetId === 'full') {
        await setMeta(env, 'last_full_refresh', new Date().toISOString())
        await bumpVersion(env, 'lineup_version')
      }
      return rules
    }
    case 'full_refresh': {
      // fan out so each step gets its own CPU budget; the consumer runs them one at a time, in order
      const { results: srcs } = await env.DB.prepare('SELECT id FROM sources WHERE enabled = 1 ORDER BY priority').all<{ id: string }>()
      const { results: epgs } = await env.DB.prepare('SELECT id FROM epg_sources WHERE enabled = 1 ORDER BY priority').all<{ id: string }>()
      const children: Job[] = []
      for (const s of srcs) children.push(await enqueueJob(env, 'source_sync', s.id))
      for (const e of epgs) children.push(await enqueueJob(env, 'epg_refresh', e.id))
      children.push(await enqueueJob(env, 'rules', 'full'))
      return { queued: children.map((c) => ({ id: c.id, type: c.type, targetId: c.targetId })) }
    }
  }
}

/** Queue consumer: runs one job per message. Never retried automatically (syncs are expensive). */
export async function handleQueue(batch: MessageBatch<{ jobId: string }>, env: Env) {
  for (const msg of batch.messages) {
    const job = await getJob(env, msg.body.jobId)
    if (!job || job.state === 'done' || job.state === 'error') {
      msg.ack()
      continue
    }
    await env.DB.prepare("UPDATE jobs SET state = 'running', started_at = ? WHERE id = ?").bind(Date.now(), job.id).run()
    try {
      const result = await run(env, job)
      // sync helpers report failures in their result rather than throwing
      const failed = result && typeof result === 'object' && 'ok' in result && (result as { ok: boolean }).ok === false
      await env.DB.prepare('UPDATE jobs SET state = ?, result = ?, error = ?, finished_at = ? WHERE id = ?')
        .bind(failed ? 'error' : 'done', JSON.stringify(result ?? null), failed ? String((result as any).error ?? 'failed') : null, Date.now(), job.id)
        .run()
    } catch (e) {
      await env.DB.prepare("UPDATE jobs SET state = 'error', error = ?, finished_at = ? WHERE id = ?")
        .bind(e instanceof Error ? e.message : String(e), Date.now(), job.id)
        .run()
    }
    msg.ack()
  }
}

export async function handleScheduled(controller: ScheduledController, env: Env) {
  if (controller.cron === '*/30 * * * *') await enqueueJob(env, 'rules')
  else await enqueueJob(env, 'full_refresh')
}
