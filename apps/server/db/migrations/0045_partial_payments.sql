-- MONEY-CRITICAL
-- Custodial partial payments (D-099): invoice_status gains the final status partially_paid. The type is recreated
-- instead of ALTER TYPE ... ADD VALUE: migrations run in one transaction, where a new enum value cannot be used (as in
-- 0039). invoice_transitions (0005) is not in the drizzle schema; the outbox trigger fires on UPDATE OF status, which
-- blocks a column type change, so it is dropped and recreated around it.
DROP TRIGGER invoices_outbox ON invoices;--> statement-breakpoint
ALTER TYPE "public"."invoice_status" RENAME TO "invoice_status_v2";--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('created', 'pending', 'detected', 'confirming', 'paid', 'underpaid', 'overpaid', 'settled', 'expired', 'cancelled', 'failed', 'late_payment', 'held', 'partially_paid');--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "status" SET DATA TYPE "public"."invoice_status" USING "status"::text::"public"."invoice_status";--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "status" SET DEFAULT 'created';--> statement-breakpoint
ALTER TABLE "invoice_status_history" ALTER COLUMN "from_status" SET DATA TYPE "public"."invoice_status" USING "from_status"::text::"public"."invoice_status";--> statement-breakpoint
ALTER TABLE "invoice_status_history" ALTER COLUMN "to_status" SET DATA TYPE "public"."invoice_status" USING "to_status"::text::"public"."invoice_status";--> statement-breakpoint
ALTER TABLE "invoice_transitions" ALTER COLUMN "from_status" SET DATA TYPE "public"."invoice_status" USING "from_status"::text::"public"."invoice_status";--> statement-breakpoint
ALTER TABLE "invoice_transitions" ALTER COLUMN "to_status" SET DATA TYPE "public"."invoice_status" USING "to_status"::text::"public"."invoice_status";--> statement-breakpoint
DROP TYPE "public"."invoice_status_v2";--> statement-breakpoint
CREATE TRIGGER invoices_outbox AFTER UPDATE OF status ON invoices FOR EACH ROW EXECUTE FUNCTION invoice_outbox_writer();
