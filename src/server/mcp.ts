import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { AGENT_GUIDE } from './api/guide'

/** Calls the REST API in-process, as the MCP caller (same bearer token). */
export type ApiCaller = (method: string, path: string, body?: unknown) => Promise<{ status: number; data: unknown }>

const MAX_CHARS = 120_000

function result(r: { status: number; data: unknown }) {
  let text = JSON.stringify(r.data, null, 1)
  if (text.length > MAX_CHARS) {
    text = `${text.slice(0, MAX_CHARS)}\n…[truncated ${text.length - MAX_CHARS} chars — use limit/offset or narrower filters]`
  }
  return { content: [{ type: 'text' as const, text }], isError: r.status >= 400 }
}

function qs(params: Record<string, unknown>) {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    u.set(k, String(v))
  }
  const s = u.toString()
  return s ? `?${s}` : ''
}

const ids = z.array(z.string())
const page = {
  limit: z.number().int().min(1).max(1000).optional().describe('Page size (default 100)'),
  offset: z.number().int().min(0).optional(),
}
const channelPatch = {
  name: z.string().optional(),
  number: z.number().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  categoryName: z.string().nullable().optional().describe('Set category by name (created if missing); overrides categoryId'),
  logo: z.string().nullable().optional(),
  tvgId: z.string().nullable().optional(),
  epgSourceId: z.string().nullable().optional(),
  epgChannelId: z.string().nullable().optional().describe('XMLTV channel id; set together with epgSourceId'),
  kind: z.enum(['linear', 'event']).optional(),
  hideWhenIdle: z.boolean().optional(),
  enabled: z.boolean().optional(),
  notes: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  locked: z.boolean().optional(),
}
const eventFields = {
  title: z.string().optional(),
  subtitle: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  sport: z.string().nullable().optional(),
  league: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  startsAt: z.union([z.number(), z.string()]).nullable().optional().describe('Epoch ms or ISO-8601'),
  endsAt: z.union([z.number(), z.string()]).nullable().optional(),
  statusOverride: z.enum(['scheduled', 'live', 'ended', 'cancelled']).nullable().optional(),
  hidden: z.boolean().optional(),
  channels: z
    .array(z.object({ lineupChannelId: z.string(), label: z.string().nullable().optional() }))
    .optional()
    .describe('Replaces linked lineup channels (first = primary)'),
}
const ruleFields = {
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  kind: z.enum(['source_channel', 'epg_programme']).optional().describe('source_channel = upstream channel names; epg_programme = guide titles'),
  pattern: z.string().optional().describe('JS regex; named groups usable in titleTemplate, e.g. (?<title>.+)'),
  flags: z.string().optional(),
  sourceIds: z.array(z.string()).nullable().optional(),
  categoryPattern: z.string().nullable().optional().describe('source_channel: regex on upstream category'),
  lineupCategoryIds: z.array(z.string()).nullable().optional().describe('epg_programme: limit to these lineup categories'),
  titleTemplate: z.string().nullable().optional(),
  sport: z.string().nullable().optional(),
  league: z.string().nullable().optional(),
  timezone: z.string().optional(),
  defaultDurationMinutes: z.number().int().optional(),
  autoAddChannel: z.boolean().optional().describe('source_channel: create hide-when-idle event channels for matches'),
  targetCategoryId: z.string().nullable().optional(),
  requireDate: z.boolean().optional(),
}

