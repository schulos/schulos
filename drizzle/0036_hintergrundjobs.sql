CREATE TABLE "system_jobs" (
	"name" text PRIMARY KEY NOT NULL,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_status" text,
	"last_error" text
);
