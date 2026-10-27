CREATE TYPE "public"."plan_version_source" AS ENUM('live_copy', 'solver_run', 'previous_version', 'variant_of', 'empty', 'bestand');--> statement-breakpoint
CREATE TYPE "public"."plan_version_status" AS ENUM('entwurf', 'pruefung', 'freigegeben', 'gueltig', 'archiviert', 'verworfen');--> statement-breakpoint
CREATE TABLE "timetable_draft_lessons" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"weekday" integer NOT NULL,
	"period_nr" integer NOT NULL,
	"subject_id" text NOT NULL,
	"teacher_id" text,
	"room_id" text,
	"week" "lesson_week" DEFAULT 'all' NOT NULL,
	"valid_from" date NOT NULL,
	"valid_until" date,
	"coupling_id" text,
	"fixed" boolean DEFAULT false NOT NULL,
	"solver_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version_id" text NOT NULL,
	"origin_lesson_id" text,
	"assignment_id" text,
	CONSTRAINT "timetable_draft_lessons_weekday" CHECK ("timetable_draft_lessons"."weekday" between 0 and 4),
	CONSTRAINT "timetable_draft_lessons_valid" CHECK ("timetable_draft_lessons"."valid_until" is null or "timetable_draft_lessons"."valid_until" >= "timetable_draft_lessons"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "timetable_plan_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"school_year_id" text NOT NULL,
	"major" integer NOT NULL,
	"minor" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"status" "plan_version_status" DEFAULT 'entwurf' NOT NULL,
	"source" "plan_version_source" NOT NULL,
	"parent_version_id" text,
	"source_run_id" text,
	"valid_from" date,
	"valid_until" date,
	"teacher_preview" boolean DEFAULT false NOT NULL,
	"checklist" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_by" text,
	"submitted_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"published_by" text,
	"published_at" timestamp with time zone,
	"discarded_by" text,
	"discarded_at" timestamp with time zone,
	"undo" jsonb,
	CONSTRAINT "timetable_plan_versions_valid" CHECK ("timetable_plan_versions"."valid_until" is null or "timetable_plan_versions"."valid_from" is null or "timetable_plan_versions"."valid_until" >= "timetable_plan_versions"."valid_from"),
	CONSTRAINT "timetable_plan_versions_number" CHECK ("timetable_plan_versions"."major" >= 1 and "timetable_plan_versions"."minor" >= 0),
	CONSTRAINT "timetable_plan_versions_name" CHECK (char_length("timetable_plan_versions"."name") between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD COLUMN "plan_version_id" text;--> statement-breakpoint
ALTER TABLE "timetable_draft_lessons" ADD CONSTRAINT "timetable_draft_lessons_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_draft_lessons" ADD CONSTRAINT "timetable_draft_lessons_period_nr_periods_nr_fk" FOREIGN KEY ("period_nr") REFERENCES "public"."periods"("nr") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_draft_lessons" ADD CONSTRAINT "timetable_draft_lessons_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timetable_draft_lessons" ADD CONSTRAINT "timetable_draft_lessons_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_draft_lessons" ADD CONSTRAINT "timetable_draft_lessons_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timetable_draft_lessons" ADD CONSTRAINT "timetable_draft_lessons_solver_run_id_timetable_solver_runs_id_fk" FOREIGN KEY ("solver_run_id") REFERENCES "public"."timetable_solver_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_draft_lessons" ADD CONSTRAINT "timetable_draft_lessons_version_id_timetable_plan_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."timetable_plan_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_draft_lessons" ADD CONSTRAINT "timetable_draft_lessons_origin_lesson_id_timetable_lessons_id_fk" FOREIGN KEY ("origin_lesson_id") REFERENCES "public"."timetable_lessons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_draft_lessons" ADD CONSTRAINT "timetable_draft_lessons_assignment_id_timetable_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."timetable_assignments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_plan_versions" ADD CONSTRAINT "timetable_plan_versions_school_year_id_school_years_id_fk" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_plan_versions" ADD CONSTRAINT "timetable_plan_versions_parent_version_id_timetable_plan_versions_id_fk" FOREIGN KEY ("parent_version_id") REFERENCES "public"."timetable_plan_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_plan_versions" ADD CONSTRAINT "timetable_plan_versions_source_run_id_timetable_solver_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."timetable_solver_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_plan_versions" ADD CONSTRAINT "timetable_plan_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_plan_versions" ADD CONSTRAINT "timetable_plan_versions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_plan_versions" ADD CONSTRAINT "timetable_plan_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_plan_versions" ADD CONSTRAINT "timetable_plan_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_plan_versions" ADD CONSTRAINT "timetable_plan_versions_discarded_by_users_id_fk" FOREIGN KEY ("discarded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timetable_draft_lessons_version_idx" ON "timetable_draft_lessons" USING btree ("version_id","group_id","weekday");--> statement-breakpoint
CREATE INDEX "timetable_draft_lessons_teacher_idx" ON "timetable_draft_lessons" USING btree ("version_id","teacher_id","weekday");--> statement-breakpoint
CREATE INDEX "timetable_draft_lessons_room_idx" ON "timetable_draft_lessons" USING btree ("version_id","room_id","weekday");--> statement-breakpoint
CREATE INDEX "timetable_draft_lessons_coupling_idx" ON "timetable_draft_lessons" USING btree ("version_id","coupling_id");--> statement-breakpoint
CREATE INDEX "timetable_draft_lessons_origin_idx" ON "timetable_draft_lessons" USING btree ("origin_lesson_id");--> statement-breakpoint
CREATE INDEX "timetable_plan_versions_year_idx" ON "timetable_plan_versions" USING btree ("school_year_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_plan_versions_number_uq" ON "timetable_plan_versions" USING btree ("school_year_id","major","minor") WHERE "timetable_plan_versions"."status" in ('gueltig', 'archiviert');--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_plan_versions_valid_uq" ON "timetable_plan_versions" USING btree ("school_year_id") WHERE "timetable_plan_versions"."status" = 'gueltig';--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_plan_versions_bestand_uq" ON "timetable_plan_versions" USING btree ("school_year_id") WHERE "timetable_plan_versions"."source" = 'bestand';--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_plan_version_id_timetable_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."timetable_plan_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timetable_lessons_plan_version_idx" ON "timetable_lessons" USING btree ("plan_version_id");--> statement-breakpoint
-- SP3-01 Daten-Migration „Bestand 1.0“ (idempotent, wie ensureBaseVersions() in planversionen.ts): je begonnenem Schuljahr mit Stunden
-- eine Version 1.0 „Bestand“ – gültig im laufenden, archiviert in abgelaufenen Schuljahren (bis Schuljahresende). Künftige Schuljahre
-- bekommen keine (unbefristete Stunden reichen zwar hinein, geplant wird dort aber neu).
INSERT INTO "timetable_plan_versions" ("id", "school_year_id", "major", "minor", "name", "status", "source", "valid_from", "valid_until")
SELECT gen_random_uuid()::text, y."id", 1, 0, 'Bestand',
  CASE WHEN y."ends_on" < (now() AT TIME ZONE 'Europe/Berlin')::date THEN 'archiviert'::plan_version_status ELSE 'gueltig'::plan_version_status END,
  'bestand'::plan_version_source, y."starts_on",
  CASE WHEN y."ends_on" < (now() AT TIME ZONE 'Europe/Berlin')::date THEN y."ends_on" ELSE NULL END
FROM "school_years" y
WHERE y."starts_on" <= (now() AT TIME ZONE 'Europe/Berlin')::date
  AND EXISTS (SELECT 1 FROM "timetable_lessons" l WHERE l."valid_from" <= y."ends_on" AND (l."valid_until" IS NULL OR l."valid_until" >= y."starts_on"))
  AND NOT EXISTS (SELECT 1 FROM "timetable_plan_versions" v WHERE v."school_year_id" = y."id" AND (v."source" = 'bestand' OR v."status" IN ('gueltig', 'archiviert')));--> statement-breakpoint
-- Stunden bekommen die Herkunft nur, wenn sie am Migrationstag gelten (im Schuljahr dieses Tages); kein Leser filtert danach.
UPDATE "timetable_lessons" l SET "plan_version_id" = v."id"
FROM "timetable_plan_versions" v JOIN "school_years" y ON y."id" = v."school_year_id"
WHERE l."plan_version_id" IS NULL AND v."source" = 'bestand' AND v."status" = 'gueltig'
  AND (now() AT TIME ZONE 'Europe/Berlin')::date BETWEEN y."starts_on" AND y."ends_on"
  AND l."valid_from" <= (now() AT TIME ZONE 'Europe/Berlin')::date
  AND (l."valid_until" IS NULL OR l."valid_until" >= (now() AT TIME ZONE 'Europe/Berlin')::date);
