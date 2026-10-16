CREATE TABLE "sitzplan_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"title" text NOT NULL,
	"subject_id" text,
	"room_id" text,
	"owner_id" text,
	"school_year_id" text,
	"rows" integer NOT NULL,
	"cols" integer NOT NULL,
	"desks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sitzplan_plans_rows" CHECK ("sitzplan_plans"."rows" between 1 and 12),
	CONSTRAINT "sitzplan_plans_cols" CHECK ("sitzplan_plans"."cols" between 1 and 12)
);
--> statement-breakpoint
CREATE TABLE "sitzplan_seats" (
	"plan_id" text NOT NULL,
	"student_id" text NOT NULL,
	"row" integer NOT NULL,
	"col" integer NOT NULL,
	CONSTRAINT "sitzplan_seats_plan_id_student_id_pk" PRIMARY KEY("plan_id","student_id")
);
--> statement-breakpoint
ALTER TABLE "sitzplan_plans" ADD CONSTRAINT "sitzplan_plans_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitzplan_plans" ADD CONSTRAINT "sitzplan_plans_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sitzplan_plans" ADD CONSTRAINT "sitzplan_plans_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sitzplan_plans" ADD CONSTRAINT "sitzplan_plans_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitzplan_plans" ADD CONSTRAINT "sitzplan_plans_school_year_id_school_years_id_fk" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitzplan_seats" ADD CONSTRAINT "sitzplan_seats_plan_id_sitzplan_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."sitzplan_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitzplan_seats" ADD CONSTRAINT "sitzplan_seats_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sitzplan_plans_group_idx" ON "sitzplan_plans" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sitzplan_seats_place" ON "sitzplan_seats" USING btree ("plan_id","row","col");--> statement-breakpoint
CREATE INDEX "sitzplan_seats_student_idx" ON "sitzplan_seats" USING btree ("student_id");