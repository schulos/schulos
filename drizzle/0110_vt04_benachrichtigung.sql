CREATE TYPE "public"."timetable_notify_audience" AS ENUM('lehrkraefte', 'lernende');--> statement-breakpoint
CREATE TABLE "timetable_notification_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"user_id" text NOT NULL,
	"audience" timetable_notify_audience NOT NULL,
	"queued_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "timetable_notification_queue" ADD CONSTRAINT "timetable_notification_queue_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_notification_queue_pending_idx" ON "timetable_notification_queue" USING btree ("user_id","date") WHERE "timetable_notification_queue"."sent_at" is null;--> statement-breakpoint
CREATE INDEX "timetable_notification_queue_due_idx" ON "timetable_notification_queue" USING btree ("due_at") WHERE "timetable_notification_queue"."sent_at" is null;--> statement-breakpoint
CREATE INDEX "timetable_notification_queue_date_idx" ON "timetable_notification_queue" USING btree ("date","sent_at");