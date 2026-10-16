CREATE TABLE "sprechtag_appointments" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"teacher_id" text NOT NULL,
	"student_id" text NOT NULL,
	"booked_by" text NOT NULL,
	"slot" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sprechtag_availability" (
	"event_id" text NOT NULL,
	"teacher_id" text NOT NULL,
	"room_id" text,
	"blocked_slots" text[] DEFAULT '{}'::text[] NOT NULL,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sprechtag_availability_event_id_teacher_id_pk" PRIMARY KEY("event_id","teacher_id")
);
--> statement-breakpoint
CREATE TABLE "sprechtag_events" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"date" date NOT NULL,
	"starts_at" text NOT NULL,
	"ends_at" text NOT NULL,
	"slot_minutes" integer NOT NULL,
	"breaks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"booking_opens_on" date NOT NULL,
	"booking_closes_on" date NOT NULL,
	"reminded_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sprechtag_events_slot" CHECK ("sprechtag_events"."slot_minutes" between 5 and 30),
	CONSTRAINT "sprechtag_events_time" CHECK ("sprechtag_events"."ends_at" > "sprechtag_events"."starts_at"),
	CONSTRAINT "sprechtag_events_booking" CHECK ("sprechtag_events"."booking_closes_on" >= "sprechtag_events"."booking_opens_on")
);
--> statement-breakpoint
CREATE TABLE "sprechtag_invitations" (
	"event_id" text NOT NULL,
	"teacher_id" text NOT NULL,
	"student_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sprechtag_invitations_event_id_teacher_id_student_id_pk" PRIMARY KEY("event_id","teacher_id","student_id")
);
--> statement-breakpoint
ALTER TABLE "sprechtag_appointments" ADD CONSTRAINT "sprechtag_appointments_event_id_sprechtag_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."sprechtag_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprechtag_appointments" ADD CONSTRAINT "sprechtag_appointments_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprechtag_appointments" ADD CONSTRAINT "sprechtag_appointments_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprechtag_appointments" ADD CONSTRAINT "sprechtag_appointments_booked_by_users_id_fk" FOREIGN KEY ("booked_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprechtag_availability" ADD CONSTRAINT "sprechtag_availability_event_id_sprechtag_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."sprechtag_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprechtag_availability" ADD CONSTRAINT "sprechtag_availability_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprechtag_availability" ADD CONSTRAINT "sprechtag_availability_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sprechtag_invitations" ADD CONSTRAINT "sprechtag_invitations_event_id_sprechtag_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."sprechtag_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprechtag_invitations" ADD CONSTRAINT "sprechtag_invitations_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprechtag_invitations" ADD CONSTRAINT "sprechtag_invitations_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sprechtag_appointments_teacher_slot" ON "sprechtag_appointments" USING btree ("event_id","teacher_id","slot");--> statement-breakpoint
CREATE UNIQUE INDEX "sprechtag_appointments_student_slot" ON "sprechtag_appointments" USING btree ("event_id","student_id","slot");--> statement-breakpoint
CREATE UNIQUE INDEX "sprechtag_appointments_pair" ON "sprechtag_appointments" USING btree ("event_id","teacher_id","student_id");--> statement-breakpoint
CREATE INDEX "sprechtag_appointments_booker_idx" ON "sprechtag_appointments" USING btree ("event_id","booked_by");--> statement-breakpoint
CREATE INDEX "sprechtag_appointments_student_idx" ON "sprechtag_appointments" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "sprechtag_availability_teacher_idx" ON "sprechtag_availability" USING btree ("teacher_id");--> statement-breakpoint
CREATE INDEX "sprechtag_events_date_idx" ON "sprechtag_events" USING btree ("date");--> statement-breakpoint
CREATE INDEX "sprechtag_invitations_student_idx" ON "sprechtag_invitations" USING btree ("student_id");