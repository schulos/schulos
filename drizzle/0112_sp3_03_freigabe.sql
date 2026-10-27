CREATE TYPE "public"."plan_comment_target" AS ENUM('version', 'teacher', 'group', 'slot');--> statement-breakpoint
CREATE TABLE "timetable_plan_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"author_id" text,
	"from_preview" boolean DEFAULT false NOT NULL,
	"target_kind" "plan_comment_target" DEFAULT 'version' NOT NULL,
	"teacher_id" text,
	"group_id" text,
	"weekday" integer,
	"period_nr" integer,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "timetable_plan_comments_body" CHECK (char_length("timetable_plan_comments"."body") between 1 and 500),
	CONSTRAINT "timetable_plan_comments_slot" CHECK (("timetable_plan_comments"."target_kind" = 'slot') = ("timetable_plan_comments"."weekday" is not null and "timetable_plan_comments"."period_nr" is not null)),
	CONSTRAINT "timetable_plan_comments_weekday" CHECK ("timetable_plan_comments"."weekday" is null or "timetable_plan_comments"."weekday" between 0 and 4)
);
--> statement-breakpoint
ALTER TABLE "timetable_plan_comments" ADD CONSTRAINT "timetable_plan_comments_version_id_timetable_plan_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."timetable_plan_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_plan_comments" ADD CONSTRAINT "timetable_plan_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_plan_comments" ADD CONSTRAINT "timetable_plan_comments_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_plan_comments" ADD CONSTRAINT "timetable_plan_comments_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_plan_comments" ADD CONSTRAINT "timetable_plan_comments_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timetable_plan_comments_version_idx" ON "timetable_plan_comments" USING btree ("version_id","created_at");--> statement-breakpoint
CREATE INDEX "timetable_plan_comments_author_idx" ON "timetable_plan_comments" USING btree ("author_id");--> statement-breakpoint
-- SP3-03 (docs/STUNDENPLAN-LEBENSZYKLUS.md §3.1, F-10-3): Recht `stundenplan.review` („Planentwurf prüfen und freigeben“) für die Gruppe
-- Schulleitung – wie 0088 nur, wenn es die Gruppe mit dieser festen ID und diesem Slug gibt (keine stille Rechteausweitung auf eine
-- andere Gruppe). Keine Rollen-Vorgabe; die Schule kann das Recht unter Rechte weiteren Gruppen geben. Idempotent.
INSERT INTO "grants" ("id", "permission", "group_id")
SELECT gen_random_uuid()::text, 'stundenplan.review', 'g-schulleitung'
WHERE EXISTS (SELECT 1 FROM "groups" WHERE "id" = 'g-schulleitung' AND "slug" = 'schulleitung')
ON CONFLICT DO NOTHING;
