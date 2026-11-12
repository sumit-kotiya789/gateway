-- Default network (D-113): every merchant receives on BNB Smart Chain (BSC USDT) unless it chooses otherwise
-- (dashboard, Settings > Network). New merchants get admin_settings.default_network at signup; existing merchants that
-- had no network yet move to BSC now. Skipped where BSC is not registered (a fresh database is seeded after migrating).

ALTER TABLE "admin_settings" ADD COLUMN "default_network" text DEFAULT 'bsc';--> statement-breakpoint
UPDATE "merchants" SET "allowed_chain_id" = 'bsc'
  WHERE "allowed_chain_id" IS NULL AND EXISTS (SELECT 1 FROM "chains" WHERE "id" = 'bsc' AND NOT "testnet");
