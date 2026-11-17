import handler from '@tanstack/react-start/server-entry'
import { app } from './server/api/app'
import { handleScheduled } from './server/jobs'

const WORKER_PATHS = /^\/(api\/|mcp$|playlist\.m3u$|events\.m3u$|epg\.xml(\.gz)?$|stream\/)/

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname } = new URL(request.url)
    if (WORKER_PATHS.test(pathname)) return app.fetch(request, env, ctx)
    return handler.fetch(request)
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(controller, env))
  },
} satisfies ExportedHandler<Env>
