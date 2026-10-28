CREATE TYPE "public"."ganztag_excused" AS ENUM('offen', 'ja', 'nein');--> statement-breakpoint
CREATE TYPE "public"."ganztag_mark_source" AS ENUM('leitung', 'alle_anwesend', 'abwesenheiten');--> statement-breakpoint
CREATE TYPE "public"."ganztag_mark_status" AS ENUM('anwesend', 'fehlt', 'verspaetet');--> statement-breakpoint
CREATE TYPE "public"."ganztag_session_status" AS ENUM('geplant', 'ausgefallen', 'erfasst');--> statement-breakpoint
CREATE TABLE "ganztag_group_settings" (
	"group_id" text PRIMARY KEY NOT NULL,
	"mandatory" boolean DEFAULT false NOT NULL,
	"notify_class_lead" boolean DEFAULT true NOT NULL,
	"prefill_absences" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ganztag_marks" (
	"session_id" text NOT NULL,
	"student_id" text NOT NULL,
	"status" "ganztag_mark_status" NOT NULL,
	"minutes_late" integer,
	"excused" "ganztag_excused" DEFAULT 'offen' NOT NULL,
	"source" "ganztag_mark_source" DEFAULT 'leitung' NOT NULL,
	"recorded_by" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ganztag_marks_session_id_student_id_pk" PRIMARY KEY("session_id","student_id"),
	CONSTRAINT "ganztag_marks_late" CHECK ("ganztag_marks"."minutes_late" is null or ("ganztag_marks"."status" = 'verspaetet' and "ganztag_marks"."minutes_late" between 1 and 240))
);
--> statement-breakpoint
CREATE TABLE "ganztag_series" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"school_year_id" text,
	"weekday" integer NOT NULL,
	"starts_at" text NOT NULL,
	"ends_at" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ganztag_series_weekday" CHECK ("ganztag_series"."weekday" between 0 and 4),
	CONSTRAINT "ganztag_series_time" CHECK ("ganztag_series"."ends_at" > "ganztag_series"."starts_at"),
	CONSTRAINT "ganztag_series_valid" CHECK ("ganztag_series"."valid_to" >= "ganztag_series"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "ganztag_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"series_id" text,
	"date" date NOT NULL,
	"starts_at" text NOT NULL,
	"ends_at" text NOT NULL,
	"status" "ganztag_session_status" DEFAULT 'geplant' NOT NULL,
	"all_present" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"recorded_at" timestamp with time zone,
	"recorded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ganztag_sessions_time" CHECK ("ganztag_sessions"."ends_at" > "ganztag_sessions"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "ganztag_group_settings" ADD CONSTRAINT "ganztag_group_settings_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ganztag_marks" ADD CONSTRAINT "ganztag_marks_session_id_ganztag_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ganztag_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ganztag_marks" ADD CONSTRAINT "ganztag_marks_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ganztag_marks" ADD CONSTRAINT "ganztag_marks_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ganztag_series" ADD CONSTRAINT "ganztag_series_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ganztag_series" ADD CONSTRAINT "ganztag_series_school_year_id_school_years_id_fk" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ganztag_sessions" ADD CONSTRAINT "ganztag_sessions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ganztag_sessions" ADD CONSTRAINT "ganztag_sessions_series_id_ganztag_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."ganztag_series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ganztag_sessions" ADD CONSTRAINT "ganztag_sessions_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ganztag_marks_student_idx" ON "ganztag_marks" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "ganztag_series_group_idx" ON "ganztag_series" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ganztag_sessions_slot_uq" ON "ganztag_sessions" USING btree ("group_id","date","starts_at");--> statement-breakpoint
CREATE INDEX "ganztag_sessions_date_idx" ON "ganztag_sessions" USING btree ("date");--> statement-breakpoint
CREATE INDEX "ganztag_sessions_series_idx" ON "ganztag_sessions" USING btree ("series_id");