CREATE TABLE "record_archives" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text,
	"group_name" text NOT NULL,
	"school_year_name" text NOT NULL,
	"closed_on" date NOT NULL,
	"destroy_earliest" date NOT NULL,
	"exported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exported_by" text,
	"handed_over_at" timestamp with time zone,
	"handed_over_by" text,
	CONSTRAINT "record_archives_group_id_unique" UNIQUE("group_id")
);
--> statement-breakpoint
CREATE TABLE "school_year_transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"from_year_id" text NOT NULL,
	"to_year_id" text NOT NULL,
	"started_by" text,
	"promoted_at" timestamp with time zone,
	"leavers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "school_year_transitions_from_year_id_unique" UNIQUE("from_year_id")
);
--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "record_archives" ADD CONSTRAINT "record_archives_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_archives" ADD CONSTRAINT "record_archives_exported_by_users_id_fk" FOREIGN KEY ("exported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_archives" ADD CONSTRAINT "record_archives_handed_over_by_users_id_fk" FOREIGN KEY ("handed_over_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_year_transitions" ADD CONSTRAINT "school_year_transitions_from_year_id_school_years_id_fk" FOREIGN KEY ("from_year_id") REFERENCES "public"."school_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_year_transitions" ADD CONSTRAINT "school_year_transitions_to_year_id_school_years_id_fk" FOREIGN KEY ("to_year_id") REFERENCES "public"."school_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_year_transitions" ADD CONSTRAINT "school_year_transitions_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_year_transitions" ADD CONSTRAINT "school_year_transitions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;