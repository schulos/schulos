ALTER TABLE "kurswahl_verfahren" ADD COLUMN "min_courses" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "kurswahl_verfahren" ADD COLUMN "max_courses" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "kurswahl_wahlen" ADD COLUMN "place" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "kurswahl_wahlen" DROP CONSTRAINT "kurswahl_wahlen_verfahren_id_student_id_pk";--> statement-breakpoint
ALTER TABLE "kurswahl_wahlen" ADD CONSTRAINT "kurswahl_wahlen_verfahren_id_student_id_place_pk" PRIMARY KEY("verfahren_id","student_id","place");--> statement-breakpoint
ALTER TABLE "kurswahl_verfahren" ADD CONSTRAINT "kurswahl_verfahren_courses" CHECK ("kurswahl_verfahren"."min_courses" >= 1 and "kurswahl_verfahren"."max_courses" >= "kurswahl_verfahren"."min_courses" and "kurswahl_verfahren"."max_courses" <= 6);--> statement-breakpoint
ALTER TABLE "kurswahl_wahlen" ADD CONSTRAINT "kurswahl_wahlen_place" CHECK ("kurswahl_wahlen"."place" between 1 and 6);
