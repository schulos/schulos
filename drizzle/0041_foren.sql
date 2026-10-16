CREATE TABLE "foren_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"author_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"hidden_at" timestamp with time zone,
	"hidden_by" text,
	"hidden_reason" text
);
--> statement-breakpoint
CREATE TABLE "foren_subscriptions" (
	"topic_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "foren_subscriptions_topic_id_user_id_pk" PRIMARY KEY("topic_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "foren_topics" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text,
	"author_id" text,
	"title" text NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_post_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "foren_posts" ADD CONSTRAINT "foren_posts_topic_id_foren_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."foren_topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foren_posts" ADD CONSTRAINT "foren_posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foren_posts" ADD CONSTRAINT "foren_posts_hidden_by_users_id_fk" FOREIGN KEY ("hidden_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foren_subscriptions" ADD CONSTRAINT "foren_subscriptions_topic_id_foren_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."foren_topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foren_subscriptions" ADD CONSTRAINT "foren_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foren_topics" ADD CONSTRAINT "foren_topics_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foren_topics" ADD CONSTRAINT "foren_topics_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "foren_posts_topic_idx" ON "foren_posts" USING btree ("topic_id","created_at");--> statement-breakpoint
CREATE INDEX "foren_topics_group_idx" ON "foren_topics" USING btree ("group_id","last_post_at");