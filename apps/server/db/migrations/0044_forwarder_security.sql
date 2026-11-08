-- MONEY-CRITICAL
-- Forwarder custody mode (D-097). What the database guarantees even if application code is wrong:
--   - forwarder merchants only get forwarder deposit addresses, on chains that have a factory;
--   - the parameters a forwarder address commits to come from that merchant's CURRENT payout address, the active fee
--     wallet, the chain's factory and the registered token, and never change afterwards;
--   - a forwarder invoice's committed fee terms are exactly the invoice's (rate; cap = fee on the expected amount);
--   - forwards flush their own invoice's forwarder address, only move forward, and never book more fee than the cap;
--   - a chain's forwarder factory is set once (swapping it would change every new deposit address).
-- The CREATE2 address math itself is checked by the app (packages/chains forwarder.ts) and, independently, by the signer.

-- Deposit address guard (previous version: 0003): forwarder merchants get forwarder addresses, nothing else does.
CREATE OR REPLACE FUNCTION deposit_address_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c chains;
  mode custody_mode;
BEGIN
  SELECT * INTO c FROM chains WHERE id = NEW.chain_id;
  IF NOT FOUND OR NOT c.enabled THEN
    RAISE EXCEPTION 'chain % is not enabled', NEW.chain_id USING ERRCODE = 'check_violation';
  END IF;
  IF c.family <> NEW.family THEN
    RAISE EXCEPTION 'chain family mismatch' USING ERRCODE = 'check_violation';
  END IF;
  IF c.testnet = NEW.livemode THEN
    RAISE EXCEPTION 'live addresses need a mainnet chain; test addresses need a testnet' USING ERRCODE = 'check_violation';
  END IF;
  SELECT custody_mode INTO mode FROM merchants WHERE id = NEW.merchant_id;
  IF mode IS NULL
     OR (mode = 'custodial' AND NEW.source <> 'platform')
     OR (mode = 'non_custodial_xpub' AND NEW.source <> 'merchant_xpub')
     OR (mode = 'non_custodial_forwarder' AND NEW.source <> 'forwarder') THEN
    RAISE EXCEPTION 'address source % not allowed for custody mode %', NEW.source, mode USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.source = 'forwarder' AND c.forwarder_factory IS NULL THEN
    RAISE EXCEPTION 'chain % has no forwarder factory', NEW.chain_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- Invoice creation runs in a merchant's context and must read the active fee wallet (its address is public anyway:
-- it is a constructor argument of every forwarder). Only fee wallets, only reading.
CREATE POLICY fee_wallet_read ON platform_wallets FOR SELECT TO gw_app USING (kind = 'fee' AND retired_at IS NULL);
--> statement-breakpoint

-- Committed parameters: tenant isolation, written once, never changed or deleted.
ALTER TABLE forwarder_params ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON forwarder_params TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id())
  WITH CHECK (app_is_system() OR merchant_id = app_merchant_id());
--> statement-breakpoint
CREATE POLICY readonly_all ON forwarder_params FOR SELECT TO gw_readonly USING (true);
--> statement-breakpoint
GRANT SELECT ON forwarder_params TO gw_signer;
--> statement-breakpoint
CREATE POLICY signer_read ON forwarder_params FOR SELECT TO gw_signer USING (true);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON forwarder_params FROM gw_app;
--> statement-breakpoint
CREATE TRIGGER forwarder_params_append_only BEFORE UPDATE OR DELETE ON forwarder_params FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER forwarder_params_no_truncate BEFORE TRUNCATE ON forwarder_params FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE FUNCTION forwarder_params_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d deposit_addresses; c chains; t tokens; p payout_addresses; w platform_wallets;
BEGIN
  SELECT * INTO d FROM deposit_addresses WHERE id = NEW.deposit_address_id;
  SELECT * INTO c FROM chains WHERE id = NEW.chain_id;
  SELECT * INTO t FROM tokens WHERE id = NEW.token_id;
  SELECT * INTO p FROM payout_addresses WHERE id = NEW.payout_address_id;
  SELECT * INTO w FROM platform_wallets WHERE id = NEW.fee_wallet_id;
  IF d.id IS NULL OR d.source <> 'forwarder' OR d.merchant_id <> NEW.merchant_id OR d.livemode <> NEW.livemode
     OR d.chain_id <> NEW.chain_id THEN
    RAISE EXCEPTION 'forwarder parameters must belong to a forwarder deposit address of the same merchant, mode and chain'
      USING ERRCODE = 'check_violation';
  END IF;
  IF c.forwarder_factory IS NULL OR lower(c.forwarder_factory) <> lower(NEW.factory) THEN
    RAISE EXCEPTION 'factory must be the chain''s forwarder factory' USING ERRCODE = 'check_violation';
  END IF;
  IF t.id IS NULL OR t.chain_id <> NEW.chain_id OR lower(t.contract_address) <> lower(NEW.token_contract) THEN
    RAISE EXCEPTION 'token contract must be the registered token of this chain' USING ERRCODE = 'check_violation';
  END IF;
  -- The merchant's CURRENT payout address (same rule as currentPayoutAddress in withdrawals.ts).
  IF p.id IS NULL OR p.merchant_id <> NEW.merchant_id OR p.livemode <> NEW.livemode OR p.family <> d.family
     OR p.cancelled_at IS NOT NULL OR p.activates_at > now() OR lower(p.address) <> lower(NEW.merchant_address)
     OR EXISTS (SELECT 1 FROM payout_addresses q
                WHERE q.merchant_id = p.merchant_id AND q.livemode = p.livemode AND q.family = p.family
                  AND q.cancelled_at IS NULL AND q.activates_at <= now()
                  AND (q.activates_at, q.created_at) > (p.activates_at, p.created_at)) THEN
    RAISE EXCEPTION 'merchant address must be the merchant''s current payout address' USING ERRCODE = 'check_violation';
  END IF;
  IF w.id IS NULL OR w.kind <> 'fee' OR w.family <> d.family OR w.livemode <> NEW.livemode OR w.retired_at IS NOT NULL
     OR lower(w.address) <> lower(NEW.fee_recipient) THEN
    RAISE EXCEPTION 'fee recipient must be the active platform fee wallet' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER forwarder_params_guard BEFORE INSERT ON forwarder_params FOR EACH ROW EXECUTE FUNCTION forwarder_params_guard();
