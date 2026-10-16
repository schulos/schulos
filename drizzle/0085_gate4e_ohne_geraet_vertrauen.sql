-- GATE-4e (G4E-S01/S02): „Gerät vertrauen“ ist abgeschaltet (trustDeviceMaxAge 0) – schon ausgestellte Vertrauens-Einträge
-- (30 Tage, rollierend) gelten nicht weiter. Liegengebliebene, nie bestätigte Einrichtungen der Code-App werden verworfen
-- (wer gerade mitten in der Einrichtung ist, beginnt sie neu).
DELETE FROM "verifications" WHERE "identifier" LIKE 'trust-device-%';--> statement-breakpoint
DELETE FROM "two_factors" WHERE "verified" = false;
