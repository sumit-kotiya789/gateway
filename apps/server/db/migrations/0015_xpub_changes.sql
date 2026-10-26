CREATE TABLE "xpub_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"family" "chain_family" NOT NULL,
	"livemode" boolean NOT NULL,
	"xpub" text NOT NULL,
	"key_fingerprint" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"ownership_proved_at" timestamp with time zone NOT NULL,
	"activates_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "xpub_changes_status" CHECK ("xpub_changes"."status" in ('pending', 'applied', 'cancelled', 'failed')),
	CONSTRAINT "xpub_changes_resolved" CHECK (("xpub_changes"."status" = 'pending') = ("xpub_changes"."resolved_at" is null))
);
--> statement-breakpoint
ALTER TABLE "merchant_xpubs" ADD COLUMN "ownership_proved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "xpub_changes" ADD CONSTRAINT "xpub_changes_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xpub_changes" ADD CONSTRAINT "xpub_changes_requested_by_merchant_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."merchant_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "xpub_changes_one_pending_uq" ON "xpub_changes" USING btree ("merchant_id","family","livemode") WHERE "xpub_changes"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "xpub_changes_pending_fingerprint_uq" ON "xpub_changes" USING btree ("key_fingerprint") WHERE "xpub_changes"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "xpub_changes_due_idx" ON "xpub_changes" USING btree ("activates_at") WHERE "xpub_changes"."status" = 'pending';