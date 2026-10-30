CREATE TABLE `sync_activity` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`sequence` integer,
	`cue_id` text,
	`discussion_id` text,
	`reply_id` text,
	`scene_id` text,
	`page` integer,
	`anchor_y_micros` integer,
	`scene_ids` text,
	`target_profile_ids` text,
	`actor_id` text NOT NULL,
	`type` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `sync_activity_workspace_created_idx` ON `sync_activity` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sync_conflicts` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `sync_cues` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`position_version` integer DEFAULT 1 NOT NULL,
	`lifecycle_version` integer DEFAULT 1 NOT NULL,
	`assignment_version` integer DEFAULT 1 NOT NULL,
	`text_revision` integer DEFAULT 0 NOT NULL,
	`number` text,
	`mode` text NOT NULL,
	`blackout` integer DEFAULT false NOT NULL,
	`scene_id` text NOT NULL,
	`page` integer NOT NULL,
	`anchor_type` text NOT NULL,
	`selected_text` text NOT NULL,
	`enclosing_line` text NOT NULL,
	`anchor_x_micros` integer,
	`anchor_y_micros` integer,
	`anchor_order_micros` integer NOT NULL,
	`owner_id` text,
	`deleted_at` text,
	`deleted_by` text,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`technical_notes` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_cues_workspace_number_unique` ON `sync_cues` (`workspace_id`,`number`);--> statement-breakpoint
CREATE INDEX `sync_cues_workspace_position_idx` ON `sync_cues` (`workspace_id`,`page`,`anchor_order_micros`);--> statement-breakpoint
CREATE TABLE `sync_discussions` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`target_type` text NOT NULL,
	`cue_id` text,
	`scene_id` text,
	`page` integer,
	`anchor_x_micros` integer,
	`anchor_y_micros` integer,
	`selected_text` text,
	`enclosing_line` text,
	`author_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved` integer DEFAULT false NOT NULL,
	`resolved_by` text,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `sync_discussions_workspace_cue_idx` ON `sync_discussions` (`workspace_id`,`cue_id`);--> statement-breakpoint
CREATE TABLE `sync_events` (
	`workspace_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`operation_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text,
	`summary` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `sequence`)
);
--> statement-breakpoint
CREATE TABLE `sync_export_rows` (
	`workspace_id` text NOT NULL,
	`export_id` text NOT NULL,
	`table_name` text NOT NULL,
	`sort_key` text NOT NULL,
	`payload` text NOT NULL,
	`payload_blob` blob,
	PRIMARY KEY(`workspace_id`, `export_id`, `table_name`, `sort_key`)
);
--> statement-breakpoint
CREATE INDEX `sync_export_rows_page_idx` ON `sync_export_rows` (`workspace_id`,`export_id`,`table_name`,`sort_key`);--> statement-breakpoint
CREATE TABLE `sync_exports` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`cutoff_sequence` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`manifest_hash` text,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `sync_head` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`epoch` text NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	`write_mode` text DEFAULT 'legacy' NOT NULL,
	`protocol_min` integer DEFAULT 2 NOT NULL,
	`protocol_max` integer DEFAULT 2 NOT NULL,
	`commit_token` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_inbox_pins` (
	`workspace_id` text NOT NULL,
	`event_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`pinned_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `event_id`, `profile_id`)
);
--> statement-breakpoint
CREATE TABLE `sync_inbox_reads` (
	`workspace_id` text NOT NULL,
	`event_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`read_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `event_id`, `profile_id`)
);
--> statement-breakpoint
CREATE TABLE `sync_notices` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`operation_id` text,
	`profile_id` text,
	`code` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	`acknowledged_at` text,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `sync_operations` (
	`workspace_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`session_id` text NOT NULL,
	`target_id` text,
	`sequence` integer NOT NULL,
	`metadata` text NOT NULL,
	`payload_bytes` integer DEFAULT 0 NOT NULL,
	`accepted_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `operation_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_operations_workspace_sequence_unique` ON `sync_operations` (`workspace_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `sync_payload_chunks` (
	`workspace_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`payload` blob NOT NULL,
	`payload_hash` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `operation_id`, `chunk_index`)
);
--> statement-breakpoint
CREATE TABLE `sync_profiles` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`initials` text NOT NULL,
	`color` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `sync_receipts` (
	`workspace_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text NOT NULL,
	`sequence` integer,
	`outcome` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `operation_id`)
);
--> statement-breakpoint
CREATE TABLE `sync_replies` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`discussion_id` text NOT NULL,
	`author_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `sync_replies_workspace_discussion_idx` ON `sync_replies` (`workspace_id`,`discussion_id`);--> statement-breakpoint
CREATE TABLE `sync_scenes` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`number` text NOT NULL,
	`name` text NOT NULL,
	`page_start` integer NOT NULL,
	`start_y_micros` integer NOT NULL,
	`page_end` integer NOT NULL,
	`owner_id` text,
	PRIMARY KEY(`workspace_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `sync_text_checkpoints` (
	`workspace_id` text NOT NULL,
	`cue_id` text NOT NULL,
	`revision` integer NOT NULL,
	`sequence` integer NOT NULL,
	`encoded_state` blob NOT NULL,
	`state_vector` blob NOT NULL,
	`state_hash` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `cue_id`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `sync_text_documents` (
	`workspace_id` text NOT NULL,
	`cue_id` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`workspace_sequence` integer DEFAULT 0 NOT NULL,
	`encoded_state` blob NOT NULL,
	`state_vector` blob NOT NULL,
	`state_hash` text NOT NULL,
	`update_count` integer DEFAULT 0 NOT NULL,
	`update_bytes` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `cue_id`)
);
--> statement-breakpoint
CREATE TABLE `sync_text_history` (
	`workspace_id` text NOT NULL,
	`cue_id` text NOT NULL,
	`revision` integer NOT NULL,
	`sequence` integer NOT NULL,
	`operation_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`technical_notes` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `cue_id`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `sync_text_history_workspace_cue_sequence_idx` ON `sync_text_history` (`workspace_id`,`cue_id`,`sequence`);