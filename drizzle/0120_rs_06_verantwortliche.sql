CREATE TABLE "room_responsibles" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"user_id" text,
	"group_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_responsibles_one_target" CHECK (("room_responsibles"."user_id" is null) <> ("room_responsibles"."group_id" is null))
);
--> statement-breakpoint
ALTER TABLE "room_responsibles" ADD CONSTRAINT "room_responsibles_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "room_responsibles" ADD CONSTRAINT "room_responsibles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_responsibles" ADD CONSTRAINT "room_responsibles_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "room_responsibles_user_uq" ON "room_responsibles" USING btree ("room_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_responsibles_group_uq" ON "room_responsibles" USING btree ("room_id","group_id");--> statement-breakpoint
CREATE INDEX "room_responsibles_user_idx" ON "room_responsibles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "room_responsibles_group_idx" ON "room_responsibles" USING btree ("group_id");