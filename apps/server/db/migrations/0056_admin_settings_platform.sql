-- Admin console settings, centralized (D-107): admin IP allowlist with an on/off switch, the two-admin withdrawal
-- threshold (never above the server ceiling), merchant sign-ups and the defaults a new merchant gets.


ALTER TABLE "admin_settings" ADD COLUMN "ip_allowlist_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_settings" ADD COLUMN "ip_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_settings" ADD COLUMN "withdrawal_two_person_min" numeric(20, 0);--> statement-breakpoint
ALTER TABLE "admin_settings" ADD COLUMN "signup_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_settings" ADD COLUMN "default_fee_bps" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_settings" ADD COLUMN "default_fee_fixed" numeric(20, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_settings" ADD COLUMN "default_fee_grace" numeric(20, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_settings" ADD COLUMN "default_payout_fee" numeric(20, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_settings" ADD COLUMN "default_underpay_tolerance_bps" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_settings" ADD CONSTRAINT "admin_settings_ip_allowlist" CHECK (jsonb_typeof("admin_settings"."ip_allowlist") = 'array' and jsonb_array_length("admin_settings"."ip_allowlist") <= 50 and (not "admin_settings"."ip_allowlist_enabled" or jsonb_array_length("admin_settings"."ip_allowlist") > 0));--> statement-breakpoint
ALTER TABLE "admin_settings" ADD CONSTRAINT "admin_settings_two_person" CHECK ("admin_settings"."withdrawal_two_person_min" is null or "admin_settings"."withdrawal_two_person_min" >= 1);--> statement-breakpoint
ALTER TABLE "admin_settings" ADD CONSTRAINT "admin_settings_merchant_defaults" CHECK ("admin_settings"."default_fee_bps" between 0 and 10000 and "admin_settings"."default_fee_fixed" between 0 and 1000 and "admin_settings"."default_fee_grace" between 0 and 100000
        and "admin_settings"."default_payout_fee" between 0 and 1000 and "admin_settings"."default_underpay_tolerance_bps" between 0 and 500);