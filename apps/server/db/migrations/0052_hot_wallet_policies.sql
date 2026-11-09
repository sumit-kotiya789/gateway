-- Hot wallet policy (D-105): per mode and token, a cap (excess moves to cold automatically) and a low mark (admins
-- are emailed). Automatic treasury transfers are flagged `auto`; their guards are in 0053.

CREATE TABLE "hot_wallet_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"livemode" boolean NOT NULL,
	"token_id" text NOT NULL,
	"max_balance" numeric(78, 0),
	"low_balance" numeric(78, 0),
	"last_balance" numeric(78, 0),
	"last_checked_at" timestamp with time zone,
	"low_alert_at" timestamp with time zone,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hot_wallet_policies_positive" CHECK (coalesce("hot_wallet_policies"."max_balance", 1) > 0 and coalesce("hot_wallet_policies"."low_balance", 0) >= 0),
	CONSTRAINT "hot_wallet_policies_order" CHECK ("hot_wallet_policies"."max_balance" is null or "hot_wallet_policies"."low_balance" is null or "hot_wallet_policies"."low_balance" < "hot_wallet_policies"."max_balance")
);
--> statement-breakpoint
ALTER TABLE "treasury_transfers" ADD COLUMN "auto" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hot_wallet_policies" ADD CONSTRAINT "hot_wallet_policies_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hot_wallet_policies" ADD CONSTRAINT "hot_wallet_policies_updated_by_admin_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hot_wallet_policies_uq" ON "hot_wallet_policies" USING btree ("livemode","token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_transfers_auto_open_uq" ON "treasury_transfers" USING btree ("livemode","token_id") WHERE "treasury_transfers"."auto" and "treasury_transfers"."status" in ('approved', 'sent');--> statement-breakpoint
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_auto_to_cold" CHECK (not "treasury_transfers"."auto" or ("treasury_transfers"."direction" = 'to_cold' and "treasury_transfers"."approved_by" is null));