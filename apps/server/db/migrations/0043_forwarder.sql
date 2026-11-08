-- MONEY-CRITICAL
-- Forwarder custody mode (D-097): forwarder deposit addresses and their committed parameters, flushes (forwards), the
-- platform fee wallet, the signer's forward intent and the forward_fee journal. Enum values are added by recreating
-- the types (same reason as 0017/0029/0037: one-transaction migrations cannot use values added by ADD VALUE); the
-- constraints and partial indexes that compare against the old types are dropped first and recreated on the new ones.
CREATE TYPE "public"."forward_status" AS ENUM('pending', 'sent', 'confirmed', 'failed');--> statement-breakpoint
ALTER TABLE "deposit_addresses" DROP CONSTRAINT "deposit_addresses_one_source";--> statement-breakpoint
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_owner";--> statement-breakpoint
ALTER TABLE "platform_wallets" DROP CONSTRAINT "platform_wallets_path";--> statement-breakpoint
DROP INDEX "ledger_journals_payment_uq";--> statement-breakpoint
DROP INDEX "ledger_journals_fee_uq";--> statement-breakpoint
DROP INDEX "ledger_journals_topup_uq";--> statement-breakpoint
DROP INDEX "ledger_journals_settlement_uq";--> statement-breakpoint
DROP INDEX "ledger_journals_sweep_uq";--> statement-breakpoint
DROP INDEX "ledger_journals_treasury_uq";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_payment_ref";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_invoice_ref";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_topup_ref";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_sweep_ref";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_withdrawal_ref";--> statement-breakpoint
ALTER TABLE "ledger_journals" DROP CONSTRAINT "ledger_journals_treasury_ref";--> statement-breakpoint
ALTER TYPE "public"."address_source" RENAME TO "address_source_v1";--> statement-breakpoint
CREATE TYPE "public"."address_source" AS ENUM('platform', 'merchant_xpub', 'forwarder');--> statement-breakpoint
ALTER TABLE "deposit_addresses" ALTER COLUMN "source" SET DATA TYPE "public"."address_source" USING "source"::text::"public"."address_source";--> statement-breakpoint
DROP TYPE "public"."address_source_v1";--> statement-breakpoint
ALTER TYPE "public"."ledger_account_kind" RENAME TO "ledger_account_kind_v3";--> statement-breakpoint
CREATE TYPE "public"."ledger_account_kind" AS ENUM('merchant_received', 'merchant_sales', 'merchant_fees_owed', 'platform_fee_revenue', 'platform_topups', 'custody_deposits', 'custody_hot', 'custody_cold', 'merchant_pending', 'merchant_available', 'merchant_withdrawing', 'platform_fee_wallet');--> statement-breakpoint
ALTER TABLE "ledger_accounts" ALTER COLUMN "kind" SET DATA TYPE "public"."ledger_account_kind" USING "kind"::text::"public"."ledger_account_kind";--> statement-breakpoint
DROP TYPE "public"."ledger_account_kind_v3";--> statement-breakpoint
ALTER TYPE "public"."ledger_journal_kind" RENAME TO "ledger_journal_kind_v6";--> statement-breakpoint
CREATE TYPE "public"."ledger_journal_kind" AS ENUM('payment', 'fee', 'fee_topup', 'settlement', 'sweep', 'withdrawal_hold', 'withdrawal', 'withdrawal_release', 'treasury', 'forward_fee');--> statement-breakpoint
ALTER TABLE "ledger_journals" ALTER COLUMN "kind" SET DATA TYPE "public"."ledger_journal_kind" USING "kind"::text::"public"."ledger_journal_kind";--> statement-breakpoint
DROP TYPE "public"."ledger_journal_kind_v6";--> statement-breakpoint
ALTER TYPE "public"."platform_wallet_kind" RENAME TO "platform_wallet_kind_v1";--> statement-breakpoint
CREATE TYPE "public"."platform_wallet_kind" AS ENUM('hot', 'gas', 'cold', 'fee');--> statement-breakpoint
ALTER TABLE "platform_wallets" ALTER COLUMN "kind" SET DATA TYPE "public"."platform_wallet_kind" USING "kind"::text::"public"."platform_wallet_kind";--> statement-breakpoint
DROP TYPE "public"."platform_wallet_kind_v1";--> statement-breakpoint
ALTER TYPE "public"."signer_intent_kind" RENAME TO "signer_intent_kind_v1";--> statement-breakpoint
CREATE TYPE "public"."signer_intent_kind" AS ENUM('gas_topup', 'sweep', 'withdrawal', 'treasury', 'forward');--> statement-breakpoint
ALTER TABLE "signer_signatures" ALTER COLUMN "intent_kind" SET DATA TYPE "public"."signer_intent_kind" USING "intent_kind"::text::"public"."signer_intent_kind";--> statement-breakpoint
DROP TYPE "public"."signer_intent_kind_v1";--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_payment_uq" ON "ledger_journals" USING btree ("payment_id") WHERE "ledger_journals"."kind" = 'payment';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_fee_uq" ON "ledger_journals" USING btree ("invoice_id") WHERE "ledger_journals"."kind" = 'fee';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_topup_uq" ON "ledger_journals" USING btree ("topup_id") WHERE "ledger_journals"."kind" = 'fee_topup';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_settlement_uq" ON "ledger_journals" USING btree ("invoice_id") WHERE "ledger_journals"."kind" = 'settlement';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_sweep_uq" ON "ledger_journals" USING btree ("sweep_id") WHERE "ledger_journals"."kind" = 'sweep';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_treasury_uq" ON "ledger_journals" USING btree ("treasury_id") WHERE "ledger_journals"."kind" = 'treasury';--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_payment_ref" CHECK (("ledger_journals"."kind" = 'payment') = ("ledger_journals"."payment_id" is not null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_invoice_ref" CHECK (("ledger_journals"."kind" in ('fee_topup', 'withdrawal_hold', 'withdrawal', 'withdrawal_release', 'treasury')) = ("ledger_journals"."invoice_id" is null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_topup_ref" CHECK (("ledger_journals"."kind" = 'fee_topup') = ("ledger_journals"."topup_id" is not null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_sweep_ref" CHECK (("ledger_journals"."kind" = 'sweep') = ("ledger_journals"."sweep_id" is not null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_withdrawal_ref" CHECK (("ledger_journals"."kind" in ('withdrawal_hold', 'withdrawal', 'withdrawal_release')) = ("ledger_journals"."withdrawal_id" is not null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_treasury_ref" CHECK (("ledger_journals"."kind" = 'treasury') = ("ledger_journals"."treasury_id" is not null) and ("ledger_journals"."kind" = 'treasury') = ("ledger_journals"."merchant_id" is null));--> statement-breakpoint
CREATE TABLE "forwarder_params" (
	"deposit_address_id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"chain_id" text NOT NULL,
	"token_id" text NOT NULL,
	"factory" text NOT NULL,
	"salt" text NOT NULL,
	"payout_address_id" uuid NOT NULL,
	"merchant_address" text NOT NULL,
	"fee_wallet_id" uuid NOT NULL,
	"fee_recipient" text NOT NULL,
	"token_contract" text NOT NULL,
	"fee_bps" integer NOT NULL,
	"fee_cap" numeric(78, 0) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forwarder_params_addresses" CHECK ("forwarder_params"."factory" ~ '^0x[0-9a-fA-F]{40}$' and "forwarder_params"."merchant_address" ~ '^0x[0-9a-fA-F]{40}$'
       and "forwarder_params"."fee_recipient" ~ '^0x[0-9a-fA-F]{40}$' and "forwarder_params"."token_contract" ~ '^0x[0-9a-fA-F]{40}$'),
	CONSTRAINT "forwarder_params_salt" CHECK ("forwarder_params"."salt" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "forwarder_params_fee" CHECK ("forwarder_params"."fee_bps" between 0 and 10000 and "forwarder_params"."fee_cap" >= 0)
);--> statement-breakpoint
CREATE TABLE "forwards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"chain_id" text NOT NULL,
	"token_id" text NOT NULL,
	"deposit_address_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"forwarder_address" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"to_merchant" numeric(78, 0),
	"fee" numeric(78, 0),
	"status" "forward_status" DEFAULT 'pending' NOT NULL,
	"tx_hash" text,
	"block_number" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forwards_amount" CHECK ("forwards"."amount" > 0),
	CONSTRAINT "forwards_result" CHECK (("forwards"."status" = 'confirmed') = ("forwards"."to_merchant" is not null and "forwards"."fee" is not null))
);--> statement-breakpoint
ALTER TABLE "chains" ADD COLUMN "forwarder_factory" text;--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD COLUMN "forward_id" uuid;--> statement-breakpoint
ALTER TABLE "forwarder_params" ADD CONSTRAINT "forwarder_params_deposit_address_id_deposit_addresses_id_fk" FOREIGN KEY ("deposit_address_id") REFERENCES "public"."deposit_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forwarder_params" ADD CONSTRAINT "forwarder_params_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forwarder_params" ADD CONSTRAINT "forwarder_params_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forwarder_params" ADD CONSTRAINT "forwarder_params_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forwarder_params" ADD CONSTRAINT "forwarder_params_payout_address_id_payout_addresses_id_fk" FOREIGN KEY ("payout_address_id") REFERENCES "public"."payout_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forwarder_params" ADD CONSTRAINT "forwarder_params_fee_wallet_id_platform_wallets_id_fk" FOREIGN KEY ("fee_wallet_id") REFERENCES "public"."platform_wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forwards" ADD CONSTRAINT "forwards_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forwards" ADD CONSTRAINT "forwards_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forwards" ADD CONSTRAINT "forwards_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forwards" ADD CONSTRAINT "forwards_deposit_address_id_forwarder_params_deposit_address_id_fk" FOREIGN KEY ("deposit_address_id") REFERENCES "public"."forwarder_params"("deposit_address_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forwards" ADD CONSTRAINT "forwards_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forwarder_params_merchant_idx" ON "forwarder_params" USING btree ("merchant_id","livemode");--> statement-breakpoint
CREATE UNIQUE INDEX "forwards_open_uq" ON "forwards" USING btree ("deposit_address_id") WHERE "forwards"."status" in ('pending', 'sent');--> statement-breakpoint
CREATE INDEX "forwards_due_idx" ON "forwards" USING btree ("next_attempt_at") WHERE "forwards"."status" in ('pending', 'sent');--> statement-breakpoint
CREATE INDEX "forwards_invoice_idx" ON "forwards" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forwards_tx_uq" ON "forwards" USING btree ("chain_id",lower("tx_hash")) WHERE "forwards"."tx_hash" is not null;--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_forward_id_forwards_id_fk" FOREIGN KEY ("forward_id") REFERENCES "public"."forwards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_forward_uq" ON "ledger_journals" USING btree ("forward_id") WHERE "ledger_journals"."kind" = 'forward_fee';--> statement-breakpoint
ALTER TABLE "chains" ADD CONSTRAINT "chains_forwarder_factory" CHECK ("chains"."forwarder_factory" is null or "chains"."forwarder_factory" ~ '^0x[0-9a-fA-F]{40}$');--> statement-breakpoint
ALTER TABLE "deposit_addresses" ADD CONSTRAINT "deposit_addresses_one_source" CHECK (("deposit_addresses"."source" = 'platform' and "deposit_addresses"."wallet_account_id" is not null and "deposit_addresses"."merchant_xpub_id" is null)
       or ("deposit_addresses"."source" = 'merchant_xpub' and "deposit_addresses"."merchant_xpub_id" is not null and "deposit_addresses"."wallet_account_id" is null)
       or ("deposit_addresses"."source" = 'forwarder' and "deposit_addresses"."wallet_account_id" is null and "deposit_addresses"."merchant_xpub_id" is null));--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner" CHECK (("ledger_accounts"."kind" in ('platform_fee_revenue', 'platform_topups', 'custody_deposits', 'custody_hot', 'custody_cold', 'platform_fee_wallet')) = ("ledger_accounts"."merchant_id" is null));--> statement-breakpoint
ALTER TABLE "ledger_journals" ADD CONSTRAINT "ledger_journals_forward_ref" CHECK (("ledger_journals"."kind" = 'forward_fee') = ("ledger_journals"."forward_id" is not null));--> statement-breakpoint
ALTER TABLE "platform_wallets" ADD CONSTRAINT "platform_wallets_path" CHECK (("platform_wallets"."kind" in ('cold', 'fee')) = ("platform_wallets"."derivation_path" is null));
