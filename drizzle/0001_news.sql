CREATE TABLE "news_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"author_id" text,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"role" "role",
	"group_id" text,
	CONSTRAINT "news_targets_one" CHECK (("news_targets"."role" is null) <> ("news_targets"."group_id" is null))
);
--> statement-breakpoint
ALTER TABLE "news_posts" ADD CONSTRAINT "news_posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_targets" ADD CONSTRAINT "news_targets_post_id_news_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."news_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_targets" ADD CONSTRAINT "news_targets_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "news_posts_published_idx" ON "news_posts" USING btree ("published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "news_targets_role_uq" ON "news_targets" USING btree ("post_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "news_targets_group_uq" ON "news_targets" USING btree ("post_id","group_id");