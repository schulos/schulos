CREATE TABLE "hilfe_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hilfe_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"seq" integer GENERATED ALWAYS AS IDENTITY (sequence name "hilfe_revisions_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"author_id" text,
	"authored_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hilfe_attachments" ADD CONSTRAINT "hilfe_attachments_page_id_hilfe_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."hilfe_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hilfe_attachments" ADD CONSTRAINT "hilfe_attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hilfe_revisions" ADD CONSTRAINT "hilfe_revisions_page_id_hilfe_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."hilfe_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hilfe_revisions" ADD CONSTRAINT "hilfe_revisions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hilfe_attachments_page_idx" ON "hilfe_attachments" USING btree ("page_id","created_at");--> statement-breakpoint
CREATE INDEX "hilfe_revisions_page_idx" ON "hilfe_revisions" USING btree ("page_id","created_at");