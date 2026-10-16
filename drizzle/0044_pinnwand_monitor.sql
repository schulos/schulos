ALTER TABLE "monitor_screens" ADD COLUMN "board_id" text;--> statement-breakpoint
ALTER TABLE "pinnwaende_boards" ADD COLUMN "on_monitor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_screens" ADD CONSTRAINT "monitor_screens_board_id_pinnwaende_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."pinnwaende_boards"("id") ON DELETE set null ON UPDATE no action;