CREATE TABLE `sync_text_checkpoint_chunks` (
	`workspace_id` text NOT NULL,
	`cue_id` text NOT NULL,
	`revision` integer NOT NULL,
	`chunk_index` integer NOT NULL,
	`payload` blob NOT NULL,
	`payload_hash` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `cue_id`, `revision`, `chunk_index`)
);
--> statement-breakpoint
CREATE TABLE `sync_text_document_chunks` (
	`workspace_id` text NOT NULL,
	`cue_id` text NOT NULL,
	`revision` integer NOT NULL,
	`chunk_index` integer NOT NULL,
	`payload` blob NOT NULL,
	`payload_hash` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `cue_id`, `chunk_index`)
);
--> statement-breakpoint
ALTER TABLE `sync_text_checkpoints` ADD `chunk_count` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `sync_text_checkpoints` ADD `encoded_bytes` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `sync_text_checkpoints` DROP COLUMN `encoded_state`;--> statement-breakpoint
ALTER TABLE `sync_text_documents` ADD `chunk_count` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `sync_text_documents` ADD `encoded_bytes` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `sync_text_documents` DROP COLUMN `encoded_state`;
