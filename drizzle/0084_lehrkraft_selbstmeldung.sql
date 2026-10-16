CREATE TABLE "timetable_absence_materials" (
	"id" text PRIMARY KEY NOT NULL,
	"absence_id" text NOT NULL,
	"lesson_id" text NOT NULL,
	"date" date NOT NULL,
	"text" text,
	"file_key" text,
	"file_name" text,
	"file_mime" text,
	"file_size" integer,
	"for_students" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "timetable_absences" ADD COLUMN "status" text DEFAULT 'aktiv' NOT NULL;--> statement-breakpoint
ALTER TABLE "timetable_absences" ADD COLUMN "self_reported" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "timetable_absences" ADD COLUMN "decided_by" text;--> statement-breakpoint
ALTER TABLE "timetable_absences" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "timetable_absence_materials" ADD CONSTRAINT "timetable_absence_materials_absence_id_timetable_absences_id_fk" FOREIGN KEY ("absence_id") REFERENCES "public"."timetable_absences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_absence_materials" ADD CONSTRAINT "timetable_absence_materials_lesson_id_timetable_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."timetable_lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_absence_materials" ADD CONSTRAINT "timetable_absence_materials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_absence_materials_uq" ON "timetable_absence_materials" USING btree ("absence_id","lesson_id","date");--> statement-breakpoint
CREATE INDEX "timetable_absence_materials_lesson_idx" ON "timetable_absence_materials" USING btree ("lesson_id","date");--> statement-breakpoint
ALTER TABLE "timetable_absences" ADD CONSTRAINT "timetable_absences_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_absences" ADD CONSTRAINT "timetable_absences_status" CHECK ("timetable_absences"."status" in ('aktiv', 'beantragt', 'abgelehnt'));