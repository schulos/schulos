CREATE TYPE "public"."substitution_kind" AS ENUM('cancel', 'substitute', 'room');--> statement-breakpoint
CREATE TABLE "timetable_substitutions" (
	"id" text PRIMARY KEY NOT NULL,
	"lesson_id" text NOT NULL,
	"date" date NOT NULL,
	"kind" "substitution_kind" NOT NULL,
	"substitute_id" text,
	"room_id" text,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_lesson_id_timetable_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."timetable_lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_substitute_id_users_id_fk" FOREIGN KEY ("substitute_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_substitutions_lesson_date_uq" ON "timetable_substitutions" USING btree ("lesson_id","date");--> statement-breakpoint
CREATE INDEX "timetable_substitutions_date_idx" ON "timetable_substitutions" USING btree ("date");--> statement-breakpoint
CREATE INDEX "timetable_substitutions_substitute_idx" ON "timetable_substitutions" USING btree ("substitute_id","date");