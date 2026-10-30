CREATE TABLE `sync_migration_control` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`legacy_revision` integer NOT NULL,
	`legacy_hash` text NOT NULL,
	`normalized_hash` text,
	`cue_count` integer,
	`started_at` text NOT NULL,
	`verified_at` text,
	`enabled_at` text
);
