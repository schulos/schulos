ALTER TABLE "timetable_lessons" DROP CONSTRAINT "timetable_lessons_room_id_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "timetable_substitutions" DROP CONSTRAINT "timetable_substitutions_room_id_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "booking_resources" DROP CONSTRAINT "booking_resources_room_id_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "exams" DROP CONSTRAINT "exams_room_id_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "kind" "room_kind" DEFAULT 'klassenraum' NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "floor" text;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "equipment" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "accessible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "school_years" ADD COLUMN "term2_starts_on" date;--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timetable_substitutions" ADD CONSTRAINT "timetable_substitutions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "booking_resources" ADD CONSTRAINT "booking_resources_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE cascade;