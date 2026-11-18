CREATE TABLE `sports_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `events` ADD `game_league` text;--> statement-breakpoint
ALTER TABLE `events` ADD `game_id` text;--> statement-breakpoint
ALTER TABLE `events` ADD `game_link` text;