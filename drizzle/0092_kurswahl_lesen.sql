-- SP-05 (Projektleitung 2026-10-19, Q-SP-17): Die Funktionsgruppe „Stundenplanung“ liest Kurswahlen (`kurswahl.view` – Verfahren,
-- Angebote, Zahlen, übernommene Gruppen; keine Wahlen einzelner Schüler:innen), um daraus Lehraufträge anzulegen, ohne Kurswahlen
-- verwalten zu dürfen. Nur die von 0088 angelegte Gruppe (feste ID, Slug `stundenplanung`) – eine fremde Gruppe gleichen Namens
-- bekommt kein Recht (keine stille Rechteausweitung). Keine anderen Grants. Idempotent.
INSERT INTO "grants" ("id", "permission", "group_id")
SELECT gen_random_uuid()::text, 'kurswahl.view', 'g-stundenplanung'
WHERE EXISTS (SELECT 1 FROM "groups" WHERE "id" = 'g-stundenplanung' AND "slug" = 'stundenplanung')
ON CONFLICT DO NOTHING;
