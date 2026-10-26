CREATE TYPE "public"."staff_change_kind" AS ENUM('abgang', 'zugang');--> statement-breakpoint
CREATE TABLE "timetable_forecast_grades" (
	"school_year_id" text NOT NULL,
	"grade" integer NOT NULL,
	"classes" integer NOT NULL,
	CONSTRAINT "timetable_forecast_grades_school_year_id_grade_pk" PRIMARY KEY("school_year_id","grade"),
	CONSTRAINT "timetable_forecast_grades_classes" CHECK ("timetable_forecast_grades"."classes" between 0 and 30)
);
--> statement-breakpoint
CREATE TABLE "timetable_staff_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "staff_change_kind" NOT NULL,
	"teacher_id" text,
	"subject_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"effective_on" date NOT NULL,
	"hours" numeric(4, 1) NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_staff_changes_hours" CHECK ("timetable_staff_changes"."hours" > 0 and "timetable_staff_changes"."hours" <= 40),
	CONSTRAINT "timetable_staff_changes_teacher" CHECK (("timetable_staff_changes"."kind" = 'abgang') = ("timetable_staff_changes"."teacher_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "timetable_teacher_subjects" (
	"teacher_id" text NOT NULL,
	"subject_id" text NOT NULL,
	CONSTRAINT "timetable_teacher_subjects_teacher_id_subject_id_pk" PRIMARY KEY("teacher_id","subject_id")
);
--> statement-breakpoint
ALTER TABLE "timetable_forecast_grades" ADD CONSTRAINT "timetable_forecast_grades_school_year_id_school_years_id_fk" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_staff_changes" ADD CONSTRAINT "timetable_staff_changes_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_staff_changes" ADD CONSTRAINT "timetable_staff_changes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_teacher_subjects" ADD CONSTRAINT "timetable_teacher_subjects_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_teacher_subjects" ADD CONSTRAINT "timetable_teacher_subjects_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "timetable_teacher_subjects_subject_idx" ON "timetable_teacher_subjects" USING btree ("subject_id");--> statement-breakpoint
-- SP2-12: Lehrfächer vorbelegen – jede Lehrkraft bekommt die Fächer, die sie in Lehraufträgen oder im Stundenplan schon unterrichtet.
-- Sonst sähe eine Bestandsinstallation nach dem Update bei jeder Zuweisung „unterrichtet das Fach laut Stammdaten nicht“. Nur Konten
-- mit der Rolle Lehrkraft; idempotent.
INSERT INTO "timetable_teacher_subjects" ("teacher_id", "subject_id")
SELECT DISTINCT x.teacher_id, x.subject_id FROM (
  SELECT t."teacher_id", a."subject_id" FROM "timetable_assignment_teachers" t JOIN "timetable_assignments" a ON a."id" = t."assignment_id"
  UNION
  SELECT l."teacher_id", l."subject_id" FROM "timetable_lessons" l WHERE l."teacher_id" IS NOT NULL
) x
JOIN "users" u ON u."id" = x.teacher_id AND u."role" = 'lehrkraft'
ON CONFLICT DO NOTHING;
