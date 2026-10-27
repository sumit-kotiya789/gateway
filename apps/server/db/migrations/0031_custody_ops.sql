CREATE TYPE "public"."platform_wallet_kind" AS ENUM('hot', 'gas', 'cold');--> statement-breakpoint
CREATE TYPE "public"."signer_intent_kind" AS ENUM('gas_topup', 'sweep', 'withdrawal', 'treasury');--> statement-breakpoint
CREATE TYPE "public"."sweep_status" AS ENUM('pending', 'gas_sent', 'sweep_sent', 'confirmed', 'failed');--> statement-breakpoint
CREATE TABLE "platform_wallets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"family" "chain_family" NOT NULL,
	"livemode" boolean NOT NULL,
	"kind" "platform_wallet_kind" NOT NULL,
	"address" text NOT NULL,
	"derivation_path" text,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_wallets_path" CHECK (("platform_wallets"."kind" = 'cold') = ("platform_wallets"."derivation_path" is null)),
	CONSTRAINT "platform_wallets_address" CHECK ("platform_wallets"."address" ~ '^0x[0-9a-fA-F]{40}$')
);
--> statement-breakpoint
CREATE TABLE "signer_controls" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signer_controls_single" CHECK ("signer_controls"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "signer_signatures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"intent_kind" "signer_intent_kind" NOT NULL,
	"intent_id" uuid NOT NULL,
	"chain_id" text NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"token_id" text,
	"amount" numeric(78, 0) NOT NULL,
	"nonce" bigint NOT NULL,
	"tx_hash" text NOT NULL,
	"raw_tx" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sweeps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"chain_id" text NOT NULL,
	"token_id" text NOT NULL,
	"deposit_address_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"status" "sweep_status" DEFAULT 'pending' NOT NULL,
	"gas_tx_hash" text,
	"tx_hash" text,
	"block_number" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sweeps_amount" CHECK ("sweeps"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "signer_signatures" ADD CONSTRAINT "signer_signatures_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signer_signatures" ADD CONSTRAINT "signer_signatures_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sweeps" ADD CONSTRAINT "sweeps_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sweeps" ADD CONSTRAINT "sweeps_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sweeps" ADD CONSTRAINT "sweeps_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sweeps" ADD CONSTRAINT "sweeps_deposit_address_id_deposit_addresses_id_fk" FOREIGN KEY ("deposit_address_id") REFERENCES "public"."deposit_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sweeps" ADD CONSTRAINT "sweeps_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_wallets_active_uq" ON "platform_wallets" USING btree ("family","livemode","kind") WHERE "platform_wallets"."retired_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "signer_signatures_intent_uq" ON "signer_signatures" USING btree ("intent_kind","intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signer_signatures_nonce_uq" ON "signer_signatures" USING btree ("chain_id",lower("from_address"),"nonce");--> statement-breakpoint
CREATE INDEX "signer_signatures_day_idx" ON "signer_signatures" USING btree ("token_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sweeps_open_uq" ON "sweeps" USING btree ("deposit_address_id") WHERE "sweeps"."status" <> 'failed';--> statement-breakpoint
CREATE INDEX "sweeps_due_idx" ON "sweeps" USING btree ("next_attempt_at") WHERE "sweeps"."status" in ('pending', 'gas_sent', 'sweep_sent');