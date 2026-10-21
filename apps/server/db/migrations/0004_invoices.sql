CREATE TYPE "public"."invoice_status" AS ENUM('created', 'pending', 'detected', 'confirming', 'paid', 'underpaid', 'overpaid', 'settled', 'expired', 'cancelled', 'failed', 'late_payment');--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_key_len" CHECK (char_length("idempotency_keys"."key") between 1 and 255)
);
--> statement-breakpoint
CREATE TABLE "invoice_status_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "invoice_status_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"invoice_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"from_status" "invoice_status",
	"to_status" "invoice_status" NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"external_order_id" text,
	"chain_id" text NOT NULL,
	"token_id" text NOT NULL,
	"amount_expected" numeric(78, 0) NOT NULL,
	"amount_received" numeric(78, 0) DEFAULT 0 NOT NULL,
	"deposit_address_id" uuid NOT NULL,
	"deposit_address" text NOT NULL,
	"custody_mode" "custody_mode" NOT NULL,
	"status" "invoice_status" DEFAULT 'created' NOT NULL,
	"underpay_tolerance_bps" integer NOT NULL,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"success_url" text,
	"cancel_url" text,
	"payment_link_id" uuid,
	"fee_amount" numeric(78, 0),
	"expires_at" timestamp with time zone NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_amounts" CHECK ("invoices"."amount_expected" > 0 and "invoices"."amount_received" >= 0 and ("invoices"."fee_amount" is null or "invoices"."fee_amount" >= 0)),
	CONSTRAINT "invoices_tolerance" CHECK ("invoices"."underpay_tolerance_bps" between 0 and 500),
	CONSTRAINT "invoices_metadata_size" CHECK (octet_length("invoices"."metadata"::text) <= 4096),
	CONSTRAINT "invoices_external_order_len" CHECK ("invoices"."external_order_id" is null or char_length("invoices"."external_order_id") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "payment_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"token_id" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_in_seconds" integer DEFAULT 1800 NOT NULL,
	"success_url" text,
	"cancel_url" text,
	"max_pending_invoices" integer DEFAULT 20 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_links_amount" CHECK ("payment_links"."amount" > 0),
	CONSTRAINT "payment_links_expiry" CHECK ("payment_links"."expires_in_seconds" between 300 and 86400),
	CONSTRAINT "payment_links_max_pending" CHECK ("payment_links"."max_pending_invoices" between 1 and 1000),
	CONSTRAINT "payment_links_metadata_size" CHECK (octet_length("payment_links"."metadata"::text) <= 4096)
);
--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "underpay_tolerance_bps" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_status_history" ADD CONSTRAINT "invoice_status_history_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_status_history" ADD CONSTRAINT "invoice_status_history_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_deposit_address_id_deposit_addresses_id_fk" FOREIGN KEY ("deposit_address_id") REFERENCES "public"."deposit_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_link_id_payment_links_id_fk" FOREIGN KEY ("payment_link_id") REFERENCES "public"."payment_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_uq" ON "idempotency_keys" USING btree ("merchant_id","livemode","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "invoice_status_history_invoice_idx" ON "invoice_status_history" USING btree ("invoice_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_deposit_address_uq" ON "invoices" USING btree ("deposit_address_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_external_order_uq" ON "invoices" USING btree ("merchant_id","livemode","external_order_id") WHERE "invoices"."external_order_id" is not null;--> statement-breakpoint
CREATE INDEX "invoices_merchant_list_idx" ON "invoices" USING btree ("merchant_id","livemode","id");--> statement-breakpoint
CREATE INDEX "invoices_status_expiry_idx" ON "invoices" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "invoices_payment_link_idx" ON "invoices" USING btree ("payment_link_id","status");--> statement-breakpoint
CREATE INDEX "payment_links_merchant_idx" ON "payment_links" USING btree ("merchant_id","livemode");--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_underpay_tolerance" CHECK ("merchants"."underpay_tolerance_bps" between 0 and 500);