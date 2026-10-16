CREATE TYPE "public"."notenbuch_column_kind" AS ENUM('schriftlich', 'sonstige');--> statement-breakpoint
CREATE TYPE "public"."notenbuch_scale" AS ENUM('noten6', 'noten6_tendenz', 'punkte15');--> statement-breakpoint
CREATE TABLE "notenbuch_book_teachers" (
	"book_id" text NOT NULL,
	"teacher_id" text NOT NULL,
	CONSTRAINT "notenbuch_book_teachers_book_id_teacher_id_pk" PRIMARY KEY("book_id","teacher_id")
);
--> statement-breakpoint
CREATE TABLE "notenbuch_books" (
	"id" text PRIMARY KEY NOT NULL,
	"school_year_id" text NOT NULL,
	"term" integer NOT NULL,
	"group_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"assignment_id" text,
	"scale" "notenbuch_scale" NOT NULL,
	"weights" jsonb NOT NULL,
	"locked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notenbuch_books_term" CHECK ("notenbuch_books"."term" in (1, 2))
);
--> statement-breakpoint
CREATE TABLE "notenbuch_columns" (
	"id" text PRIMARY KEY NOT NULL,
	"book_id" text NOT NULL,
	"kind" "notenbuch_column_kind" NOT NULL,
	"title" text NOT NULL,
	"date" date,
	"weight" integer DEFAULT 100 NOT NULL,
	"max_points" double precision,
	"points_to_grade" jsonb,
	"exam_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notenbuch_columns_weight" CHECK ("notenbuch_columns"."weight" between 0 and 1000),
	CONSTRAINT "notenbuch_columns_max_points" CHECK ("notenbuch_columns"."max_points" is null or ("notenbuch_columns"."max_points" > 0 and "notenbuch_columns"."max_points" <= 1000))
);
--> statement-breakpoint
CREATE TABLE "notenbuch_entries" (
	"column_id" text NOT NULL,
	"student_id" text NOT NULL,
	"value" text NOT NULL,
	"comment" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notenbuch_entries_column_id_student_id_pk" PRIMARY KEY("column_id","student_id"),
	CONSTRAINT "notenbuch_entries_comment" CHECK ("notenbuch_entries"."comment" is null or char_length("notenbuch_entries"."comment") <= 200),
	CONSTRAINT "notenbuch_entries_value" CHECK (char_length("notenbuch_entries"."value") between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "notenbuch_term_grades" (
	"book_id" text NOT NULL,
	"student_id" text NOT NULL,
	"computed" text,
	"final" text,
	"finalized_at" timestamp with time zone,
	"finalized_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notenbuch_term_grades_book_id_student_id_pk" PRIMARY KEY("book_id","student_id")
);
--> statement-breakpoint
ALTER TABLE "notenbuch_book_teachers" ADD CONSTRAINT "notenbuch_book_teachers_book_id_notenbuch_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."notenbuch_books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notenbuch_book_teachers" ADD CONSTRAINT "notenbuch_book_teachers_teacher_id_users_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notenbuch_books" ADD CONSTRAINT "notenbuch_books_school_year_id_school_years_id_fk" FOREIGN KEY ("school_year_id") REFERENCES "public"."school_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notenbuch_books" ADD CONSTRAINT "notenbuch_books_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notenbuch_books" ADD CONSTRAINT "notenbuch_books_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "notenbuch_books" ADD CONSTRAINT "notenbuch_books_assignment_id_timetable_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."timetable_assignments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notenbuch_books" ADD CONSTRAINT "notenbuch_books_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notenbuch_columns" ADD CONSTRAINT "notenbuch_columns_book_id_notenbuch_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."notenbuch_books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notenbuch_columns" ADD CONSTRAINT "notenbuch_columns_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notenbuch_entries" ADD CONSTRAINT "notenbuch_entries_column_id_notenbuch_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."notenbuch_columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notenbuch_entries" ADD CONSTRAINT "notenbuch_entries_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notenbuch_entries" ADD CONSTRAINT "notenbuch_entries_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notenbuch_term_grades" ADD CONSTRAINT "notenbuch_term_grades_book_id_notenbuch_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."notenbuch_books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notenbuch_term_grades" ADD CONSTRAINT "notenbuch_term_grades_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notenbuch_term_grades" ADD CONSTRAINT "notenbuch_term_grades_finalized_by_users_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notenbuch_book_teachers_teacher_idx" ON "notenbuch_book_teachers" USING btree ("teacher_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notenbuch_books_unique" ON "notenbuch_books" USING btree ("school_year_id","term","group_id","subject_id");--> statement-breakpoint
CREATE INDEX "notenbuch_books_group_idx" ON "notenbuch_books" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "notenbuch_columns_book_idx" ON "notenbuch_columns" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "notenbuch_entries_student_idx" ON "notenbuch_entries" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "notenbuch_term_grades_student_idx" ON "notenbuch_term_grades" USING btree ("student_id");