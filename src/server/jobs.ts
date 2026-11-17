import { setMeta } from './db'
import { runAllRules } from './events/rules'
import { syncAllEpg } from './sync/epg'
import { syncAllSources } from './sync/sources'

export async function runFullRefresh(env: Env) {
  const sources = await syncAllSources(env)
  const epg = await syncAllEpg(env)
  const rules = await runAllRules(env)
  await setMeta(env, 'last_full_refresh', new Date().toISOString())
  return { sources, epg, rules }
}

export async function handleScheduled(controller: ScheduledController, env: Env) {
  if (controller.cron === '*/30 * * * *') {
    await runAllRules(env)
  } else {
    await runFullRefresh(env)
  }
}