--> statement-breakpoint

-- Invoice insert guard (previous version: 0005): a forwarder invoice's committed terms are the invoice's own.
CREATE OR REPLACE FUNCTION invoice_insert_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d deposit_addresses; f forwarder_params;
BEGIN
  IF NEW.status <> 'created' THEN
    RAISE EXCEPTION 'invoices must be created in status created' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO d FROM deposit_addresses WHERE id = NEW.deposit_address_id;
  IF NOT FOUND OR d.merchant_id <> NEW.merchant_id OR d.livemode <> NEW.livemode OR d.chain_id <> NEW.chain_id
     OR lower(d.address) <> lower(NEW.deposit_address) THEN
    RAISE EXCEPTION 'deposit address does not match invoice' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tokens WHERE id = NEW.token_id AND chain_id = NEW.chain_id) THEN
    RAISE EXCEPTION 'token does not belong to chain' USING ERRCODE = 'check_violation';
  END IF;
  IF d.source = 'forwarder' OR NEW.custody_mode = 'non_custodial_forwarder' THEN
    SELECT * INTO f FROM forwarder_params WHERE deposit_address_id = d.id;
    IF NOT FOUND OR d.source <> 'forwarder' OR NEW.custody_mode <> 'non_custodial_forwarder'
       OR f.token_id <> NEW.token_id OR f.fee_bps <> NEW.fee_bps
       OR f.fee_cap <> trunc(NEW.amount_expected * NEW.fee_bps / 10000) THEN
      RAISE EXCEPTION 'forwarder terms do not match the invoice' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.status_changed_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint

-- Forwards: tenant isolation, no deletes; what is flushed never changes; status only moves forward; fee within cap.
ALTER TABLE forwards ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON forwards TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id())
  WITH CHECK (app_is_system() OR merchant_id = app_merchant_id());
