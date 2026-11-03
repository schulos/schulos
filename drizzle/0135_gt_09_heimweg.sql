CREATE TYPE "public"."ganztag_way_home" AS ENUM('allein', 'abgeholt', 'bus');--> statement-breakpoint
CREATE TABLE "ganztag_departures" (
	"session_id" text NOT NULL,
	"student_id" text NOT NULL,
	"way" "ganztag_way_home",
	"changed_by" text,
	"changed_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"left_by" text,
	CONSTRAINT "ganztag_departures_session_id_student_id_pk" PRIMARY KEY("session_id","student_id")
);
--> statement-breakpoint
CREATE TABLE "ganztag_way_home_rules" (
	"group_id" text NOT NULL,
	"student_id" text NOT NULL,
	"way" "ganztag_way_home" NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ganztag_way_home_rules_group_id_student_id_pk" PRIMARY KEY("group_id","student_id")
);
--> statement-breakpoint
ALTER TABLE "ganztag_departures" ADD CONSTRAINT "ganztag_departures_session_id_ganztag_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ganztag_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ganztag_departures" ADD CONSTRAINT "ganztag_departures_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ganztag_departures" ADD CONSTRAINT "ganztag_departures_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ganztag_departures" ADD CONSTRAINT "ganztag_departures_left_by_users_id_fk" FOREIGN KEY ("left_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ganztag_way_home_rules" ADD CONSTRAINT "ganztag_way_home_rules_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ganztag_way_home_rules" ADD CONSTRAINT "ganztag_way_home_rules_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ganztag_way_home_rules" ADD CONSTRAINT "ganztag_way_home_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ganztag_departures_student_idx" ON "ganztag_departures" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "ganztag_way_home_rules_student_idx" ON "ganztag_way_home_rules" USING btree ("student_id");