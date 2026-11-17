CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_unique` ON `categories` (`name`);--> statement-breakpoint
CREATE TABLE `epg_channels` (
	`epg_source_id` text NOT NULL,
	`xmltv_id` text NOT NULL,
	`display_name` text,
	`icon` text,
	`seen_at` integer NOT NULL,
	PRIMARY KEY(`epg_source_id`, `xmltv_id`),
	FOREIGN KEY (`epg_source_id`) REFERENCES `epg_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `epg_channels_name_idx` ON `epg_channels` (`display_name`);--> statement-breakpoint
CREATE TABLE `epg_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'xmltv' NOT NULL,
	`url` text,
	`source_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`last_sync_at` integer,
	`last_sync_status` text,
	`last_sync_error` text,
	`channel_count` integer,
	`programme_count` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `event_channels` (
	`event_id` text NOT NULL,
	`lineup_channel_id` text NOT NULL,
	`label` text,
	`priority` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`event_id`, `lineup_channel_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lineup_channel_id`) REFERENCES `lineup_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `event_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`kind` text NOT NULL,
	`pattern` text NOT NULL,
	`flags` text DEFAULT 'i' NOT NULL,
	`source_ids` text,
	`category_pattern` text,
	`lineup_category_ids` text,
	`title_template` text,
	`sport` text,
	`league` text,
	`timezone` text DEFAULT 'America/New_York' NOT NULL,
	`default_duration_minutes` integer DEFAULT 180 NOT NULL,
	`auto_add_channel` integer DEFAULT false NOT NULL,
	`target_category_id` text,
	`require_date` integer DEFAULT false NOT NULL,
	`last_run_at` integer,
	`last_run_matches` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`target_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`subtitle` text,
	`description` text,
	`sport` text,
	`league` text,
	`image` text,
	`starts_at` integer,
	`ends_at` integer,
	`status_override` text,
	`hidden` integer DEFAULT false NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`rule_id` text,
	`dedupe_key` text,
	`locked` integer DEFAULT false NOT NULL,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_dedupe_idx` ON `events` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `events_start_idx` ON `events` (`starts_at`);--> statement-breakpoint
CREATE TABLE `lineup_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`number` real,
	`name` text NOT NULL,
	`category_id` text,
	`logo` text,
	`tvg_id` text,
	`epg_source_id` text,
	`epg_channel_id` text,
	`kind` text DEFAULT 'linear' NOT NULL,
	`hide_when_idle` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`tags` text,
	`rule_id` text,
	`locked` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`epg_source_id`) REFERENCES `epg_sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `lineup_channels_cat_idx` ON `lineup_channels` (`category_id`);--> statement-breakpoint
CREATE INDEX `lineup_channels_epg_idx` ON `lineup_channels` (`epg_source_id`,`epg_channel_id`);--> statement-breakpoint
CREATE TABLE `lineup_streams` (
	`lineup_channel_id` text NOT NULL,
	`source_channel_id` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`lineup_channel_id`, `source_channel_id`),
	FOREIGN KEY (`lineup_channel_id`) REFERENCES `lineup_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_channel_id`) REFERENCES `source_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lineup_streams_src_idx` ON `lineup_streams` (`source_channel_id`);--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `programmes` (
	`epg_source_id` text NOT NULL,
	`xmltv_id` text NOT NULL,
	`start` integer NOT NULL,
	`stop` integer NOT NULL,
	`title` text NOT NULL,
	`subtitle` text,
	`description` text,
	`category` text,
	`icon` text,
	`episode` text,
	PRIMARY KEY(`epg_source_id`, `xmltv_id`, `start`),
	FOREIGN KEY (`epg_source_id`) REFERENCES `epg_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `programmes_time_idx` ON `programmes` (`start`);--> statement-breakpoint
CREATE TABLE `source_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`stream_id` integer NOT NULL,
	`name` text NOT NULL,
	`category_id` text,
	`category_name` text,
	`logo` text,
	`epg_channel_id` text,
	`num` integer,
	`tv_archive` integer DEFAULT false NOT NULL,
	`seen_at` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `source_channels_source_idx` ON `source_channels` (`source_id`);--> statement-breakpoint
CREATE INDEX `source_channels_name_idx` ON `source_channels` (`name`);--> statement-breakpoint
CREATE INDEX `source_channels_cat_idx` ON `source_channels` (`source_id`,`category_name`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`username` text NOT NULL,
	`password` text NOT NULL,
	`stream_format` text DEFAULT 'ts' NOT NULL,
	`user_agent` text,
	`enabled` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`last_sync_at` integer,
	`last_sync_status` text,
	`last_sync_error` text,
	`account_info` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
