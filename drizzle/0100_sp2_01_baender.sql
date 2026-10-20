CREATE TABLE "timetable_bands" (
	"id" text PRIMARY KEY NOT NULL,
	"school_year_id" text NOT NULL,
	"name" text NOT NULL,
	"hours" integer NOT NULL,
	"double_lessons" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_bands_hours" CHECK ("timetable_bands"."hours" between 1 and 12),
	CONSTRAINT "timetable_bands_double" CHECK ("timetable_bands"."double_lessons" >= 0 and "timetable_bands"."double_lessons" * 2 <= "timetable_bands"."hours")
);
--> statement-breakpoint
ALTER TABLE "timetable_assignments" ADD COLUMN "band_id" text;--> statement-breakpoint
ALTER TABLE "timetable_bands" ADD CONSTRAINT "timetable_bands_school_year_id_school_years_id_fk" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_bands_name_uq" ON "timetable_bands" USING btree ("school_year_id","name");--> statement-breakpoint
ALTER TABLE "timetable_assignments" ADD CONSTRAINT "timetable_assignments_band_id_timetable_bands_id_fk" FOREIGN KEY ("band_id") REFERENCES "public"."timetable_bands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timetable_assignments_band_idx" ON "timetable_assignments" USING btree ("band_id");--> statement-breakpoint
-- SP2-01 Daten: Bisherige Kopplungen im Lehrauftrag („Gekoppelt mit“, ein Lehrauftrag mit mehreren Gruppen) werden zu Bändern.
-- Das Band übernimmt die id, Wochen- und Doppelstunden; Name = Fach + Gruppen. Der Lehrauftrag bleibt für die erste Gruppe
-- (kleinste id), jede weitere Gruppe bekommt einen eigenen Lehrauftrag (gleiches Fach, gleiche Lehrkräfte, Raumwunsch und Hinweis;
-- id aus md5(Lehrauftrag|Gruppe)). Notenbücher zeigen danach auf den Lehrauftrag ihrer Gruppe. Idempotent (danach gibt es keine
-- Lehraufträge mit mehreren Gruppen mehr).
INSERT INTO "timetable_bands" ("id", "school_year_id", "name", "hours", "double_lessons")
SELECT x."id", x."school_year_id", x."base" || CASE WHEN x."rn" > 1 THEN ' (' || x."rn" || ')' ELSE '' END, x."hours", x."double_lessons"
FROM (
  SELECT a."id", a."school_year_id", a."hours", a."double_lessons", n."base",
    row_number() OVER (PARTITION BY a."school_year_id", n."base" ORDER BY a."id" COLLATE "C") AS "rn"
  FROM "timetable_assignments" a
  JOIN "subjects" s ON s."id" = a."subject_id"
  CROSS JOIN LATERAL (
    SELECT left(s."name" || ' ' || string_agg(g."name", '/' ORDER BY g."name" COLLATE "C"), 55) AS "base", count(*) AS "n"
    FROM "timetable_assignment_groups" ag
    JOIN "groups" g ON g."id" = ag."group_id"
    WHERE ag."assignment_id" = a."id"
  ) n
  WHERE n."n" > 1
) x
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "timetable_assignments" ("id", "school_year_id", "subject_id", "hours", "double_lessons", "room_id", "note", "band_id", "created_at")
SELECT md5(a."id" || '|' || ag."group_id")::uuid::text, a."school_year_id", a."subject_id", a."hours", a."double_lessons", a."room_id", a."note", a."id", a."created_at"
FROM "timetable_assignments" a
JOIN "timetable_bands" b ON b."id" = a."id"
JOIN "timetable_assignment_groups" ag ON ag."assignment_id" = a."id"
WHERE ag."group_id" COLLATE "C" > (SELECT min(x."group_id" COLLATE "C") FROM "timetable_assignment_groups" x WHERE x."assignment_id" = a."id")
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "timetable_assignment_teachers" ("assignment_id", "teacher_id")
SELECT md5(ag."assignment_id" || '|' || ag."group_id")::uuid::text, t."teacher_id"
FROM "timetable_assignment_groups" ag
JOIN "timetable_bands" b ON b."id" = ag."assignment_id"
JOIN "timetable_assignment_teachers" t ON t."assignment_id" = ag."assignment_id"
WHERE ag."group_id" COLLATE "C" > (SELECT min(x."group_id" COLLATE "C") FROM "timetable_assignment_groups" x WHERE x."assignment_id" = ag."assignment_id")
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "timetable_assignment_groups" ("assignment_id", "group_id")
SELECT md5(ag."assignment_id" || '|' || ag."group_id")::uuid::text, ag."group_id"
FROM "timetable_assignment_groups" ag
JOIN "timetable_bands" b ON b."id" = ag."assignment_id"
WHERE ag."group_id" COLLATE "C" > (SELECT min(x."group_id" COLLATE "C") FROM "timetable_assignment_groups" x WHERE x."assignment_id" = ag."assignment_id")
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "notenbuch_books" nb
SET "assignment_id" = md5(nb."assignment_id" || '|' || nb."group_id")::uuid::text
WHERE nb."assignment_id" IN (SELECT "id" FROM "timetable_bands")
  AND EXISTS (SELECT 1 FROM "timetable_assignment_groups" m WHERE m."assignment_id" = md5(nb."assignment_id" || '|' || nb."group_id")::uuid::text AND m."group_id" = nb."group_id");
--> statement-breakpoint
DELETE FROM "timetable_assignment_groups" ag
USING "timetable_bands" b
WHERE b."id" = ag."assignment_id"
  AND ag."group_id" COLLATE "C" > (SELECT min(x."group_id" COLLATE "C") FROM "timetable_assignment_groups" x WHERE x."assignment_id" = ag."assignment_id");
--> statement-breakpoint
UPDATE "timetable_assignments" a SET "band_id" = a."id"
WHERE a."band_id" IS NULL AND EXISTS (SELECT 1 FROM "timetable_bands" b WHERE b."id" = a."id");
