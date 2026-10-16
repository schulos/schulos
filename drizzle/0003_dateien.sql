CREATE TYPE "public"."file_kind" AS ENUM('folder', 'file');--> statement-breakpoint
CREATE TABLE "file_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "file_kind" NOT NULL,
	"name" text NOT NULL,
	"parent_id" text,
	"owner_id" text,
	"group_id" text,
	"size" bigint DEFAULT 0 NOT NULL,
	"mime" text,
	"storage_key" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_nodes_space" CHECK (("file_nodes"."owner_id" is null) <> ("file_nodes"."group_id" is null)),
	CONSTRAINT "file_nodes_storage" CHECK (("file_nodes"."kind" = 'file') = ("file_nodes"."storage_key" is not null))
);
--> statement-breakpoint
ALTER TABLE "file_nodes" ADD CONSTRAINT "file_nodes_parent_id_file_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."file_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_nodes" ADD CONSTRAINT "file_nodes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_nodes" ADD CONSTRAINT "file_nodes_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_nodes" ADD CONSTRAINT "file_nodes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_nodes_parent_idx" ON "file_nodes" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "file_nodes_owner_idx" ON "file_nodes" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "file_nodes_group_idx" ON "file_nodes" USING btree ("group_id");