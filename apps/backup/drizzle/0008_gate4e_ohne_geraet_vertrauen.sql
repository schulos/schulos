-- GATE-4e (G4E-S02): „Gerät vertrauen“ ist abgeschaltet (trustDeviceMaxAge 0) – schon ausgestellte Vertrauens-Einträge gelten nicht weiter.
DELETE FROM "verifications" WHERE "identifier" LIKE 'trust-device-%';
