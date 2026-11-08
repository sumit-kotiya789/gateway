-- MONEY-CRITICAL
-- Merchant withdrawal limits, payout fee and payouts to the merchant's users (D-100). Guards: 0048.
CREATE TYPE "public"."withdrawal_kind" AS ENUM('merchant', 'customer');--> statement-breakpoint
CREATE TABLE "merchant_withdrawal_limits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"token_id" text NOT NULL,
	"per_tx" numeric(78, 0),
	"per_day" numeric(78, 0),
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_withdrawal_limits_positive" CHECK (coalesce("merchant_withdrawal_limits"."per_tx", 1) > 0 and coalesce("merchant_withdrawal_limits"."per_day", 1) > 0),
	CONSTRAINT "merchant_withdrawal_limits_order" CHECK ("merchant_withdrawal_limits"."per_tx" is null or "merchant_withdrawal_limits"."per_day" is null or "merchant_withdrawal_limits"."per_tx" <= "merchant_withdrawal_limits"."per_day")
);
--> statement-breakpoint
ALTER TABLE "withdrawals" ALTER COLUMN "payout_address_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "payout_fee" numeric(20, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD COLUMN "kind" "withdrawal_kind" DEFAULT 'merchant' NOT NULL;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD COLUMN "customer_ref" text;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD COLUMN "fee" numeric(78, 0) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_withdrawal_limits" ADD CONSTRAINT "merchant_withdrawal_limits_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_withdrawal_limits" ADD CONSTRAINT "merchant_withdrawal_limits_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_withdrawal_limits" ADD CONSTRAINT "merchant_withdrawal_limits_updated_by_merchant_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."merchant_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_withdrawal_limits_uq" ON "merchant_withdrawal_limits" USING btree ("merchant_id","livemode","token_id");--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_payout_fee_range" CHECK ("merchants"."payout_fee" between 0 and 1000);--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_fee" CHECK ("withdrawals"."fee" >= 0);--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_to_address" CHECK ("withdrawals"."to_address" ~ '^0x[0-9a-fA-F]{40}$');--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_kind" CHECK (("withdrawals"."kind" = 'merchant' and "withdrawals"."payout_address_id" is not null and "withdrawals"."customer_ref" is null and "withdrawals"."fee" = 0)
       or ("withdrawals"."kind" = 'customer' and "withdrawals"."payout_address_id" is null and char_length("withdrawals"."customer_ref") between 1 and 200));