ALTER TABLE "gebaeude_asset_categories" ADD COLUMN "lifetime_years" integer;--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD COLUMN "service_partner" text;--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD COLUMN "service_end" date;--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD COLUMN "service_notice_months" integer;--> statement-breakpoint
ALTER TABLE "gebaeude_assets" ADD COLUMN "service_note" text;--> statement-breakpoint
-- INV-10: Richtwerte der Vorlage (kategorien.ts) für bestehende Vorlagen-Kategorien; eigene Kategorien bleiben ohne Richtwert
UPDATE "gebaeude_asset_categories" SET "lifetime_years" = v."years" FROM (VALUES ('elektro_ortsveraenderlich', 8), ('feuerloescher', 20), ('spielgeraet', 15), ('sportgeraet', 15), ('aufzug', 25), ('tor_tuer', 20), ('leiter', 10), ('lueftung', 20), ('it', 5), ('praesentation', 8), ('sammlung', 15), ('werken', 15), ('musik', 15), ('hauswirtschaft', 10), ('sicherheit', 10), ('hausmeisterei', 10), ('chemikalienschrank', 20), ('moebel', 15), ('abzug', 20), ('notdusche', 15), ('sicherheitsschrank', 20)) AS v("key", "years") WHERE "gebaeude_asset_categories"."key" = v."key" AND "gebaeude_asset_categories"."lifetime_years" IS NULL;
