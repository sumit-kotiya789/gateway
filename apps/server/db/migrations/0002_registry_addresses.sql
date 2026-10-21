CREATE TYPE "public"."address_source" AS ENUM('platform', 'merchant_xpub');--> statement-breakpoint
CREATE TYPE "public"."chain_family" AS ENUM('evm', 'tron', 'solana');--> statement-breakpoint
CREATE TYPE "public"."chain_finality" AS ENUM('tag', 'confirmations');--> statement-breakpoint
CREATE TYPE "public"."xpub_status" AS ENUM('active', 'retired');--> statement-breakpoint
CREATE TABLE "chains" (
	"id" text PRIMARY KEY NOT NULL,
	"family" "chain_family" NOT NULL,
	"name" text NOT NULL,
	"evm_chain_id" integer,
	"rpc_urls" text[] NOT NULL,
	"explorer_url" text,
	"native_symbol" text NOT NULL,
	"native_decimals" integer NOT NULL,
	"block_time_ms" integer NOT NULL,
	"default_confirmations" integer NOT NULL,
	"reorg_depth" integer NOT NULL,
	"finality" "chain_finality" NOT NULL,
	"testnet" boolean NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chains_id_format" CHECK ("chains"."id" ~ '^[a-z0-9-]{2,32}$'),
	CONSTRAINT "chains_evm_chain_id" CHECK ("chains"."family" <> 'evm' or "chains"."evm_chain_id" > 0),
	CONSTRAINT "chains_numbers" CHECK ("chains"."native_decimals" between 0 and 77 and "chains"."block_time_ms" > 0 and "chains"."default_confirmations" >= 1 and "chains"."reorg_depth" >= 1)
);
--> statement-breakpoint
CREATE TABLE "deposit_addresses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"family" "chain_family" NOT NULL,
	"chain_id" text NOT NULL,
	"source" "address_source" NOT NULL,
	"wallet_account_id" uuid,
	"merchant_xpub_id" uuid,
	"derivation_index" integer NOT NULL,
	"derivation_path" text NOT NULL,
	"address" text NOT NULL,
	"watch_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposit_addresses_one_source" CHECK (("deposit_addresses"."source" = 'platform' and "deposit_addresses"."wallet_account_id" is not null and "deposit_addresses"."merchant_xpub_id" is null)
       or ("deposit_addresses"."source" = 'merchant_xpub' and "deposit_addresses"."merchant_xpub_id" is not null and "deposit_addresses"."wallet_account_id" is null)),
	CONSTRAINT "deposit_addresses_index" CHECK ("deposit_addresses"."derivation_index" between 0 and 2147483647)
);
--> statement-breakpoint
CREATE TABLE "merchant_xpubs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"family" "chain_family" NOT NULL,
	"livemode" boolean NOT NULL,
	"xpub" text NOT NULL,
	"key_fingerprint" text NOT NULL,
	"next_index" bigint DEFAULT 0 NOT NULL,
	"status" "xpub_status" DEFAULT 'active' NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_xpubs_fk_target" UNIQUE("id","merchant_id","livemode","family"),
	CONSTRAINT "merchant_xpubs_next_index" CHECK ("merchant_xpubs"."next_index" between 0 and 2147483648)
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" text NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"contract_address" text NOT NULL,
	"decimals" integer NOT NULL,
	"min_confirmations" integer NOT NULL,
	"confirmation_tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"min_amount" numeric(78, 0) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tokens_id_format" CHECK ("tokens"."id" ~ '^[a-z0-9-]{2,32}:[a-z0-9]{2,16}$'),
	CONSTRAINT "tokens_numbers" CHECK ("tokens"."decimals" between 0 and 77 and "tokens"."min_confirmations" >= 1 and "tokens"."min_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "wallet_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"family" "chain_family" NOT NULL,
	"livemode" boolean NOT NULL,
	"base_path" text NOT NULL,
	"xpub" text NOT NULL,
	"key_fingerprint" text NOT NULL,
	"next_index" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_accounts_fk_target" UNIQUE("id","livemode","family"),
	CONSTRAINT "wallet_accounts_next_index" CHECK ("wallet_accounts"."next_index" between 0 and 2147483648)
);
--> statement-breakpoint
ALTER TABLE "deposit_addresses" ADD CONSTRAINT "deposit_addresses_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_addresses" ADD CONSTRAINT "deposit_addresses_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_addresses" ADD CONSTRAINT "deposit_addresses_merchant_xpub_fk" FOREIGN KEY ("merchant_xpub_id","merchant_id","livemode","family") REFERENCES "public"."merchant_xpubs"("id","merchant_id","livemode","family") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_addresses" ADD CONSTRAINT "deposit_addresses_wallet_account_fk" FOREIGN KEY ("wallet_account_id","livemode","family") REFERENCES "public"."wallet_accounts"("id","livemode","family") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_xpubs" ADD CONSTRAINT "merchant_xpubs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_addresses_family_address_uq" ON "deposit_addresses" USING btree ("family",lower("address"));--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_addresses_wallet_index_uq" ON "deposit_addresses" USING btree ("wallet_account_id","derivation_index");--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_addresses_xpub_index_uq" ON "deposit_addresses" USING btree ("merchant_xpub_id","derivation_index");--> statement-breakpoint
CREATE INDEX "deposit_addresses_merchant_idx" ON "deposit_addresses" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_xpubs_fingerprint_uq" ON "merchant_xpubs" USING btree ("key_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_xpubs_one_active_uq" ON "merchant_xpubs" USING btree ("merchant_id","family","livemode") WHERE "merchant_xpubs"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "tokens_chain_contract_uq" ON "tokens" USING btree ("chain_id",lower("contract_address"));--> statement-breakpoint
CREATE UNIQUE INDEX "tokens_chain_symbol_uq" ON "tokens" USING btree ("chain_id","symbol");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_accounts_family_mode_uq" ON "wallet_accounts" USING btree ("family","livemode");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_accounts_fingerprint_uq" ON "wallet_accounts" USING btree ("key_fingerprint");