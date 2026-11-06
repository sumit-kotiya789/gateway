CREATE TABLE "sub_merchants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"name" text NOT NULL,
	"reference" text,
	"active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sub_merchants_name_len" CHECK (char_length("sub_merchants"."name") between 1 and 200),
	CONSTRAINT "sub_merchants_reference_len" CHECK ("sub_merchants"."reference" is null or char_length("sub_merchants"."reference") between 1 and 200),
	CONSTRAINT "sub_merchants_metadata_size" CHECK (octet_length("sub_merchants"."metadata"::text) <= 4096)
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "sub_merchant_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "sub_merchant_id" uuid;--> statement-breakpoint
ALTER TABLE "sub_merchants" ADD CONSTRAINT "sub_merchants_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sub_merchants_scope_uq" ON "sub_merchants" USING btree ("merchant_id","livemode","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sub_merchants_reference_uq" ON "sub_merchants" USING btree ("merchant_id","livemode","reference") WHERE "sub_merchants"."reference" is not null;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_sub_merchant_fk" FOREIGN KEY ("merchant_id","livemode","sub_merchant_id") REFERENCES "public"."sub_merchants"("merchant_id","livemode","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_sub_merchant_fk" FOREIGN KEY ("merchant_id","livemode","sub_merchant_id") REFERENCES "public"."sub_merchants"("merchant_id","livemode","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_sub_merchant_idx" ON "invoices" USING btree ("sub_merchant_id","id") WHERE "invoices"."sub_merchant_id" is not null;