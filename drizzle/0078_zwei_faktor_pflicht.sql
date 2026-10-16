ALTER TABLE "users" ADD COLUMN "two_factor_setup_until" timestamp with time zone;--> statement-breakpoint
-- SEC-01: Stichtag der 2FA-Pflicht für Lehrkräfte, Personal und Eltern – beim Update vier Wochen Übergangsfrist (änderbar unter
-- Verwaltung → System → Anmeldung); eine schon gesetzte Einstellung bleibt
INSERT INTO "app_settings" ("key", "value") VALUES ('sicherheit.zwei_faktor_ab', to_jsonb(to_char(current_date + 28, 'YYYY-MM-DD'))) ON CONFLICT ("key") DO NOTHING;
