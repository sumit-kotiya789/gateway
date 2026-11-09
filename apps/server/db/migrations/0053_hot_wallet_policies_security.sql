-- MONEY-CRITICAL
-- Hot wallet policy (D-105). Policies: system-only rows (admin console), never deleted. Automatic treasury transfers:
-- only hot -> cold, inserted `approved` without an approver, requested by the admin who set the policy, and at most
-- the excess of the hot wallet's ledger balance over the policy cap. treasury_guard replaced whole (previous: 0038).

ALTER TABLE hot_wallet_policies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY system_only ON hot_wallet_policies TO gw_app USING (app_is_system()) WITH CHECK (app_is_system());
--> statement-breakpoint
CREATE POLICY readonly_all ON hot_wallet_policies FOR SELECT TO gw_readonly USING (true);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON hot_wallet_policies FROM gw_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION treasury_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c chains; hot platform_wallets; cold platform_wallets; p hot_wallet_policies; hot_ledger numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO c FROM chains WHERE id = NEW.chain_id;
    SELECT * INTO hot FROM platform_wallets WHERE kind = 'hot' AND family = c.family AND livemode = NEW.livemode AND retired_at IS NULL;
    SELECT * INTO cold FROM platform_wallets WHERE kind = 'cold' AND family = c.family AND livemode = NEW.livemode AND retired_at IS NULL;
    IF hot.id IS NULL OR cold.id IS NULL OR lower(hot.address) <> lower(NEW.hot_address) OR lower(cold.address) <> lower(NEW.cold_address)
       OR NEW.approved_by IS NOT NULL
       OR (NEW.direction = 'to_cold' AND NOT NEW.auto AND (NEW.status <> 'pending_approval' OR NEW.tx_hash IS NOT NULL))
       OR (NEW.direction = 'to_cold' AND NEW.auto AND (NEW.status <> 'approved' OR NEW.tx_hash IS NOT NULL))
       OR (NEW.direction = 'to_hot' AND (NEW.auto OR NEW.status <> 'sent')) THEN
      RAISE EXCEPTION 'treasury transfers move between the active hot wallet and the registered cold wallet' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.auto THEN
      -- Only what the policy cap says is too much, by the ledger's count of the hot wallet, on behalf of the policy's admin.
      SELECT * INTO p FROM hot_wallet_policies WHERE livemode = NEW.livemode AND token_id = NEW.token_id;
      SELECT coalesce(sum(e.amount), 0) INTO hot_ledger FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.kind = 'custody_hot' AND a.livemode = NEW.livemode AND a.token_id = NEW.token_id;
      IF p.id IS NULL OR p.max_balance IS NULL OR NEW.requested_by <> p.updated_by OR NEW.amount > hot_ledger - p.max_balance THEN
        RAISE EXCEPTION 'an automatic transfer moves at most the hot wallet balance above the policy cap' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.livemode, NEW.chain_id, NEW.token_id, NEW.direction, NEW.amount, NEW.cold_address, NEW.hot_address, NEW.requested_by, NEW.reason, NEW.created_at, NEW.auto)
     IS DISTINCT FROM (OLD.id, OLD.livemode, OLD.chain_id, OLD.token_id, OLD.direction, OLD.amount, OLD.cold_address, OLD.hot_address, OLD.requested_by, OLD.reason, OLD.created_at, OLD.auto)
     OR OLD.status IN ('confirmed', 'failed', 'rejected')
     OR (OLD.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by)
     OR (OLD.tx_hash IS NOT NULL AND NEW.tx_hash IS DISTINCT FROM OLD.tx_hash) THEN
    RAISE EXCEPTION 'treasury transfer identity is immutable and final states are final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending_approval' AND NEW.status = 'approved' AND NEW.approved_by IS NOT NULL)
    OR (OLD.status = 'pending_approval' AND NEW.status = 'rejected')
    OR (OLD.status = 'approved' AND NEW.status IN ('sent', 'failed'))
    OR (OLD.status = 'sent' AND NEW.status IN ('confirmed', 'failed'))) THEN
    RAISE EXCEPTION 'illegal treasury transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
