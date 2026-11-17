import { z } from '@hono/zod-openapi'

export const Id = z.string().openapi({ example: 'ch_k3j9x0a2b1c4' })
export const Ts = z.number().int().nullable().openapi({ description: 'Unix epoch milliseconds' })
export const ErrorSchema = z.object({ error: z.string() }).openapi('Error')
export const OkSchema = z.object({ ok: z.boolean() }).openapi('Ok')

export const paginated = <T extends z.ZodTypeAny>(item: T, name: string) =>
  z
    .object({ items: z.array(item), total: z.number().int(), limit: z.number().int(), offset: z.number().int() })
    .openapi(name)

export const PageQuery = {
  limit: z.coerce.number().int().min(1).max(5000).default(100).optional(),
  offset: z.coerce.number().int().min(0).default(0).optional(),
}

const boolQuery = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional()
export { boolQuery }

// ---------- sources ----------
export const Source = z
  .object({
    id: Id,
    name: z.string(),
    baseUrl: z.string(),
    username: z.string(),
    streamFormat: z.enum(['ts', 'm3u8']),
    userAgent: z.string().nullable(),
    fetchMode: z.enum(['direct', 'browser']),
    enabled: z.boolean(),
    priority: z.number().int(),
    lastSyncAt: Ts,
    lastSyncStatus: z.string().nullable(),
    lastSyncError: z.string().nullable(),
    accountInfo: z.record(z.string(), z.unknown()).nullable(),
    channelCount: z.number().int().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .openapi('Source')

export const SourceInput = z
  .object({
    name: z.string().min(1),
    baseUrl: z.string().min(1).openapi({ example: 'http://provider.example:8080' }),
    username: z.string().min(1),
    password: z.string().min(1),
    streamFormat: z.enum(['ts', 'm3u8']).optional(),
    userAgent: z.string().nullable().optional(),
    fetchMode: z.enum(['direct', 'browser']).optional().openapi({
      description: "How to reach the provider. 'browser' routes API/EPG calls through Cloudflare Browser Rendering, for providers that block Worker traffic (HTTP 403).",
    }),
    enabled: z.boolean().optional(),
    priority: z.number().int().optional(),
    createEpgSource: z.boolean().optional().openapi({ description: "Also register the provider's xmltv.php as an EPG source (default true)" }),
    syncNow: z.boolean().optional().openapi({ description: 'Run a sync immediately (default true)' }),
  })
  .openapi('SourceInput')

export const SourcePatch = SourceInput.omit({ createEpgSource: true, syncNow: true }).partial().openapi('SourcePatch')

export const SourceChannel = z
  .object({
    id: z.string().openapi({ example: 'src_abc:12345', description: '`${sourceId}:${streamId}`' }),
    sourceId: z.string(),
    sourceName: z.string().nullable(),
    streamId: z.number().int(),
    name: z.string(),
    categoryName: z.string().nullable(),
    logo: z.string().nullable(),
    epgChannelId: z.string().nullable(),
    removed: z.boolean(),
    lineupChannelIds: z.array(z.string()),
  })
  .openapi('SourceChannel')

// ---------- epg ----------
export const EpgSource = z
  .object({
    id: Id,
    name: z.string(),
    type: z.enum(['xmltv', 'xtream']),
    url: z.string().nullable(),
    sourceId: z.string().nullable(),
    enabled: z.boolean(),
    priority: z.number().int(),
    lastSyncAt: Ts,
    lastSyncStatus: z.string().nullable(),
    lastSyncError: z.string().nullable(),
    channelCount: z.number().int().nullable(),
    programmeCount: z.number().int().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .openapi('EpgSource')

export const EpgSourceInput = z
  .object({
    name: z.string().min(1),
    type: z.enum(['xmltv', 'xtream']).optional(),
    url: z.string().url().nullable().optional().openapi({ description: 'XMLTV URL (.xml or .xml.gz). Required for type=xmltv' }),
    sourceId: z.string().nullable().optional().openapi({ description: 'For type=xtream' }),
    enabled: z.boolean().optional(),
    priority: z.number().int().optional(),
  })
  .openapi('EpgSourceInput')

export const EpgChannel = z
  .object({
    epgSourceId: z.string(),
    xmltvId: z.string(),
    displayName: z.string().nullable(),
    icon: z.string().nullable(),
  })
  .openapi('EpgChannel')

export const Programme = z
  .object({
    epgSourceId: z.string(),
    xmltvId: z.string(),
    start: z.number(),
    stop: z.number(),
    title: z.string(),
    subtitle: z.string().nullable(),
    description: z.string().nullable(),
    category: z.string().nullable(),
    icon: z.string().nullable(),
    episode: z.string().nullable(),
  })
  .openapi('Programme')

// ---------- lineup ----------
export const Category = z
  .object({
    id: Id,
    name: z.string(),
    sortOrder: z.number().int(),
    hidden: z.boolean(),
    channelCount: z.number().int(),
  })
  .openapi('Category')

export const CategoryInput = z
  .object({ name: z.string().min(1), sortOrder: z.number().int().optional(), hidden: z.boolean().optional() })
  .openapi('CategoryInput')

export const LineupStream = z
  .object({
    sourceChannelId: z.string(),
    priority: z.number().int(),
    name: z.string().nullable(),
    sourceId: z.string().nullable(),
    sourceName: z.string().nullable(),
    categoryName: z.string().nullable(),
    removed: z.boolean(),
  })
  .openapi('LineupStream')

export const ChannelKind = z.enum(['linear', 'event'])

export const LineupChannel = z
  .object({
    id: Id,
    number: z.number().nullable(),
    name: z.string(),
    categoryId: z.string().nullable(),
    categoryName: z.string().nullable(),
    logo: z.string().nullable(),
    tvgId: z.string().nullable(),
    epgSourceId: z.string().nullable(),
    epgChannelId: z.string().nullable(),
    kind: ChannelKind,
    hideWhenIdle: z.boolean(),
    enabled: z.boolean(),
    sortOrder: z.number().int(),
    notes: z.string().nullable(),
    tags: z.array(z.string()).nullable(),
    ruleId: z.string().nullable(),
    locked: z.boolean(),
    streams: z.array(LineupStream),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .openapi('LineupChannel')

const channelFields = {
  number: z.number().nullable().optional(),
  name: z.string().min(1).optional(),
  categoryId: z.string().nullable().optional(),
  categoryName: z
    .string()
    .nullable()
    .optional()
    .openapi({ description: 'Convenience: set category by name, creating it if needed. Overrides categoryId.' }),
  logo: z.string().nullable().optional(),
  tvgId: z.string().nullable().optional(),
  epgSourceId: z.string().nullable().optional(),
  epgChannelId: z.string().nullable().optional(),
  kind: ChannelKind.optional(),
  hideWhenIdle: z.boolean().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  notes: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  locked: z.boolean().optional(),
}

export const LineupChannelPatch = z.object(channelFields).openapi('LineupChannelPatch')
export const LineupChannelInput = z
  .object({
    ...channelFields,
    name: z.string().min(1),
    streams: z.array(z.string()).optional().openapi({ description: 'Source channel ids in failover order' }),
  })
  .openapi('LineupChannelInput')

// ---------- events ----------
export const EventStatus = z.enum(['scheduled', 'live', 'ended', 'cancelled'])

export const EventChannelLink = z
  .object({ lineupChannelId: z.string(), label: z.string().nullable().optional(), priority: z.number().int().optional() })
  .openapi('EventChannelLink')

export const Event = z
  .object({
    id: Id,
    title: z.string(),
    subtitle: z.string().nullable(),
    description: z.string().nullable(),
    sport: z.string().nullable(),
    league: z.string().nullable(),
    image: z.string().nullable(),
    startsAt: Ts,
    endsAt: Ts,
    status: EventStatus,
    statusOverride: EventStatus.nullable(),
    hidden: z.boolean(),
    origin: z.enum(['manual', 'rule']),
    ruleId: z.string().nullable(),
    locked: z.boolean(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    channels: z.array(
      z.object({ lineupChannelId: z.string(), name: z.string(), number: z.number().nullable(), label: z.string().nullable(), priority: z.number() }),
    ),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .openapi('Event')

const eventFields = {
  title: z.string().min(1).optional(),
  subtitle: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  sport: z.string().nullable().optional(),
  league: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  startsAt: z
    .union([z.number(), z.string()])
    .nullable()
    .optional()
    .openapi({ description: 'Epoch ms or ISO-8601 string' }),
  endsAt: z.union([z.number(), z.string()]).nullable().optional(),
  statusOverride: EventStatus.nullable().optional(),
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  channels: z.array(EventChannelLink).optional().openapi({ description: 'Replaces linked channels when provided' }),
}
export const EventPatch = z.object(eventFields).openapi('EventPatch')
export const EventInput = z.object({ ...eventFields, title: z.string().min(1) }).openapi('EventInput')

export const Rule = z
  .object({
    id: Id,
    name: z.string(),
    enabled: z.boolean(),
    kind: z.enum(['source_channel', 'epg_programme']),
    pattern: z.string(),
    flags: z.string(),
    sourceIds: z.array(z.string()).nullable(),
    categoryPattern: z.string().nullable(),
    lineupCategoryIds: z.array(z.string()).nullable(),
    titleTemplate: z.string().nullable(),
    sport: z.string().nullable(),
    league: z.string().nullable(),
    timezone: z.string(),
    defaultDurationMinutes: z.number().int(),
    autoAddChannel: z.boolean(),
    targetCategoryId: z.string().nullable(),
    requireDate: z.boolean(),
    lastRunAt: Ts,
    lastRunMatches: z.number().int().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .openapi('EventRule')

const ruleFields = {
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  kind: z.enum(['source_channel', 'epg_programme']).optional(),
  pattern: z.string().min(1).optional().openapi({
    description:
      'JS regex. Named groups are available to titleTemplate. source_channel rules may use (?<date>…) / (?<time>…) groups; otherwise the date is detected heuristically.',
    example: '^PPV\\s*\\d+\\s*[:|]\\s*(?<title>.+)',
  }),
  flags: z.string().optional(),
  sourceIds: z.array(z.string()).nullable().optional(),
  categoryPattern: z.string().nullable().optional(),
  lineupCategoryIds: z.array(z.string()).nullable().optional(),
  titleTemplate: z.string().nullable().optional().openapi({ example: '{title}' }),
  sport: z.string().nullable().optional(),
  league: z.string().nullable().optional(),
  timezone: z.string().optional(),
  defaultDurationMinutes: z.number().int().min(1).optional(),
  autoAddChannel: z.boolean().optional(),
  targetCategoryId: z.string().nullable().optional(),
  requireDate: z.boolean().optional(),
}
export const RulePatch = z.object(ruleFields).openapi('EventRulePatch')
export const RuleInput = z
  .object({ ...ruleFields, name: z.string().min(1), kind: z.enum(['source_channel', 'epg_programme']), pattern: z.string().min(1) })
  .openapi('EventRuleInput')

export const Token = z
  .object({ id: Id, name: z.string(), scope: z.enum(['admin', 'output']), prefix: z.string(), lastUsedAt: Ts, createdAt: z.number() })
  .openapi('ApiToken')
