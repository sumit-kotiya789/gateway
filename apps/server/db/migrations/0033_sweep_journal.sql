-- MONEY-CRITICAL
-- Sweep journals (M7c, D-089): Dr custody_hot / Cr custody_deposits when a sweep confirms. Enum recreated (see 0017).
DROP INDEX "ledger_journals_payment_uq";--> statement-breakpoint
DROP INDEX "ledger_journals_fee_uq";--> statement-breakpoint
DROP INDEX "ledger_journals_topup_uq";--> statement-breakpoint
DROP INDEX "ledger_journals_settlement_uq";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_payment_ref";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_invoice_ref";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_topup_ref";--> statement-breakpoint
ALTER TYPE "public"."ledger_journal_kind" RENAME TO "ledger_journal_kind_v3";--> statement-breakpoint
CREATE TYPE "public"."ledger_journal_kind" AS ENUM('payment', 'fee', 'fee_topup', 'settlement', 'sweep');--> statement-breakpoint
ALTER TABLE "ledger_journals" ALTER COLUMN "kind" SET DATA TYPE "public"."ledger_journal_kind" USING "kind"::text::"public"."ledger_journal_kind";--> statement-breakpoint
DROP TYPE "public"."ledger_journal_kind_v3";--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD COLUMN "sweep_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_sweep_id_sweeps_id_fk" FOREIGN KEY ("sweep_id") REFERENCES "public"."sweeps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_payment_uq" ON "ledger_journals" USING btree ("payment_id") WHERE "ledger_journals"."kind" = 'payment';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_fee_uq" ON "ledger_journals" USING btree ("invoice_id") WHERE "ledger_journals"."kind" = 'fee';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_topup_uq" ON "ledger_journals" USING btree ("topup_id") WHERE "ledger_journals"."kind" = 'fee_topup';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_settlement_uq" ON "ledger_journals" USING btree ("invoice_id") WHERE "ledger_journals"."kind" = 'settlement';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_sweep_uq" ON "ledger_journals" USING btree ("sweep_id") WHERE "ledger_journals"."kind" = 'sweep';--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_payment_ref" CHECK (("ledger_journals"."kind" = 'payment') = ("ledger_journals"."payment_id" is not null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_invoice_ref" CHECK (("ledger_journals"."kind" = 'fee_topup') = ("ledger_journals"."invoice_id" is null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_topup_ref" CHECK (("ledger_journals"."kind" = 'fee_topup') = ("ledger_journals"."topup_id" is not null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_sweep_ref" CHECK (("ledger_journals"."kind" = 'sweep') = ("ledger_journals"."sweep_id" is not null));
