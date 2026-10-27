-- MONEY-CRITICAL
-- Treasury (M7e, D-091): system-only rows, transfers only between the active hot wallet and the registered cold
-- wallet, two different admins for hot -> cold, forward-only statuses, treasury journals only between custody_hot
-- and custody_cold. Ledger guard functions replaced whole (previous version: 0036).

ALTER TABLE treasury_transfers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY system_only ON treasury_transfers TO gw_app USING (app_is_system()) WITH CHECK (app_is_system());
--> statement-breakpoint
CREATE POLICY readonly_all ON treasury_transfers FOR SELECT TO gw_readonly USING (true);
--> statement-breakpoint
CREATE POLICY signer_read ON treasury_transfers FOR SELECT TO gw_signer USING (true);
--> statement-breakpoint
GRANT SELECT ON treasury_transfers TO gw_signer;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON treasury_transfers FROM gw_app;
--> statement-breakpoint

CREATE FUNCTION treasury_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c chains; hot platform_wallets; cold platform_wallets;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO c FROM chains WHERE id = NEW.chain_id;
    SELECT * INTO hot FROM platform_wallets WHERE kind = 'hot' AND family = c.family AND livemode = NEW.livemode AND retired_at IS NULL;
    SELECT * INTO cold FROM platform_wallets WHERE kind = 'cold' AND family = c.family AND livemode = NEW.livemode AND retired_at IS NULL;
    IF hot.id IS NULL OR cold.id IS NULL OR lower(hot.address) <> lower(NEW.hot_address) OR lower(cold.address) <> lower(NEW.cold_address)
       OR NEW.approved_by IS NOT NULL
       OR (NEW.direction = 'to_cold' AND (NEW.status <> 'pending_approval' OR NEW.tx_hash IS NOT NULL))
       OR (NEW.direction = 'to_hot' AND NEW.status <> 'sent') THEN
      RAISE EXCEPTION 'treasury transfers move between the active hot wallet and the registered cold wallet' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.livemode, NEW.chain_id, NEW.token_id, NEW.direction, NEW.amount, NEW.cold_address, NEW.hot_address, NEW.requested_by, NEW.reason, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.livemode, OLD.chain_id, OLD.token_id, OLD.direction, OLD.amount, OLD.cold_address, OLD.hot_address, OLD.requested_by, OLD.reason, OLD.created_at)
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
--> statement-breakpoint
CREATE TRIGGER treasury_transfers_guard BEFORE INSERT OR UPDATE ON treasury_transfers FOR EACH ROW EXECUTE FUNCTION treasury_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ledger_journal_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i invoices; p payments; t fee_topups; s sweeps; w withdrawals; tt treasury_transfers;
BEGIN
  IF NEW.kind = 'fee_topup' THEN
    SELECT * INTO t FROM fee_topups WHERE id = NEW.topup_id;
    IF NOT FOUND OR t.merchant_id <> NEW.merchant_id OR t.livemode <> NEW.livemode OR t.token_id <> NEW.token_id THEN
      RAISE EXCEPTION 'top-up journal does not match its top-up' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind = 'treasury' THEN
    SELECT * INTO tt FROM treasury_transfers WHERE id = NEW.treasury_id;
    IF NOT FOUND OR tt.status <> 'confirmed' OR tt.livemode <> NEW.livemode OR tt.token_id <> NEW.token_id OR NEW.merchant_id IS NOT NULL THEN
      RAISE EXCEPTION 'treasury journal needs a confirmed transfer' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind IN ('withdrawal_hold', 'withdrawal', 'withdrawal_release') THEN
    SELECT * INTO w FROM withdrawals WHERE id = NEW.withdrawal_id;
    IF NOT FOUND OR w.merchant_id <> NEW.merchant_id OR w.livemode <> NEW.livemode OR w.token_id <> NEW.token_id
       OR (NEW.kind = 'withdrawal_hold' AND w.status NOT IN ('pending_approval', 'approved'))
       OR (NEW.kind = 'withdrawal' AND w.status <> 'confirmed')
       OR (NEW.kind = 'withdrawal_release' AND w.status NOT IN ('failed', 'rejected', 'cancelled')) THEN
      RAISE EXCEPTION 'withdrawal journal does not match its withdrawal' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO i FROM invoices WHERE id = NEW.invoice_id;
  IF i.merchant_id <> NEW.merchant_id OR i.livemode <> NEW.livemode OR i.token_id <> NEW.token_id THEN
    RAISE EXCEPTION 'ledger journal does not match invoice' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'payment' THEN
    SELECT * INTO p FROM payments WHERE id = NEW.payment_id;
    IF NOT FOUND OR p.invoice_id <> NEW.invoice_id OR p.status <> 'confirmed' THEN
      RAISE EXCEPTION 'payment journal needs a confirmed payment of this invoice' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Fees of non-custodial invoices are charged to the prepaid balance; custodial invoices pay theirs at settlement.
  IF NEW.kind = 'fee' AND i.custody_mode <> 'non_custodial_xpub' THEN
    RAISE EXCEPTION 'fee journals are for non-custodial invoices' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'sweep' THEN
    SELECT * INTO s FROM sweeps WHERE id = NEW.sweep_id;
    IF NOT FOUND OR s.status <> 'confirmed' OR s.invoice_id <> NEW.invoice_id OR s.merchant_id <> NEW.merchant_id
       OR s.livemode <> NEW.livemode OR s.token_id <> NEW.token_id THEN
      RAISE EXCEPTION 'sweep journal needs a confirmed sweep of this invoice' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.kind = 'settlement' AND (i.custody_mode <> 'custodial' OR i.status NOT IN ('paid', 'overpaid')) THEN
    RAISE EXCEPTION 'settlement journals are for paid custodial invoices' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

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
    ELSE ARRAY[]::text[]
  END;
  IF NOT (a.kind::text = ANY (allowed)) THEN
    RAISE EXCEPTION 'account % is not allowed in a % journal', a.kind, j.kind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
