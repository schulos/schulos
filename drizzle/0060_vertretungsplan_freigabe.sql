CREATE TABLE "timetable_substitution_days" (
	"date" date PRIMARY KEY NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" text,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "timetable_substitution_days" ADD CONSTRAINT "timetable_substitution_days_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_substitution_days" ADD CONSTRAINT "timetable_substitution_days_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;