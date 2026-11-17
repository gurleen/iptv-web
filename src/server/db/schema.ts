import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

const now = sql`(unixepoch() * 1000)`
const timestamps = {
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
}

/** Upstream Xtream Codes providers. */
export const sources = sqliteTable('sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  username: text('username').notNull(),
  password: text('password').notNull(),
  /** Container used when redirecting to the provider: ts | m3u8 */
  streamFormat: text('stream_format').notNull().default('ts'),
  userAgent: text('user_agent'),
  /** direct = Worker fetch; browser = via Browser Rendering (for providers that block Worker traffic) */
  fetchMode: text('fetch_mode').notNull().default('direct'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** Lower number wins when a lineup channel has streams from several sources. */
  priority: integer('priority').notNull().default(100),
  lastSyncAt: integer('last_sync_at'),
  lastSyncStatus: text('last_sync_status'),
  lastSyncError: text('last_sync_error'),
  accountInfo: text('account_info', { mode: 'json' }).$type<Record<string, unknown>>(),
  ...timestamps,
})

/** Raw channels ("live streams") pulled from a source. id = `${sourceId}:${streamId}` */
export const sourceChannels = sqliteTable(
  'source_channels',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    streamId: integer('stream_id').notNull(),
    name: text('name').notNull(),
    categoryId: text('category_id'),
    categoryName: text('category_name'),
    logo: text('logo'),
    epgChannelId: text('epg_channel_id'),
    num: integer('num'),
    tvArchive: integer('tv_archive', { mode: 'boolean' }).notNull().default(false),
    seenAt: integer('seen_at').notNull(),
    removedAt: integer('removed_at'),
  },
  (t) => [
    index('source_channels_source_idx').on(t.sourceId),
    index('source_channels_name_idx').on(t.name),
    index('source_channels_cat_idx').on(t.sourceId, t.categoryName),
  ],
)

/** XMLTV providers. type=xtream sources are linked to a source and use its xmltv.php. */
export const epgSources = sqliteTable('epg_sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull().default('xmltv'), // xmltv | xtream
  url: text('url'),
  sourceId: text('source_id').references(() => sources.id, { onDelete: 'cascade' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  priority: integer('priority').notNull().default(100),
  lastSyncAt: integer('last_sync_at'),
  lastSyncStatus: text('last_sync_status'),
  lastSyncError: text('last_sync_error'),
  channelCount: integer('channel_count'),
  programmeCount: integer('programme_count'),
  ...timestamps,
})

/** <channel> entries seen in an EPG source (used for mapping). */
export const epgChannels = sqliteTable(
  'epg_channels',
  {
    epgSourceId: text('epg_source_id')
      .notNull()
      .references(() => epgSources.id, { onDelete: 'cascade' }),
    xmltvId: text('xmltv_id').notNull(),
    displayName: text('display_name'),
    icon: text('icon'),
    seenAt: integer('seen_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.epgSourceId, t.xmltvId] }),
    index('epg_channels_name_idx').on(t.displayName),
  ],
)

/** Programmes, only stored for EPG channels that are mapped into the lineup. */
export const programmes = sqliteTable(
  'programmes',
  {
    epgSourceId: text('epg_source_id')
      .notNull()
      .references(() => epgSources.id, { onDelete: 'cascade' }),
    xmltvId: text('xmltv_id').notNull(),
    start: integer('start').notNull(),
    stop: integer('stop').notNull(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    description: text('description'),
    category: text('category'),
    icon: text('icon'),
    episode: text('episode'),
  },
  (t) => [
    primaryKey({ columns: [t.epgSourceId, t.xmltvId, t.start] }),
    index('programmes_time_idx').on(t.start),
  ],
)

/** Output lineup groups (group-title in M3U). */
export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  sortOrder: integer('sort_order').notNull().default(0),
  /** Hidden categories are excluded from outputs. */
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  ...timestamps,
})

/** Channels in the cleaned-up output lineup. */
export const lineupChannels = sqliteTable(
  'lineup_channels',
  {
    id: text('id').primaryKey(),
    number: real('number'),
    name: text('name').notNull(),
    categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
    logo: text('logo'),
    /** tvg-id written into the M3U / output XMLTV. Defaults to the channel id. */
    tvgId: text('tvg_id'),
    epgSourceId: text('epg_source_id').references(() => epgSources.id, { onDelete: 'set null' }),
    epgChannelId: text('epg_channel_id'),
    /** linear = regular 24/7 channel, event = dynamic PPV/event feed */
    kind: text('kind').notNull().default('linear'),
    /** event-kind channels only show in outputs while they carry a live/upcoming event */
    hideWhenIdle: integer('hide_when_idle', { mode: 'boolean' }).notNull().default(false),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    notes: text('notes'),
    tags: text('tags', { mode: 'json' }).$type<string[]>(),
    /** set when the channel was created by an event rule */
    ruleId: text('rule_id'),
    /** when true, event rules will not rename/modify this channel */
    locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index('lineup_channels_cat_idx').on(t.categoryId),
    index('lineup_channels_epg_idx').on(t.epgSourceId, t.epgChannelId),
  ],
)

/** Upstream streams backing a lineup channel, in failover order. */
export const lineupStreams = sqliteTable(
  'lineup_streams',
  {
    lineupChannelId: text('lineup_channel_id')
      .notNull()
      .references(() => lineupChannels.id, { onDelete: 'cascade' }),
    sourceChannelId: text('source_channel_id')
      .notNull()
      .references(() => sourceChannels.id, { onDelete: 'cascade' }),
    priority: integer('priority').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.lineupChannelId, t.sourceChannelId] }),
    index('lineup_streams_src_idx').on(t.sourceChannelId),
  ],
)

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    description: text('description'),
    sport: text('sport'),
    league: text('league'),
    image: text('image'),
    startsAt: integer('starts_at'),
    endsAt: integer('ends_at'),
    /** null = derived from times. Otherwise scheduled | live | ended | cancelled */
    statusOverride: text('status_override'),
    hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
    origin: text('origin').notNull().default('manual'), // manual | rule
    ruleId: text('rule_id'),
    /** Stable key for rule-generated events so re-runs update instead of duplicating. */
    dedupeKey: text('dedupe_key'),
    /** Rule runs never overwrite or delete locked events (set automatically on manual edit). */
    locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (t) => [uniqueIndex('events_dedupe_idx').on(t.dedupeKey), index('events_start_idx').on(t.startsAt)],
)

