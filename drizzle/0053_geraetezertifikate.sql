CREATE TABLE "device_certs" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"common_name" text NOT NULL,
	"fingerprint" text NOT NULL,
	"serial" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"user_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" text
);
--> statement-breakpoint
ALTER TABLE "device_certs" ADD CONSTRAINT "device_certs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_certs" ADD CONSTRAINT "device_certs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_certs" ADD CONSTRAINT "device_certs_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_certs_fingerprint_idx" ON "device_certs" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "device_certs_user_idx" ON "device_certs" USING btree ("user_id");