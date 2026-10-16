CREATE TABLE "kurswahl_angebote" (
	"id" text PRIMARY KEY NOT NULL,
	"verfahren_id" text NOT NULL,
	"title" text NOT NULL,
	"subject_id" text,
	"level" text,
	"min_size" integer DEFAULT 0 NOT NULL,
	"max_size" integer,
	"note" text,
	"teacher_id" text,
	"hours" integer,
	"group_id" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "kurswahl_angebote_min" CHECK ("kurswahl_angebote"."min_size" >= 0),
	CONSTRAINT "kurswahl_angebote_max" CHECK ("kurswahl_angebote"."max_size" is null or ("kurswahl_angebote"."max_size" >= 1 and "kurswahl_angebote"."max_size" >= "kurswahl_angebote"."min_size")),
	CONSTRAINT "kurswahl_angebote_hours" CHECK ("kurswahl_angebote"."hours" is null or "kurswahl_angebote"."hours" between 1 and 12)
);
--> statement-breakpoint
CREATE TABLE "kurswahl_verfahren" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"note" text,
	"grade_level" integer NOT NULL,
	"class_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"course_grade" integer NOT NULL,
	"school_year_id" text,
	"opens_on" date NOT NULL,
	"closes_on" date NOT NULL,
	"choices" integer DEFAULT 3 NOT NULL,
	"chooser" text DEFAULT 'eltern' NOT NULL,
	"parent_confirm" boolean DEFAULT false NOT NULL,
	"allocation_seed" text,
	"allocated_at" timestamp with time zone,
	"transferred_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kurswahl_verfahren_range" CHECK ("kurswahl_verfahren"."closes_on" >= "kurswahl_verfahren"."opens_on"),
	CONSTRAINT "kurswahl_verfahren_choices" CHECK ("kurswahl_verfahren"."choices" between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE "kurswahl_wahlen" (
	"verfahren_id" text NOT NULL,
	"student_id" text NOT NULL,
	"choices" text[] DEFAULT '{}'::text[] NOT NULL,
	"submitted_by" text,
	"submitted_at" timestamp with time zone,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"assigned_id" text,
	"assigned_rank" integer,
	"reason" text,
	"manual" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kurswahl_wahlen_verfahren_id_student_id_pk" PRIMARY KEY("verfahren_id","student_id")
);
--> statement-breakpoint
ALTER TABLE "kurswahl_angebote" ADD CONSTRAINT "kurswahl_angebote_verfahren_id_kurswahl_verfahren_id_fk" FOREIGN KEY ("verfahren_id") REFERENCES "public"."kurswahl_verfahren"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kurswahl_angebote" ADD CONSTRAINT "kurswahl_angebote_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "kurswahl_angebote" ADD CONSTRAINT "kurswahl_angebote_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kurswahl_angebote" ADD CONSTRAINT "kurswahl_angebote_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kurswahl_verfahren" ADD CONSTRAINT "kurswahl_verfahren_school_year_id_school_years_id_fk" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kurswahl_wahlen" ADD CONSTRAINT "kurswahl_wahlen_verfahren_id_kurswahl_verfahren_id_fk" FOREIGN KEY ("verfahren_id") REFERENCES "public"."kurswahl_verfahren"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kurswahl_wahlen" ADD CONSTRAINT "kurswahl_wahlen_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kurswahl_wahlen" ADD CONSTRAINT "kurswahl_wahlen_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kurswahl_wahlen" ADD CONSTRAINT "kurswahl_wahlen_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kurswahl_wahlen" ADD CONSTRAINT "kurswahl_wahlen_assigned_id_kurswahl_angebote_id_fk" FOREIGN KEY ("assigned_id") REFERENCES "public"."kurswahl_angebote"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kurswahl_angebote_verfahren_idx" ON "kurswahl_angebote" USING btree ("verfahren_id");--> statement-breakpoint
CREATE INDEX "kurswahl_verfahren_closes_idx" ON "kurswahl_verfahren" USING btree ("closes_on");--> statement-breakpoint
CREATE INDEX "kurswahl_wahlen_student_idx" ON "kurswahl_wahlen" USING btree ("student_id");