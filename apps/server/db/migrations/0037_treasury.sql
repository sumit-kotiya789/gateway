-- MONEY-CRITICAL
-- Treasury transfers (M7e, D-091) and platform-only treasury journals. Journal kind added by recreating the type (0017).
CREATE TYPE "public"."treasury_direction" AS ENUM('to_cold', 'to_hot');--> statement-breakpoint
CREATE TYPE "public"."treasury_status" AS ENUM('pending_approval', 'approved', 'sent', 'confirmed', 'failed', 'rejected');--> statement-breakpoint
DROP INDEX "ledger_journals_payment_uq";--> statement-breakpoint
DROP INDEX "ledger_journals_fee_uq";--> statement-breakpoint
DROP INDEX "ledger_journals_topup_uq";--> statement-breakpoint
DROP INDEX "ledger_journals_settlement_uq";--> statement-breakpoint
DROP INDEX "ledger_journals_sweep_uq";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_payment_ref";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_invoice_ref";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_topup_ref";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_sweep_ref";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_withdrawal_ref";--> statement-breakpoint
ALTER TYPE "public"."ledger_journal_kind" RENAME TO "ledger_journal_kind_v5";--> statement-breakpoint
CREATE TYPE "public"."ledger_journal_kind" AS ENUM('payment', 'fee', 'fee_topup', 'settlement', 'sweep', 'withdrawal_hold', 'withdrawal', 'withdrawal_release', 'treasury');--> statement-breakpoint
ALTER TABLE "ledger_journals" ALTER COLUMN "kind" SET DATA TYPE "public"."ledger_journal_kind" USING "kind"::text::"public"."ledger_journal_kind";--> statement-breakpoint
DROP TYPE "public"."ledger_journal_kind_v5";--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_payment_uq" ON "ledger_journals" USING btree ("payment_id") WHERE "ledger_journals"."kind" = 'payment';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_fee_uq" ON "ledger_journals" USING btree ("invoice_id") WHERE "ledger_journals"."kind" = 'fee';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_topup_uq" ON "ledger_journals" USING btree ("topup_id") WHERE "ledger_journals"."kind" = 'fee_topup';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_settlement_uq" ON "ledger_journals" USING btree ("invoice_id") WHERE "ledger_journals"."kind" = 'settlement';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_sweep_uq" ON "ledger_journals" USING btree ("sweep_id") WHERE "ledger_journals"."kind" = 'sweep';--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_payment_ref" CHECK (("ledger_journals"."kind" = 'payment') = ("ledger_journals"."payment_id" is not null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_topup_ref" CHECK (("ledger_journals"."kind" = 'fee_topup') = ("ledger_journals"."topup_id" is not null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_sweep_ref" CHECK (("ledger_journals"."kind" = 'sweep') = ("ledger_journals"."sweep_id" is not null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_withdrawal_ref" CHECK (("ledger_journals"."kind" in ('withdrawal_hold', 'withdrawal', 'withdrawal_release')) = ("ledger_journals"."withdrawal_id" is not null));--> statement-breakpoint
CREATE TABLE "treasury_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"livemode" boolean NOT NULL,
	"chain_id" text NOT NULL,
	"token_id" text NOT NULL,
	"direction" "treasury_direction" NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"cold_address" text NOT NULL,
	"hot_address" text NOT NULL,
	"status" "treasury_status" NOT NULL,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid,
	"reason" text NOT NULL,
	"tx_hash" text,
	"block_number" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_transfers_amount" CHECK ("treasury_transfers"."amount" > 0),
	CONSTRAINT "treasury_transfers_two_people" CHECK ("treasury_transfers"."approved_by" is null or "treasury_transfers"."approved_by" <> "treasury_transfers"."requested_by"),
	CONSTRAINT "treasury_transfers_to_hot_tx" CHECK ("treasury_transfers"."direction" <> 'to_hot' or "treasury_transfers"."tx_hash" is not null)
);
--> statement-breakpoint
ALTER TABLE "ledger_journals" ALTER COLUMN "merchant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD COLUMN "treasury_id" uuid;--> statement-breakpoint
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_requested_by_admin_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_approved_by_admin_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "treasury_transfers_due_idx" ON "treasury_transfers" USING btree ("next_attempt_at") WHERE "treasury_transfers"."status" in ('approved', 'sent');--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_transfers_tx_uq" ON "treasury_transfers" USING btree ("chain_id",lower("tx_hash")) WHERE "treasury_transfers"."tx_hash" is not null;--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_treasury_id_treasury_transfers_id_fk" FOREIGN KEY ("treasury_id") REFERENCES "public"."treasury_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_treasury_uq" ON "ledger_journals" USING btree ("treasury_id") WHERE "ledger_journals"."kind" = 'treasury';--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_treasury_ref" CHECK (("ledger_journals"."kind" = 'treasury') = ("ledger_journals"."treasury_id" is not null) and ("ledger_journals"."kind" = 'treasury') = ("ledger_journals"."merchant_id" is null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_invoice_ref" CHECK (("ledger_journals"."kind" in ('fee_topup', 'withdrawal_hold', 'withdrawal', 'withdrawal_release', 'treasury')) = ("ledger_journals"."invoice_id" is null));