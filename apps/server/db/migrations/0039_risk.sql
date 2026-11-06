-- invoice_status gains 'held' (M9, D-094). The type is recreated instead of ALTER TYPE ... ADD VALUE: migrations run in
-- one transaction and Postgres forbids using an enum value added in the same transaction (as D-075, D-076). The outbox
-- trigger names the column (UPDATE OF status), which blocks a type change, so it is dropped and recreated around it.
DROP TRIGGER invoices_outbox ON invoices;--> statement-breakpoint
ALTER TYPE "public"."invoice_status" RENAME TO "invoice_status_v1";--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('created', 'pending', 'detected', 'confirming', 'paid', 'underpaid', 'overpaid', 'settled', 'expired', 'cancelled', 'failed', 'late_payment', 'held');--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "status" SET DATA TYPE "public"."invoice_status" USING "status"::text::"public"."invoice_status";--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "status" SET DEFAULT 'created';--> statement-breakpoint
ALTER TABLE "invoice_status_history" ALTER COLUMN "from_status" SET DATA TYPE "public"."invoice_status" USING "from_status"::text::"public"."invoice_status";--> statement-breakpoint
ALTER TABLE "invoice_status_history" ALTER COLUMN "to_status" SET DATA TYPE "public"."invoice_status" USING "to_status"::text::"public"."invoice_status";--> statement-breakpoint
ALTER TABLE "invoice_transitions" ALTER COLUMN "from_status" SET DATA TYPE "public"."invoice_status" USING "from_status"::text::"public"."invoice_status";--> statement-breakpoint
ALTER TABLE "invoice_transitions" ALTER COLUMN "to_status" SET DATA TYPE "public"."invoice_status" USING "to_status"::text::"public"."invoice_status";--> statement-breakpoint
DROP TYPE "public"."invoice_status_v1";--> statement-breakpoint
CREATE TRIGGER invoices_outbox AFTER UPDATE OF status ON invoices FOR EACH ROW EXECUTE FUNCTION invoice_outbox_writer();--> statement-breakpoint
CREATE TABLE "merchant_risk_limits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"token_id" text NOT NULL,
	"per_invoice" numeric(78, 0),
	"per_day" numeric(78, 0),
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_risk_limits_positive" CHECK (coalesce("merchant_risk_limits"."per_invoice", 1) > 0 and coalesce("merchant_risk_limits"."per_day", 1) > 0)
);
--> statement-breakpoint
CREATE TABLE "risk_blocked_addresses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"family" "chain_family" NOT NULL,
	"address" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_blocked_addresses_lower" CHECK ("risk_blocked_addresses"."address" = lower("risk_blocked_addresses"."address")),
	CONSTRAINT "risk_blocked_addresses_reason_len" CHECK (char_length("risk_blocked_addresses"."reason") between 3 and 500)
);
--> statement-breakpoint
ALTER TABLE "merchant_risk_limits" ADD CONSTRAINT "merchant_risk_limits_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_risk_limits" ADD CONSTRAINT "merchant_risk_limits_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_risk_limits" ADD CONSTRAINT "merchant_risk_limits_updated_by_admin_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_blocked_addresses" ADD CONSTRAINT "risk_blocked_addresses_created_by_admin_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_risk_limits_uq" ON "merchant_risk_limits" USING btree ("merchant_id","token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_blocked_addresses_uq" ON "risk_blocked_addresses" USING btree ("family","address");