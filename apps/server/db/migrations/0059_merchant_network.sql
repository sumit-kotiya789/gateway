-- Per-merchant network (D-113): the one mainnet a merchant receives live payments on; null = every enabled chain.

ALTER TABLE "merchants" ADD COLUMN "allowed_chain_id" text;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_allowed_chain_id_chains_id_fk" FOREIGN KEY ("allowed_chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;