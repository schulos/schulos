ALTER TABLE "gebaeude_assets" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "gebaeude_assets" DROP COLUMN "building";--> statement-breakpoint
ALTER TABLE "gebaeude_inspection_types" DROP COLUMN "asset_kind";--> statement-breakpoint
DROP TYPE "public"."gebaeude_asset_kind";