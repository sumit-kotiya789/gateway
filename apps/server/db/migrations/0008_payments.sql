CREATE TYPE "public"."payment_status" AS ENUM('detected', 'confirmed', 'orphaned');--> statement-breakpoint
CREATE TABLE "chain_cursors" (
	"chain_id" text PRIMARY KEY NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"leader_epoch" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"invoice_id" uuid NOT NULL,
	"chain_id" text NOT NULL,
	"token_id" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"required_confirmations" integer NOT NULL,
	"status" "payment_status" DEFAULT 'detected' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"orphaned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount" CHECK ("payments"."amount" > 0),
	CONSTRAINT "payments_numbers" CHECK ("payments"."log_index" >= 0 and "payments"."block_number" >= 0 and "payments"."required_confirmations" >= 1)
);
--> statement-breakpoint
ALTER TABLE "chain_cursors" ADD CONSTRAINT "chain_cursors_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_chain_tx_log_uq" ON "payments" USING btree ("chain_id","tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "payments_invoice_idx" ON "payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payments_chain_status_idx" ON "payments" USING btree ("chain_id","status");