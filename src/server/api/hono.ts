import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AuthResult } from '../lib/auth'
import { getDb } from '../db'
import { ErrorSchema } from './schemas'

export type AppEnv = { Bindings: Env; Variables: { auth: NonNullable<AuthResult> } }

export function newRouter() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: 'validation failed', issues: result.error.issues }, 400)
      }
    },
  })
}

export const db = (c: { env: Env }) => getDb(c.env)

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502,
    message: string,
  ) {
    super(message)
  }
}

export const notFound = (what = 'resource') => new HttpError(404, `${what} not found`)

type RouteDef = {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete'
  path: string
  tags: string[]
  summary: string
  description?: string
  params?: z.ZodObject<any>
  query?: z.ZodObject<any>
  body?: z.ZodTypeAny
  response: z.ZodTypeAny
  status?: 200 | 201
}

/** Thin wrapper around createRoute with sensible defaults (JSON in/out, standard errors). */
export function route<const R extends RouteDef>(r: R) {
  return createRoute({
    method: r.method,
    path: r.path,
    tags: r.tags,
    summary: r.summary,
    description: r.description,
    request: {
      ...(r.params ? { params: r.params } : {}),
      ...(r.query ? { query: r.query } : {}),
      ...(r.body ? { body: { content: { 'application/json': { schema: r.body } }, required: true } } : {}),
    },
    responses: {
      [r.status ?? 200]: { description: 'OK', content: { 'application/json': { schema: r.response } } },
      400: { description: 'Bad request', content: { 'application/json': { schema: ErrorSchema } } },
      404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } },
    },
  } as any) as ReturnType<typeof createRoute> & R
}

export const IdParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) })

export const bool = (v: unknown) => !!v

/** Read validated input (routes are built via `route()`, which erases Hono's validator typing). */
export const valid = (c: { req: unknown }, target: 'json' | 'param' | 'query'): any => (c.req as any).valid(target)
