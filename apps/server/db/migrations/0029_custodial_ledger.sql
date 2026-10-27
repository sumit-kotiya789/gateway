-- MONEY-CRITICAL
-- Custodial ledger accounts and the settlement journal (M7, D-087). Enum values are added by recreating the types
-- (same reason as 0017: one-transaction migrations cannot use values added by ADD VALUE). Constraints and partial
-- indexes that compare against the old types are dropped first and recreated on the new ones.
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_owner";--> statement-breakpoint
DROP INDEX "ledger_journals_payment_uq";--> statement-breakpoint
DROP INDEX "ledger_journals_fee_uq";--> statement-breakpoint
DROP INDEX "ledger_journals_topup_uq";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_payment_ref";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_invoice_ref";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_topup_ref";--> statement-breakpoint
ALTER TYPE "public"."ledger_account_kind" RENAME TO "ledger_account_kind_v2";--> statement-breakpoint
CREATE TYPE "public"."ledger_account_kind" AS ENUM('merchant_received', 'merchant_sales', 'merchant_fees_owed', 'platform_fee_revenue', 'platform_topups', 'custody_deposits', 'custody_hot', 'custody_cold', 'merchant_pending', 'merchant_available', 'merchant_withdrawing');--> statement-breakpoint
ALTER TABLE "ledger_accounts" ALTER COLUMN "kind" SET DATA TYPE "public"."ledger_account_kind" USING "kind"::text::"public"."ledger_account_kind";--> statement-breakpoint
DROP TYPE "public"."ledger_account_kind_v2";--> statement-breakpoint
ALTER TYPE "public"."ledger_journal_kind" RENAME TO "ledger_journal_kind_v2";--> statement-breakpoint
CREATE TYPE "public"."ledger_journal_kind" AS ENUM('payment', 'fee', 'fee_topup', 'settlement');--> statement-breakpoint
ALTER TABLE "ledger_journals" ALTER COLUMN "kind" SET DATA TYPE "public"."ledger_journal_kind" USING "kind"::text::"public"."ledger_journal_kind";--> statement-breakpoint
DROP TYPE "public"."ledger_journal_kind_v2";--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_payment_uq" ON "ledger_journals" USING btree ("payment_id") WHERE "ledger_journals"."kind" = 'payment';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_fee_uq" ON "ledger_journals" USING btree ("invoice_id") WHERE "ledger_journals"."kind" = 'fee';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_topup_uq" ON "ledger_journals" USING btree ("topup_id") WHERE "ledger_journals"."kind" = 'fee_topup';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_settlement_uq" ON "ledger_journals" USING btree ("invoice_id") WHERE "ledger_journals"."kind" = 'settlement';--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_payment_ref" CHECK (("ledger_journals"."kind" = 'payment') = ("ledger_journals"."payment_id" is not null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_invoice_ref" CHECK (("ledger_journals"."kind" = 'fee_topup') = ("ledger_journals"."invoice_id" is null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_topup_ref" CHECK (("ledger_journals"."kind" = 'fee_topup') = ("ledger_journals"."topup_id" is not null));--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner" CHECK (("ledger_accounts"."kind" in ('platform_fee_revenue', 'platform_topups', 'custody_deposits', 'custody_hot', 'custody_cold')) = ("ledger_accounts"."merchant_id" is null));
