CREATE TYPE "public"."exam_kind" AS ENUM('klassenarbeit', 'klausur', 'test');--> statement-breakpoint
CREATE TABLE "exams" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"kind" "exam_kind" NOT NULL,
	"title" text NOT NULL,
	"date" date NOT NULL,
	"period_from" integer NOT NULL,
	"period_to" integer NOT NULL,
	"room_id" text,
	"teacher_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exams_periods" CHECK ("exams"."period_to" >= "exams"."period_from")
);
--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exams_group_date_idx" ON "exams" USING btree ("group_id","date");--> statement-breakpoint
CREATE INDEX "exams_date_idx" ON "exams" USING btree ("date");