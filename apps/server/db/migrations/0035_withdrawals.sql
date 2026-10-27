-- MONEY-CRITICAL
-- Payout addresses and withdrawals (M7d, D-090). Journal kinds added by recreating the type (see 0017).
CREATE TYPE "public"."withdrawal_status" AS ENUM('pending_approval', 'approved', 'sent', 'confirmed', 'failed', 'rejected', 'cancelled');--> statement-breakpoint
DROP INDEX "ledger_journals_payment_uq";--> statement-breakpoint
DROP INDEX "ledger_journals_fee_uq";--> statement-breakpoint
DROP INDEX "ledger_journals_topup_uq";--> statement-breakpoint
DROP INDEX "ledger_journals_settlement_uq";--> statement-breakpoint
DROP INDEX "ledger_journals_sweep_uq";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_payment_ref";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_invoice_ref";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_topup_ref";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_sweep_ref";--> statement-breakpoint
ALTER TYPE "public"."ledger_journal_kind" RENAME TO "ledger_journal_kind_v4";--> statement-breakpoint
CREATE TYPE "public"."ledger_journal_kind" AS ENUM('payment', 'fee', 'fee_topup', 'settlement', 'sweep', 'withdrawal_hold', 'withdrawal', 'withdrawal_release');--> statement-breakpoint
ALTER TABLE "ledger_journals" ALTER COLUMN "kind" SET DATA TYPE "public"."ledger_journal_kind" USING "kind"::text::"public"."ledger_journal_kind";--> statement-breakpoint
DROP TYPE "public"."ledger_journal_kind_v4";--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_payment_uq" ON "ledger_journals" USING btree ("payment_id") WHERE "ledger_journals"."kind" = 'payment';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_fee_uq" ON "ledger_journals" USING btree ("invoice_id") WHERE "ledger_journals"."kind" = 'fee';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_topup_uq" ON "ledger_journals" USING btree ("topup_id") WHERE "ledger_journals"."kind" = 'fee_topup';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_settlement_uq" ON "ledger_journals" USING btree ("invoice_id") WHERE "ledger_journals"."kind" = 'settlement';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_sweep_uq" ON "ledger_journals" USING btree ("sweep_id") WHERE "ledger_journals"."kind" = 'sweep';--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_payment_ref" CHECK (("ledger_journals"."kind" = 'payment') = ("ledger_journals"."payment_id" is not null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_topup_ref" CHECK (("ledger_journals"."kind" = 'fee_topup') = ("ledger_journals"."topup_id" is not null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_sweep_ref" CHECK (("ledger_journals"."kind" = 'sweep') = ("ledger_journals"."sweep_id" is not null));--> statement-breakpoint
CREATE TABLE "payout_addresses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"family" "chain_family" NOT NULL,
	"address" text NOT NULL,
	"label" text,
	"created_by" uuid NOT NULL,
	"activates_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_addresses_address" CHECK ("payout_addresses"."address" ~ '^0x[0-9a-fA-F]{40}$'),
	CONSTRAINT "payout_addresses_label" CHECK ("payout_addresses"."label" is null or char_length("payout_addresses"."label") <= 100)
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"chain_id" text NOT NULL,
	"token_id" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"payout_address_id" uuid NOT NULL,
	"to_address" text NOT NULL,
	"status" "withdrawal_status" NOT NULL,
	"approvals_required" integer NOT NULL,
	"approved_by" uuid[] DEFAULT '{}' NOT NULL,
	"requested_by" text NOT NULL,
	"decision_reason" text,
	"tx_hash" text,
	"block_number" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawals_amount" CHECK ("withdrawals"."amount" > 0),
	CONSTRAINT "withdrawals_approvals" CHECK ("withdrawals"."approvals_required" between 0 and 2 and cardinality("withdrawals"."approved_by") <= "withdrawals"."approvals_required")
);
--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD COLUMN "withdrawal_id" uuid;--> statement-breakpoint
ALTER TABLE "payout_addresses" ADD CONSTRAINT "payout_addresses_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_addresses" ADD CONSTRAINT "payout_addresses_created_by_merchant_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."merchant_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_payout_address_id_payout_addresses_id_fk" FOREIGN KEY ("payout_address_id") REFERENCES "public"."payout_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payout_addresses_merchant_idx" ON "payout_addresses" USING btree ("merchant_id","livemode","family","activates_at");--> statement-breakpoint
CREATE INDEX "withdrawals_merchant_idx" ON "withdrawals" USING btree ("merchant_id","livemode","created_at");--> statement-breakpoint
CREATE INDEX "withdrawals_due_idx" ON "withdrawals" USING btree ("next_attempt_at") WHERE "withdrawals"."status" in ('approved', 'sent');--> statement-breakpoint
CREATE INDEX "withdrawals_status_idx" ON "withdrawals" USING btree ("status");--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_withdrawal_id_withdrawals_id_fk" FOREIGN KEY ("withdrawal_id") REFERENCES "public"."withdrawals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_withdrawal_uq" ON "ledger_journals" USING btree ("withdrawal_id","kind") WHERE "ledger_journals"."withdrawal_id" is not null;--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_withdrawal_ref" CHECK (("ledger_journals"."kind" in ('withdrawal_hold', 'withdrawal', 'withdrawal_release')) = ("ledger_journals"."withdrawal_id" is not null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_invoice_ref" CHECK (("ledger_journals"."kind" in ('fee_topup', 'withdrawal_hold', 'withdrawal', 'withdrawal_release')) = ("ledger_journals"."invoice_id" is null));