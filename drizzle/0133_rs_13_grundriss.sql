ALTER TABLE "building_floors" ADD COLUMN "plan_key" text;--> statement-breakpoint
ALTER TABLE "building_floors" ADD COLUMN "plan_thumb_key" text;--> statement-breakpoint
ALTER TABLE "building_floors" ADD COLUMN "plan_mime" text;--> statement-breakpoint
ALTER TABLE "building_floors" ADD COLUMN "plan_width" integer;--> statement-breakpoint
ALTER TABLE "building_floors" ADD COLUMN "plan_height" integer;--> statement-breakpoint
ALTER TABLE "building_floors" ADD COLUMN "plan_alt" text;--> statement-breakpoint
ALTER TABLE "building_floors" ADD COLUMN "plan_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "plan_x" double precision;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "plan_y" double precision;--> statement-breakpoint
ALTER TABLE "building_floors" ADD CONSTRAINT "building_floors_plan_all_or_none" CHECK (("building_floors"."plan_key" is null and "building_floors"."plan_thumb_key" is null and "building_floors"."plan_mime" is null and "building_floors"."plan_width" is null and "building_floors"."plan_height" is null and "building_floors"."plan_alt" is null and "building_floors"."plan_updated_at" is null) or ("building_floors"."plan_key" is not null and "building_floors"."plan_thumb_key" is not null and "building_floors"."plan_mime" is not null and "building_floors"."plan_width" is not null and "building_floors"."plan_height" is not null and "building_floors"."plan_alt" is not null and "building_floors"."plan_updated_at" is not null));--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_plan_point" CHECK (("rooms"."plan_x" is null and "rooms"."plan_y" is null) or ("rooms"."plan_x" is not null and "rooms"."plan_y" is not null and "rooms"."plan_x" between 0 and 1 and "rooms"."plan_y" between 0 and 1));