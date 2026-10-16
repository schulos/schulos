CREATE TYPE "public"."room_block_reason" AS ENUM('renovierung', 'pruefung', 'veranstaltung', 'defekt', 'sonstiges');--> statement-breakpoint
CREATE TABLE "timetable_room_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"from_period" integer,
	"to_period" integer,
	"reason" "room_block_reason" NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_room_blocks_range" CHECK ("timetable_room_blocks"."ends_on" >= "timetable_room_blocks"."starts_on"),
	CONSTRAINT "timetable_room_blocks_periods" CHECK (("timetable_room_blocks"."from_period" is null and "timetable_room_blocks"."to_period" is null) or ("timetable_room_blocks"."from_period" is not null and "timetable_room_blocks"."to_period" is not null and "timetable_room_blocks"."to_period" >= "timetable_room_blocks"."from_period"))
);
--> statement-breakpoint
ALTER TABLE "timetable_room_blocks" ADD CONSTRAINT "timetable_room_blocks_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timetable_room_blocks" ADD CONSTRAINT "timetable_room_blocks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timetable_room_blocks_room_idx" ON "timetable_room_blocks" USING btree ("room_id","starts_on");