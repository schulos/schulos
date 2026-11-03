CREATE TABLE "ganztag_meal_orders" (
	"date" date NOT NULL,
	"student_id" text NOT NULL,
	"menu_number" integer NOT NULL,
	"ordered_by" text,
	"ordered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ganztag_meal_orders_date_student_id_pk" PRIMARY KEY("date","student_id"),
	CONSTRAINT "ganztag_meal_orders_menu" CHECK ("ganztag_meal_orders"."menu_number" between 1 and 4)
);
--> statement-breakpoint
CREATE TABLE "ganztag_menus" (
	"date" date NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ganztag_menus_date_number_pk" PRIMARY KEY("date","number"),
	CONSTRAINT "ganztag_menus_number" CHECK ("ganztag_menus"."number" between 1 and 4),
	CONSTRAINT "ganztag_menus_title" CHECK (length("ganztag_menus"."title") between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "ganztag_meal_orders" ADD CONSTRAINT "ganztag_meal_orders_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ganztag_meal_orders" ADD CONSTRAINT "ganztag_meal_orders_ordered_by_users_id_fk" FOREIGN KEY ("ordered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ganztag_meal_orders_student_idx" ON "ganztag_meal_orders" USING btree ("student_id");