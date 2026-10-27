-- MONEY-CRITICAL
-- Payout addresses and withdrawals (M7d, D-090): tenant isolation, immutability, forward-only statuses, approvals that
-- only grow and only from distinct admins, withdrawal journals tied to their withdrawal's state, and events for
-- webhooks. Ledger guard functions are replaced whole (previous version: 0034).

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payout_addresses', 'withdrawals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant ON %I TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id()) '
      'WITH CHECK (app_is_system() OR merchant_id = app_merchant_id())', t);
    EXECUTE format('CREATE POLICY readonly_all ON %I FOR SELECT TO gw_readonly USING (true)', t);
    EXECUTE format('CREATE POLICY signer_read ON %I FOR SELECT TO gw_signer USING (true)', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM gw_app', t);
    EXECUTE format('GRANT SELECT ON %I TO gw_signer', t);
  END LOOP;
  -- The signer checks the merchant's state and the withdrawal's hold in the ledger.
  FOREACH t IN ARRAY ARRAY['merchants', 'ledger_journals', 'ledger_entries', 'ledger_accounts'] LOOP
    EXECUTE format('GRANT SELECT ON %I TO gw_signer', t);
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = format('public.%I', t)::regclass) THEN
      EXECUTE format('CREATE POLICY signer_read ON %I FOR SELECT TO gw_signer USING (true)', t);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- A payout address never changes; a pending one (not active yet) can be cancelled, once.
CREATE FUNCTION payout_address_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.livemode, NEW.family, NEW.address, NEW.label, NEW.created_by, NEW.activates_at, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.merchant_id, OLD.livemode, OLD.family, OLD.address, OLD.label, OLD.created_by, OLD.activates_at, OLD.created_at)
     OR OLD.cancelled_at IS NOT NULL OR OLD.activates_at <= now() THEN
    RAISE EXCEPTION 'payout addresses are immutable; only a pending one can be cancelled' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payout_addresses_guard BEFORE UPDATE ON payout_addresses FOR EACH ROW EXECUTE FUNCTION payout_address_guard();
--> statement-breakpoint

CREATE FUNCTION withdrawal_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a payout_addresses; m merchants; cur uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO a FROM payout_addresses WHERE id = NEW.payout_address_id;
    SELECT * INTO m FROM merchants WHERE id = NEW.merchant_id;
    SELECT id INTO cur FROM payout_addresses
      WHERE merchant_id = NEW.merchant_id AND livemode = NEW.livemode AND family = a.family AND cancelled_at IS NULL AND activates_at <= now()
      ORDER BY activates_at DESC, created_at DESC LIMIT 1;
    IF m.custody_mode <> 'custodial' OR m.status <> 'active' OR 'payouts_frozen' = ANY (m.risk_flags)
       OR cur IS DISTINCT FROM NEW.payout_address_id OR lower(a.address) <> lower(NEW.to_address)
       OR cardinality(NEW.approved_by) <> 0
       OR NEW.status <> (CASE WHEN NEW.approvals_required = 0 THEN 'approved' ELSE 'pending_approval' END)::withdrawal_status THEN
      RAISE EXCEPTION 'withdrawal must go to the current payout address of an active, unfrozen custodial merchant' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.merchant_id, NEW.livemode, NEW.chain_id, NEW.token_id, NEW.amount, NEW.payout_address_id, NEW.to_address,
      NEW.approvals_required, NEW.requested_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.merchant_id, OLD.livemode, OLD.chain_id, OLD.token_id, OLD.amount, OLD.payout_address_id, OLD.to_address,
      OLD.approvals_required, OLD.requested_by, OLD.created_at)
     OR OLD.status IN ('confirmed', 'failed', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'withdrawal identity is immutable and final states are final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Approvals only grow, one per distinct admin, and only while pending.
  IF NEW.approved_by IS DISTINCT FROM OLD.approved_by AND (
       OLD.status <> 'pending_approval'
    OR NOT (NEW.approved_by @> OLD.approved_by)
    OR cardinality(NEW.approved_by) <> (SELECT count(DISTINCT x) FROM unnest(NEW.approved_by) x)) THEN
    RAISE EXCEPTION 'approvals only grow, once per admin, while pending' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending_approval' AND NEW.status = 'approved' AND cardinality(NEW.approved_by) >= NEW.approvals_required)
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('rejected', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('sent', 'failed'))
    OR (OLD.status = 'sent' AND NEW.status IN ('confirmed', 'failed'))) THEN
    RAISE EXCEPTION 'illegal withdrawal transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER withdrawals_guard BEFORE INSERT OR UPDATE ON withdrawals FOR EACH ROW EXECUTE FUNCTION withdrawal_guard();
--> statement-breakpoint

-- Webhook events: withdrawal.<status> on every change (amounts in minor units, like invoice events).
CREATE FUNCTION withdrawal_outbox_writer() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO outbox_events (merchant_id, livemode, type, invoice_id, data)
    VALUES (NEW.merchant_id, NEW.livemode, 'withdrawal.' || NEW.status, NULL, jsonb_build_object(
      'withdrawal_id', NEW.id, 'status', NEW.status, 'previous_status', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
      'token', NEW.token_id, 'amount', NEW.amount::text, 'to_address', NEW.to_address, 'tx_hash', NEW.tx_hash));
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER withdrawals_outbox AFTER INSERT OR UPDATE OF status ON withdrawals FOR EACH ROW EXECUTE FUNCTION withdrawal_outbox_writer();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ledger_journal_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i invoices; p payments; t fee_topups; s sweeps; w withdrawals;
BEGIN
  IF NEW.kind = 'fee_topup' THEN
    SELECT * INTO t FROM fee_topups WHERE id = NEW.topup_id;
    IF NOT FOUND OR t.merchant_id <> NEW.merchant_id OR t.livemode <> NEW.livemode OR t.token_id <> NEW.token_id THEN
      RAISE EXCEPTION 'top-up journal does not match its top-up' USING ERRCODE = 'check_violation';
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
    ELSE ARRAY[]::text[]
  END;
  IF NOT (a.kind::text = ANY (allowed)) THEN
    RAISE EXCEPTION 'account % is not allowed in a % journal', a.kind, j.kind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
