-- MONEY-CRITICAL
-- Fee models and prepaid fee balance (M8, D-076).
-- New enum values by recreating the types, not ALTER TYPE ... ADD VALUE: drizzle applies every pending migration in one
-- transaction, and Postgres refuses to use a value added by ADD VALUE before that transaction commits. Constraints and
-- partial indexes that compare against the old type are dropped first and recreated on the new one.
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_owner";--> statement-breakpoint
DROP INDEX "ledger_journals_payment_uq";--> statement-breakpoint
DROP INDEX "ledger_journals_fee_uq";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_payment_ref";--> statement-breakpoint
ALTER TYPE "public"."ledger_account_kind" RENAME TO "ledger_account_kind_v1";--> statement-breakpoint
CREATE TYPE "public"."ledger_account_kind" AS ENUM('merchant_received', 'merchant_sales', 'merchant_fees_owed', 'platform_fee_revenue', 'platform_topups');--> statement-breakpoint
ALTER TABLE "ledger_accounts" ALTER COLUMN "kind" SET DATA TYPE "public"."ledger_account_kind" USING "kind"::text::"public"."ledger_account_kind";--> statement-breakpoint
DROP TYPE "public"."ledger_account_kind_v1";--> statement-breakpoint
ALTER TYPE "public"."ledger_journal_kind" RENAME TO "ledger_journal_kind_v1";--> statement-breakpoint
CREATE TYPE "public"."ledger_journal_kind" AS ENUM('payment', 'fee', 'fee_topup');--> statement-breakpoint
ALTER TABLE "ledger_journals" ALTER COLUMN "kind" SET DATA TYPE "public"."ledger_journal_kind" USING "kind"::text::"public"."ledger_journal_kind";--> statement-breakpoint
DROP TYPE "public"."ledger_journal_kind_v1";--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_payment_uq" ON "ledger_journals" USING btree ("payment_id") WHERE "ledger_journals"."kind" = 'payment';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_fee_uq" ON "ledger_journals" USING btree ("invoice_id") WHERE "ledger_journals"."kind" = 'fee';--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_payment_ref" CHECK (("ledger_journals"."kind" = 'payment') = ("ledger_journals"."payment_id" is not null));--> statement-breakpoint
CREATE TABLE "fee_topups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"token_id" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"reference" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_topups_amount" CHECK ("fee_topups"."amount" > 0),
	CONSTRAINT "fee_topups_reference_len" CHECK (char_length("fee_topups"."reference") between 3 and 200)
);
--> statement-breakpoint
ALTER TABLE "ledger_journals" ALTER COLUMN "invoice_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "fee_fixed" numeric(78, 0) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD COLUMN "topup_id" uuid;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "fee_fixed" numeric(20, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "fee_grace" numeric(20, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "fee_topups" ADD CONSTRAINT "fee_topups_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_topups" ADD CONSTRAINT "fee_topups_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_topups" ADD CONSTRAINT "fee_topups_created_by_admin_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fee_topups_merchant_idx" ON "fee_topups" USING btree ("merchant_id","livemode");--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_topup_id_fee_topups_id_fk" FOREIGN KEY ("topup_id") REFERENCES "public"."fee_topups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_topup_uq" ON "ledger_journals" USING btree ("topup_id") WHERE "ledger_journals"."kind" = 'fee_topup';--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_fee_fixed" CHECK ("invoices"."fee_fixed" >= 0);--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner" CHECK (("ledger_accounts"."kind" in ('platform_fee_revenue', 'platform_topups')) = ("ledger_accounts"."merchant_id" is null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_invoice_ref" CHECK (("ledger_journals"."kind" = 'fee_topup') = ("ledger_journals"."invoice_id" is null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_topup_ref" CHECK (("ledger_journals"."kind" = 'fee_topup') = ("ledger_journals"."topup_id" is not null));--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_fee_fixed_range" CHECK ("merchants"."fee_fixed" between 0 and 1000);--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_fee_grace_range" CHECK ("merchants"."fee_grace" between 0 and 100000);