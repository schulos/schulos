CREATE TYPE "public"."letter_response" AS ENUM('none', 'yesno', 'text');--> statement-breakpoint
CREATE TABLE "parent_letter_groups" (
	"letter_id" text NOT NULL,
	"group_id" text NOT NULL,
	CONSTRAINT "parent_letter_groups_letter_id_group_id_pk" PRIMARY KEY("letter_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "parent_letter_receipts" (
	"letter_id" text NOT NULL,
	"student_id" text NOT NULL,
	"read_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" text,
	"answer_yes" boolean,
	"answer_text" text,
	CONSTRAINT "parent_letter_receipts_letter_id_student_id_pk" PRIMARY KEY("letter_id","student_id")
);
--> statement-breakpoint
CREATE TABLE "parent_letters" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"author_id" text,
	"response_type" "letter_response" DEFAULT 'none' NOT NULL,
	"question" text,
	"due_date" date,
	"attachment_name" text,
	"attachment_mime" text,
	"attachment_size" bigint,
	"attachment_key" text,
	"last_reminded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "parent_letter_groups" ADD CONSTRAINT "parent_letter_groups_letter_id_parent_letters_id_fk" FOREIGN KEY ("letter_id") REFERENCES "public"."parent_letters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_letter_groups" ADD CONSTRAINT "parent_letter_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_letter_receipts" ADD CONSTRAINT "parent_letter_receipts_letter_id_parent_letters_id_fk" FOREIGN KEY ("letter_id") REFERENCES "public"."parent_letters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_letter_receipts" ADD CONSTRAINT "parent_letter_receipts_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_letter_receipts" ADD CONSTRAINT "parent_letter_receipts_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_letters" ADD CONSTRAINT "parent_letters_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parent_letter_receipts_student_idx" ON "parent_letter_receipts" USING btree ("student_id");