export function buildMcpServer(api: ApiCaller) {
  const server = new McpServer(
    { name: 'iptv-web', version: '1.0.0' },
    { instructions: AGENT_GUIDE.replace(/\{\{BASE\}\}\/api/g, '(REST API)').replace(/\{\{BASE\}\}/g, '') },
  )
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (a: z.infer<z.ZodObject<S>>) => Promise<{ status: number; data: unknown }>,
    readOnly = false,
  ) =>
    server.registerTool(
      name,
      { description, inputSchema: shape, annotations: { readOnlyHint: readOnly, destructiveHint: false } },
      (async (args: z.infer<z.ZodObject<S>>) => result(await run(args))) as any,
    )

  // ---------- overview / sources ----------
  tool('get_stats', 'Counts and sync status: sources, upstream channels, lineup size, EPG coverage, broken channels, events.', {}, () => api('GET', '/stats'), true)
  tool('list_sources', 'List Xtream sources with sync status and channel counts.', {}, () => api('GET', '/sources'), true)
  tool(
    'sync_sources',
    'Re-sync channels from one source (sourceId) or all enabled sources.',
    { sourceId: z.string().optional() },
    (a) => (a.sourceId ? api('POST', `/sources/${a.sourceId}/sync`) : api('POST', '/sources/sync')),
  )
  tool(
    'list_source_categories',
    'Upstream categories with channel counts and how many are already in the lineup.',
    { sourceId: z.string().optional() },
    (a) => api('GET', `/source-categories${qs(a)}`),
    true,
  )
  tool(
    'search_source_channels',
    'Search raw upstream channels (ids look like "<sourceId>:<streamId>"). Use to find channels to add to the lineup.',
    {
      q: z.string().optional().describe('Substring of name; * = wildcard'),
      regex: z.string().optional().describe('JS regex on name (case-insensitive)'),
      sourceId: z.string().optional(),
      category: z.string().optional().describe('Exact upstream category name'),
      categoryLike: z.string().optional(),
      inLineup: z.boolean().optional().describe('false = only channels not yet in the lineup'),
      ...page,
    },
    (a) => api('GET', `/source-channels${qs(a)}`),
    true,
  )

  // ---------- lineup ----------
  tool(
    'list_lineup_channels',
    'List lineup channels in output order, with streams and EPG mapping.',
    {
      q: z.string().optional(),
      categoryId: z.string().optional().describe("Category id or 'none'"),
      kind: z.enum(['linear', 'event']).optional(),
      enabled: z.boolean().optional(),
      hasEpg: z.boolean().optional(),
      brokenStreams: z.boolean().optional().describe('true = every upstream stream has disappeared'),
      tag: z.string().optional(),
      ...page,
    },
    (a) => api('GET', `/lineup/channels${qs(a)}`),
    true,
  )
  tool(
    'add_channels_from_source',
    'Add upstream channels to the lineup (one lineup channel each). Names are cleaned and provider EPG auto-mapped by default.',
    {
      sourceChannelIds: ids.min(1),
      categoryName: z.string().optional().describe('Put all in this category (created if missing)'),
      categoryId: z.string().optional(),
      useSourceCategory: z.boolean().optional().describe('Mirror each upstream category'),
      cleanNames: z.boolean().optional(),
      mapEpg: z.boolean().optional(),
      startNumber: z.number().optional(),
      kind: z.enum(['linear', 'event']).optional(),
    },
    (a) => api('POST', '/lineup/channels/from-source', a),
  )
  tool(
    'create_channel',
    'Create a lineup channel manually (streams = upstream channel ids in failover order).',
    { ...channelPatch, name: z.string(), streams: ids.optional() },
    (a) => api('POST', '/lineup/channels', a),
  )
  tool(
    'update_channels',
    'Bulk-update lineup channels. Each update is {id, ...fields to change}.',
    { updates: z.array(z.object({ id: z.string(), ...channelPatch })).min(1) },
    (a) => api('PATCH', '/lineup/channels', a),
  )
  tool('delete_channels', 'Delete lineup channels.', { ids: ids.min(1) }, (a) => api('POST', '/lineup/channels/bulk-delete', a))
  tool(
    'rename_channels',
    'Regex find/replace across lineup channel names. Use dryRun first.',
    {
      pattern: z.string(),
      replacement: z.string(),
      flags: z.string().optional().describe("Default 'gi'"),
      ids: ids.optional(),
      categoryId: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
    (a) => api('POST', '/lineup/channels/rename', a),
  )
  tool(
    'clean_channel_names',
    'Heuristic cleanup (country prefixes, HD/FHD/4K tags, symbols). Use dryRun first.',
    { ids: ids.optional(), categoryId: z.string().optional(), dryRun: z.boolean().optional() },
    (a) => api('POST', '/lineup/channels/clean-names', a),
  )
  tool(
    'merge_channels',
    "Merge duplicates into targetId: the others' streams become failover backups, then they are deleted.",
    { targetId: z.string(), sourceIds: ids.min(1) },
    (a) => api('POST', '/lineup/channels/merge', a),
  )
  tool(
    'renumber_channels',
    'Assign sequential numbers: to ids in the given order, or to a category / the whole lineup in current order.',
    { ids: ids.optional(), categoryId: z.string().optional(), start: z.number(), step: z.number().optional() },
    (a) => api('POST', '/lineup/channels/renumber', a),
  )
  tool(
    'set_channel_streams',
    "Replace a lineup channel's upstream streams (failover order).",
    { id: z.string(), sourceChannelIds: ids },
    (a) => api('PUT', `/lineup/channels/${a.id}/streams`, { sourceChannelIds: a.sourceChannelIds }),
  )
  tool(
    'manage_categories',
    'Lineup categories. action: list | create {name} | update {id, name?, hidden?} | delete {id, moveTo?} | reorder {ids}.',
    {
      action: z.enum(['list', 'create', 'update', 'delete', 'reorder']),
      id: z.string().optional(),
      name: z.string().optional(),
      hidden: z.boolean().optional(),
      moveTo: z.string().optional().describe('delete: move its channels to this category'),
      ids: ids.optional().describe('reorder: category ids in order'),
    },
    async (a) => {
      switch (a.action) {
        case 'list':
          return api('GET', '/lineup/categories')
        case 'create':
          return api('POST', '/lineup/categories', { name: a.name, hidden: a.hidden })
        case 'update':
          return api('PATCH', `/lineup/categories/${a.id}`, { name: a.name, hidden: a.hidden })
        case 'delete':
          return api('DELETE', `/lineup/categories/${a.id}${qs({ moveTo: a.moveTo })}`)
        case 'reorder':
          return api('POST', '/lineup/categories/reorder', { ids: a.ids })
      }
    },
  )

  // ---------- EPG ----------
  tool(
    'suggest_epg',
    'Fuzzy-matched EPG channel candidates for a lineup channel (optionally with a custom search name).',
    { channelId: z.string(), q: z.string().optional() },
    (a) => api('GET', `/lineup/channels/${a.channelId}/epg-suggestions${qs({ q: a.q })}`),
    true,
  )
  tool(
    'search_epg_channels',
    'Search EPG channels (xmltv ids / display names) across EPG sources.',
    { q: z.string().optional(), epgSourceId: z.string().optional(), ...page },
    (a) => api('GET', `/epg/channels${qs(a)}`),
    true,
  )
  tool(
    'auto_map_epg',
    'Map lineup channels to EPG channels by name similarity. Use dryRun first; then call refresh_epg.',
    {
      ids: ids.optional(),
      epgSourceIds: ids.optional(),
      minScore: z.number().min(0).max(1).optional().describe('Default 0.85'),
      onlyUnmapped: z.boolean().optional(),
      dryRun: z.boolean().optional(),
    },
    (a) => api('POST', '/lineup/auto-map-epg', a),
  )
  tool('refresh_epg', 'Reload all EPG sources (needed after changing EPG mappings), then re-run event rules.', {}, () => api('POST', '/epg/refresh'))
  tool(
    'get_channel_guide',
    "A lineup channel's programmes (default: next 24h).",
    { channelId: z.string(), from: z.number().optional(), to: z.number().optional() },
    (a) => api('GET', `/lineup/channels/${a.channelId}/guide${qs({ from: a.from, to: a.to })}`),
    true,
  )

  // ---------- events ----------
  tool(
    'list_events',
    'List events. status is a comma list of scheduled,live,ended,cancelled (default scheduled,live).',
    {
      status: z.string().optional(),
      q: z.string().optional(),
      sport: z.string().optional(),
      origin: z.enum(['manual', 'rule']).optional(),
      from: z.number().optional(),
      to: z.number().optional(),
      ...page,
    },
    (a) => api('GET', `/events${qs(a)}`),
    true,
  )
  tool('create_event', 'Create an event linked to lineup channels.', { ...eventFields, title: z.string() }, (a) => api('POST', '/events', a))
  tool(
    'update_events',
    'Bulk-update events ({id, ...fields}). Edited rule events get locked so rules stop changing them.',
    { updates: z.array(z.object({ id: z.string(), ...eventFields, locked: z.boolean().optional() })).min(1) },
    (a) => api('PATCH', '/events', a),
  )
  tool('delete_event', 'Delete an event (rule events may be recreated — prefer hidden=true).', { id: z.string() }, (a) => api('DELETE', `/events/${a.id}`))
  tool('list_event_rules', 'List event rules.', {}, () => api('GET', '/event-rules'), true)
  tool(
    'preview_event_rule',
    'Dry-run a rule definition (or a saved rule by id) and see which events it would produce.',
    { id: z.string().optional().describe('Saved rule id; if set, other fields are ignored'), ...ruleFields },
    (a) => {
      const { id, ...rule } = a
      return id ? api('GET', `/event-rules/${id}/preview`) : api('POST', '/event-rules/preview', rule)
    },
    true,
  )
  tool(
    'save_event_rule',
    'Create a rule (no id; needs name, kind, pattern) or update one (with id). Runs it afterwards.',
    { id: z.string().optional(), ...ruleFields },
    async (a) => {
      const { id, ...rule } = a
      if (!id) return api('POST', '/event-rules', rule)
      const r = await api('PATCH', `/event-rules/${id}`, rule)
      if (r.status < 400) await api('POST', `/event-rules/${id}/run`)
      return r
    },
  )
  tool(
    'delete_event_rule',
    'Delete a rule (and its unlocked events / auto channels unless keepEvents).',
    { id: z.string(), keepEvents: z.boolean().optional() },
    (a) => api('DELETE', `/event-rules/${a.id}${qs({ keepEvents: a.keepEvents })}`),
  )
  tool('run_event_rules', 'Run all enabled event rules now.', {}, () => api('POST', '/event-rules/run'))

  // ---------- backup / outputs ----------
  tool('export_lineup', 'Full lineup snapshot (categories, channels, streams, events, rules) — take one before big changes.', {}, () => api('GET', '/lineup/export'), true)
  tool(
    'preview_output',
    'What players/downstream apps see: the output lineup JSON (with events).',
    {},
    () => api('GET', '/output/lineup.json'),
    true,
  )

  return server
}

/** Stateless Streamable HTTP endpoint: a fresh server + transport per request. */
export async function handleMcp(request: Request, api: ApiCaller) {
  const server = buildMcpServer(api)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  return transport.handleRequest(request)
}
