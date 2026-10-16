CREATE TYPE "public"."pinnwaende_mode" AS ENUM('leitung', 'alle', 'moderiert');--> statement-breakpoint
CREATE TYPE "public"."pinnwaende_card_kind" AS ENUM('text', 'link', 'file');--> statement-breakpoint
CREATE TABLE "pinnwaende_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"column_id" text NOT NULL,
	"author_id" text,
	"kind" "pinnwaende_card_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"url" text,
	"file_id" text,
	"position" integer NOT NULL,
	"approved" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pinnwaende_columns" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"title" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pinnwaende_members" (
	"board_id" text NOT NULL,
	"user_id" text NOT NULL,
	"leader" boolean DEFAULT false NOT NULL,
	CONSTRAINT "pinnwaende_members_board_id_user_id_pk" PRIMARY KEY("board_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "pinnwaende_boards" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text,
	"owner_id" text,
	"title" text NOT NULL,
	"mode" "pinnwaende_mode" DEFAULT 'alle' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pinnwaende_cards" ADD CONSTRAINT "pinnwaende_cards_board_id_pinnwaende_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."pinnwaende_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinnwaende_cards" ADD CONSTRAINT "pinnwaende_cards_column_id_pinnwaende_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."pinnwaende_columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinnwaende_cards" ADD CONSTRAINT "pinnwaende_cards_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinnwaende_cards" ADD CONSTRAINT "pinnwaende_cards_file_id_file_nodes_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinnwaende_columns" ADD CONSTRAINT "pinnwaende_columns_board_id_pinnwaende_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."pinnwaende_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinnwaende_members" ADD CONSTRAINT "pinnwaende_members_board_id_pinnwaende_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."pinnwaende_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinnwaende_members" ADD CONSTRAINT "pinnwaende_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinnwaende_boards" ADD CONSTRAINT "pinnwaende_boards_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinnwaende_boards" ADD CONSTRAINT "pinnwaende_boards_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pinnwaende_cards_column_idx" ON "pinnwaende_cards" USING btree ("column_id","position");--> statement-breakpoint
CREATE INDEX "pinnwaende_columns_board_idx" ON "pinnwaende_columns" USING btree ("board_id","position");--> statement-breakpoint
CREATE INDEX "pinnwaende_members_user_idx" ON "pinnwaende_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pinnwaende_boards_group_idx" ON "pinnwaende_boards" USING btree ("group_id");