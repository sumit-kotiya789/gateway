-- MONEY-CRITICAL
-- Custodial partial payments (D-092): new terminal invoice status partially_paid, added by recreating the type (0017).
-- invoice_transitions (0005) is not in the drizzle schema; the outbox trigger fires on UPDATE OF status, which blocks a
-- column type change, so it is dropped and recreated around it.
DROP TRIGGER invoices_outbox ON invoices;--> statement-breakpoint
ALTER TYPE "public"."invoice_status" RENAME TO "invoice_status_v1";--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('created', 'pending', 'detected', 'confirming', 'paid', 'underpaid', 'overpaid', 'settled', 'expired', 'cancelled', 'failed', 'late_payment', 'partially_paid');--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "status" SET DATA TYPE "public"."invoice_status" USING "status"::text::"public"."invoice_status";--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "status" SET DEFAULT 'created';--> statement-breakpoint
ALTER TABLE "invoice_status_history" ALTER COLUMN "from_status" SET DATA TYPE "public"."invoice_status" USING "from_status"::text::"public"."invoice_status";--> statement-breakpoint
ALTER TABLE "invoice_status_history" ALTER COLUMN "to_status" SET DATA TYPE "public"."invoice_status" USING "to_status"::text::"public"."invoice_status";--> statement-breakpoint
ALTER TABLE "invoice_transitions" ALTER COLUMN "from_status" SET DATA TYPE "public"."invoice_status" USING "from_status"::text::"public"."invoice_status";--> statement-breakpoint
ALTER TABLE "invoice_transitions" ALTER COLUMN "to_status" SET DATA TYPE "public"."invoice_status" USING "to_status"::text::"public"."invoice_status";--> statement-breakpoint
DROP TYPE "public"."invoice_status_v1";--> statement-breakpoint
CREATE TRIGGER invoices_outbox AFTER UPDATE OF status ON invoices FOR EACH ROW EXECUTE FUNCTION invoice_outbox_writer();
