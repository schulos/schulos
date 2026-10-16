CREATE TYPE "public"."grade_stage" AS ENUM('sek1', 'oberstufe');--> statement-breakpoint
ALTER TYPE "public"."group_kind" ADD VALUE 'wahlpflicht';--> statement-breakpoint
ALTER TYPE "public"."group_kind" ADD VALUE 'foerderkurs';--> statement-breakpoint
CREATE TABLE "grade_levels" (
	"level" integer PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"stage" "grade_stage" NOT NULL,
	CONSTRAINT "grade_levels_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "level" text;