export const eventChannels = sqliteTable(
  'event_channels',
  {
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    lineupChannelId: text('lineup_channel_id')
      .notNull()
      .references(() => lineupChannels.id, { onDelete: 'cascade' }),
    label: text('label'),
    priority: integer('priority').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.lineupChannelId] })],
)

export const eventRules = sqliteTable('event_rules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** source_channel = match upstream channel names; epg_programme = match programme titles on lineup channels */
  kind: text('kind').notNull(),
  pattern: text('pattern').notNull(),
  flags: text('flags').notNull().default('i'),
  /** source_channel: limit to these sources (null = all) */
  sourceIds: text('source_ids', { mode: 'json' }).$type<string[]>(),
  /** source_channel: regex the upstream category name must match */
  categoryPattern: text('category_pattern'),
  /** epg_programme: only look at lineup channels in these categories (null = all) */
  lineupCategoryIds: text('lineup_category_ids', { mode: 'json' }).$type<string[]>(),
  /** Template using named regex groups, e.g. "{title}". Defaults to the cleaned name. */
  titleTemplate: text('title_template'),
  sport: text('sport'),
  league: text('league'),
  timezone: text('timezone').notNull().default('America/New_York'),
  defaultDurationMinutes: integer('default_duration_minutes').notNull().default(180),
  /** source_channel: create/maintain an event-kind lineup channel for every match */
  autoAddChannel: integer('auto_add_channel', { mode: 'boolean' }).notNull().default(false),
  targetCategoryId: text('target_category_id').references(() => categories.id, {
    onDelete: 'set null',
  }),
  /** source_channel: skip matches with no parseable date */
  requireDate: integer('require_date', { mode: 'boolean' }).notNull().default(false),
  lastRunAt: integer('last_run_at'),
  lastRunMatches: integer('last_run_matches'),
  ...timestamps,
})

export const apiTokens = sqliteTable('api_tokens', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  scope: text('scope').notNull(), // admin | output
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  lastUsedAt: integer('last_used_at'),
  createdAt: integer('created_at').notNull().default(now),
})

/** Small key/value store for versions & settings. */
export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