--> statement-breakpoint
CREATE POLICY readonly_all ON forwards FOR SELECT TO gw_readonly USING (true);
--> statement-breakpoint
GRANT SELECT ON forwards TO gw_signer;
--> statement-breakpoint
CREATE POLICY signer_read ON forwards FOR SELECT TO gw_signer USING (true);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON forwards FROM gw_app;
--> statement-breakpoint
CREATE FUNCTION forward_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f forwarder_params; d deposit_addresses; i invoices; taken numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO f FROM forwarder_params WHERE deposit_address_id = NEW.deposit_address_id;
    SELECT * INTO d FROM deposit_addresses WHERE id = NEW.deposit_address_id;
    SELECT * INTO i FROM invoices WHERE id = NEW.invoice_id;
    IF f.deposit_address_id IS NULL OR f.merchant_id <> NEW.merchant_id OR f.livemode <> NEW.livemode
       OR f.chain_id <> NEW.chain_id OR f.token_id <> NEW.token_id OR lower(d.address) <> lower(NEW.forwarder_address)
       OR i.id IS NULL OR i.deposit_address_id <> d.id OR i.custody_mode <> 'non_custodial_forwarder'
       OR NEW.status <> 'pending' OR NEW.to_merchant IS NOT NULL OR NEW.fee IS NOT NULL OR NEW.tx_hash IS NOT NULL THEN
      RAISE EXCEPTION 'a forward must flush the forwarder deposit address of its own invoice' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.merchant_id, NEW.livemode, NEW.chain_id, NEW.token_id, NEW.deposit_address_id, NEW.invoice_id,
      NEW.forwarder_address, NEW.amount, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.merchant_id, OLD.livemode, OLD.chain_id, OLD.token_id, OLD.deposit_address_id, OLD.invoice_id,
      OLD.forwarder_address, OLD.amount, OLD.created_at)
     OR OLD.status IN ('confirmed', 'failed')
     OR (OLD.tx_hash IS NOT NULL AND NEW.tx_hash IS DISTINCT FROM OLD.tx_hash)
     OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (
          (OLD.status = 'pending' AND NEW.status IN ('sent', 'failed'))
       OR (OLD.status = 'sent' AND NEW.status IN ('confirmed', 'failed')))) THEN
    RAISE EXCEPTION 'forward identity is immutable and its status only moves forward' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'confirmed' THEN
    SELECT * INTO f FROM forwarder_params WHERE deposit_address_id = NEW.deposit_address_id;
    SELECT coalesce(sum(fee), 0) INTO taken FROM forwards
      WHERE deposit_address_id = NEW.deposit_address_id AND status = 'confirmed' AND id <> NEW.id;
    IF NEW.fee < 0 OR NEW.to_merchant < 0 OR taken + NEW.fee > f.fee_cap THEN
      RAISE EXCEPTION 'forward fee above the committed cap' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER forwards_guard BEFORE INSERT OR UPDATE ON forwards FOR EACH ROW EXECUTE FUNCTION forward_guard();
--> statement-breakpoint

-- A chain's forwarder factory is set once.
CREATE FUNCTION chain_forwarder_factory_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.forwarder_factory IS NOT NULL AND NEW.forwarder_factory IS DISTINCT FROM OLD.forwarder_factory THEN
    RAISE EXCEPTION 'a chain''s forwarder factory is set once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER chains_forwarder_factory_once BEFORE UPDATE ON chains FOR EACH ROW EXECUTE FUNCTION chain_forwarder_factory_once();
--> statement-breakpoint

-- Ledger entry guard (previous version: 0038): forward_fee journals.
CREATE OR REPLACE FUNCTION ledger_entry_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j ledger_journals; a ledger_accounts; mode custody_mode; allowed text[];
BEGIN
  SELECT * INTO j FROM ledger_journals WHERE id = NEW.journal_id;
  SELECT * INTO a FROM ledger_accounts WHERE id = NEW.account_id;
  IF a.livemode <> j.livemode OR a.token_id <> j.token_id
     OR (a.merchant_id IS NOT NULL AND a.merchant_id <> j.merchant_id)
     OR NEW.merchant_id IS DISTINCT FROM a.merchant_id THEN
    RAISE EXCEPTION 'ledger entry does not match its journal' USING ERRCODE = 'check_violation';
  END IF;
  IF j.invoice_id IS NOT NULL THEN
    SELECT custody_mode INTO mode FROM invoices WHERE id = j.invoice_id;
  END IF;
  allowed := CASE
    WHEN j.kind = 'payment' AND mode = 'custodial' THEN ARRAY['custody_deposits', 'merchant_pending']
    WHEN j.kind = 'payment' THEN ARRAY['merchant_received', 'merchant_sales']
    WHEN j.kind = 'fee' THEN ARRAY['merchant_fees_owed', 'platform_fee_revenue']
    WHEN j.kind = 'fee_topup' THEN ARRAY['platform_topups', 'merchant_fees_owed']
    WHEN j.kind = 'settlement' THEN ARRAY['merchant_pending', 'merchant_available', 'platform_fee_revenue']
    WHEN j.kind = 'sweep' THEN ARRAY['custody_deposits', 'custody_hot']
    WHEN j.kind = 'withdrawal_hold' THEN ARRAY['merchant_available', 'merchant_withdrawing']
    WHEN j.kind = 'withdrawal' THEN ARRAY['merchant_withdrawing', 'custody_hot']
    WHEN j.kind = 'withdrawal_release' THEN ARRAY['merchant_withdrawing', 'merchant_available']
    WHEN j.kind = 'treasury' THEN ARRAY['custody_hot', 'custody_cold']
    WHEN j.kind = 'forward_fee' AND mode = 'non_custodial_forwarder'
      THEN ARRAY['merchant_received', 'merchant_sales', 'platform_fee_wallet', 'platform_fee_revenue']
    ELSE ARRAY[]::text[]
  END;
  IF NOT (a.kind::text = ANY (allowed)) THEN
    RAISE EXCEPTION 'account % is not allowed in a % journal', a.kind, j.kind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
