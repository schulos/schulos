CREATE TYPE "public"."school_closure_kind" AS ENUM('ferien', 'frei');--> statement-breakpoint
CREATE TABLE "school_closures" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "school_closure_kind" NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	CONSTRAINT "school_closures_range" CHECK ("school_closures"."ends_on" >= "school_closures"."starts_on")
);
--> statement-breakpoint
CREATE INDEX "school_closures_starts_idx" ON "school_closures" USING btree ("starts_on");