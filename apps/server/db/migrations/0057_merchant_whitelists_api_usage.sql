-- Merchant whitelists (D-109: payout addresses per mode, API IPs) and API key analytics (D-110: hourly usage buckets
-- and the clients each key was used from). Guards and RLS in 0058.


CREATE TABLE "api_key_clients" (
	"key_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"ip" text NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_route" text DEFAULT '' NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"blocked" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "api_key_clients_ua_len" CHECK (char_length("api_key_clients"."user_agent") <= 300)
);
--> statement-breakpoint
CREATE TABLE "api_key_usage" (
	"key_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"route" text NOT NULL,
	"status_class" integer NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"total_ms" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "api_key_usage_status" CHECK ("api_key_usage"."status_class" between 0 and 5)
);
--> statement-breakpoint
CREATE TABLE "merchant_security_settings" (
	"merchant_id" uuid PRIMARY KEY NOT NULL,
	"addresses_live" boolean DEFAULT false NOT NULL,
	"addresses_live_disable_at" timestamp with time zone,
	"addresses_test" boolean DEFAULT false NOT NULL,
	"addresses_test_disable_at" timestamp with time zone,
	"ips" boolean DEFAULT false NOT NULL,
	"ips_disable_at" timestamp with time zone,
	"ip_entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_security_ip_entries" CHECK (jsonb_typeof("merchant_security_settings"."ip_entries") = 'array' and jsonb_array_length("merchant_security_settings"."ip_entries") <= 100 and (not "merchant_security_settings"."ips" or jsonb_array_length("merchant_security_settings"."ip_entries") > 0)),
	CONSTRAINT "merchant_security_disable_pending" CHECK (("merchant_security_settings"."addresses_live_disable_at" is null or "merchant_security_settings"."addresses_live") and ("merchant_security_settings"."addresses_test_disable_at" is null or "merchant_security_settings"."addresses_test") and ("merchant_security_settings"."ips_disable_at" is null or "merchant_security_settings"."ips"))
);
--> statement-breakpoint
CREATE TABLE "whitelisted_addresses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"family" text DEFAULT 'evm' NOT NULL,
	"address" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activates_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	CONSTRAINT "whitelisted_addresses_evm" CHECK ("whitelisted_addresses"."family" <> 'evm' or "whitelisted_addresses"."address" ~ '^0x[0-9a-fA-F]{40}$'),
	CONSTRAINT "whitelisted_addresses_label" CHECK (char_length("whitelisted_addresses"."label") <= 60)
);
--> statement-breakpoint
ALTER TABLE "admin_settings" ADD COLUMN "whitelist_activation_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_settings" ADD COLUMN "whitelist_disable_hours" integer DEFAULT 48 NOT NULL;--> statement-breakpoint
ALTER TABLE "api_key_clients" ADD CONSTRAINT "api_key_clients_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_clients" ADD CONSTRAINT "api_key_clients_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_usage" ADD CONSTRAINT "api_key_usage_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_usage" ADD CONSTRAINT "api_key_usage_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_security_settings" ADD CONSTRAINT "merchant_security_settings_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_security_settings" ADD CONSTRAINT "merchant_security_settings_updated_by_merchant_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."merchant_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whitelisted_addresses" ADD CONSTRAINT "whitelisted_addresses_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whitelisted_addresses" ADD CONSTRAINT "whitelisted_addresses_created_by_merchant_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."merchant_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whitelisted_addresses" ADD CONSTRAINT "whitelisted_addresses_removed_by_merchant_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."merchant_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_clients_uq" ON "api_key_clients" USING btree ("key_id","ip",md5("user_agent"));--> statement-breakpoint
CREATE INDEX "api_key_clients_merchant_idx" ON "api_key_clients" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_usage_uq" ON "api_key_usage" USING btree ("key_id","bucket","route","status_class");--> statement-breakpoint
CREATE INDEX "api_key_usage_merchant_idx" ON "api_key_usage" USING btree ("merchant_id","bucket");--> statement-breakpoint
CREATE UNIQUE INDEX "whitelisted_addresses_uq" ON "whitelisted_addresses" USING btree ("merchant_id","livemode","family",lower("address")) WHERE "whitelisted_addresses"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "whitelisted_addresses_merchant_idx" ON "whitelisted_addresses" USING btree ("merchant_id","livemode");--> statement-breakpoint
ALTER TABLE "admin_settings" ADD CONSTRAINT "admin_settings_whitelist" CHECK ("admin_settings"."whitelist_activation_hours" between 1 and 168 and "admin_settings"."whitelist_disable_hours" between 1 and 168);