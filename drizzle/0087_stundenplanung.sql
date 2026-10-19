-- SP-02 (docs/STUNDENPLAN-UMBAU.md §2.2): Anrechnungsgrund „Stundenplanung“ (neuer Enum-Wert, in dieser Migration nicht benutzt –
-- ADD VALUE ist damit auch in der Migrations-Transaktion erlaubt).
ALTER TYPE "public"."reduction_reason" ADD VALUE 'stundenplanung';--> statement-breakpoint
-- SP-02 (Q-SP-4): Planung und Vertretung sind getrennte Rechte. Wer bisher planen durfte, durfte auch vertreten – deshalb bekommt
-- jeder Grant `stundenplan.manage` (Rolle oder Gruppe) einen passenden Grant `stundenplan.substitute`. Niemand verliert ein Recht;
-- der Rollen-Grant `verwaltung → stundenplan.manage` bleibt stehen (die Schule entscheidet, ob sie ihn entzieht). Idempotent.
INSERT INTO "grants" ("id", "permission", "role", "group_id")
SELECT gen_random_uuid()::text, 'stundenplan.substitute', g."role", g."group_id"
FROM "grants" g
WHERE g."permission" = 'stundenplan.manage'
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Funktionsgruppe „Stundenplanung“ (Q-SP-1), ohne Mitglieder – die trägt die Schule ein. Nur, wenn es noch keine Gruppe mit diesem
-- Slug gibt; eine schon vorhandene Gruppe der Schule bekommt keine Rechte (keine stille Rechteausweitung).
INSERT INTO "groups" ("id", "name", "slug", "kind", "description")
SELECT 'g-stundenplanung', 'Stundenplanung', 'stundenplanung', 'gremium', 'Funktionsgruppe: Stundenplan planen und Vertretungen planen'
WHERE NOT EXISTS (SELECT 1 FROM "groups" WHERE "slug" = 'stundenplanung' OR "id" = 'g-stundenplanung');--> statement-breakpoint
INSERT INTO "grants" ("id", "permission", "group_id")
SELECT gen_random_uuid()::text, p.permission, 'g-stundenplanung'
FROM (VALUES ('stundenplan.manage'), ('stundenplan.substitute')) AS p(permission)
WHERE EXISTS (SELECT 1 FROM "groups" WHERE "id" = 'g-stundenplanung' AND "slug" = 'stundenplanung')
ON CONFLICT DO NOTHING;
