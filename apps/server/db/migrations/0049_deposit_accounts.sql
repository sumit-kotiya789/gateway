-- MONEY-CRITICAL
-- Permanent deposit addresses per user (D-101). Guards: 0050.
CREATE TYPE "public"."invoice_kind" AS ENUM('payment', 'deposit');--> statement-breakpoint
CREATE TABLE "deposit_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"customer_ref" text NOT NULL,
	"chain_id" text NOT NULL,
	"token_id" text NOT NULL,
	"custody_mode" "custody_mode" NOT NULL,
	"deposit_address_id" uuid NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposit_accounts_customer_ref" CHECK (char_length("deposit_accounts"."customer_ref") between 1 and 200)
);
--> statement-breakpoint
DROP INDEX "invoices_deposit_address_uq";--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "kind" "invoice_kind" DEFAULT 'payment' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "deposit_account_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "deposit_ref" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "customer_ref" text;--> statement-breakpoint
ALTER TABLE "deposit_accounts" ADD CONSTRAINT "deposit_accounts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_accounts" ADD CONSTRAINT "deposit_accounts_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_accounts" ADD CONSTRAINT "deposit_accounts_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_accounts" ADD CONSTRAINT "deposit_accounts_deposit_address_id_deposit_addresses_id_fk" FOREIGN KEY ("deposit_address_id") REFERENCES "public"."deposit_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_accounts_address_uq" ON "deposit_accounts" USING btree ("deposit_address_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_accounts_current_uq" ON "deposit_accounts" USING btree ("merchant_id","livemode","customer_ref","token_id") WHERE "deposit_accounts"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "deposit_accounts_merchant_idx" ON "deposit_accounts" USING btree ("merchant_id","livemode","id");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_deposit_account_id_deposit_accounts_id_fk" FOREIGN KEY ("deposit_account_id") REFERENCES "public"."deposit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_deposit_ref_uq" ON "invoices" USING btree ("deposit_account_id","deposit_ref") WHERE "invoices"."kind" = 'deposit';--> statement-breakpoint
CREATE INDEX "invoices_deposit_account_idx" ON "invoices" USING btree ("deposit_account_id","id") WHERE "invoices"."kind" = 'deposit';--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_deposit_address_uq" ON "invoices" USING btree ("deposit_address_id") WHERE "invoices"."kind" = 'payment';--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_kind" CHECK (("invoices"."kind" = 'payment' and "invoices"."deposit_account_id" is null and "invoices"."deposit_ref" is null and "invoices"."customer_ref" is null)
       or ("invoices"."kind" = 'deposit' and "invoices"."deposit_account_id" is not null and "invoices"."deposit_ref" is not null and "invoices"."customer_ref" is not null));