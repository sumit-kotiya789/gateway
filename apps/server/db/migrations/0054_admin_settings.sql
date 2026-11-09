-- Admin console settings (D-106): one row. Which invoice statuses need an admin decision, and how long an admin
-- session lasts (idle and absolute). Guards in 0055.


CREATE TABLE "admin_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"attention_statuses" text[] DEFAULT '{late_payment,held}' NOT NULL,
	"session_idle_minutes" integer DEFAULT 30 NOT NULL,
	"session_max_hours" integer DEFAULT 12 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_settings_single" CHECK ("admin_settings"."id" = 1),
	CONSTRAINT "admin_settings_attention" CHECK (cardinality("admin_settings"."attention_statuses") between 1 and 3 and "admin_settings"."attention_statuses" <@ array['late_payment', 'underpaid', 'held']::text[]),
	CONSTRAINT "admin_settings_session" CHECK ("admin_settings"."session_idle_minutes" between 5 and 240 and "admin_settings"."session_max_hours" between 1 and 24)
);
--> statement-breakpoint
ALTER TABLE "admin_settings" ADD CONSTRAINT "admin_settings_updated_by_admin_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;