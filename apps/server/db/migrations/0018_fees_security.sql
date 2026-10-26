-- MONEY-CRITICAL
-- Prepaid fee top-ups (M8, D-076): append-only, tenant-isolated, each posted as exactly one balanced fee_topup journal.

ALTER TABLE fee_topups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON fee_topups TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id())
  WITH CHECK (app_is_system() OR merchant_id = app_merchant_id());
--> statement-breakpoint
CREATE POLICY readonly_all ON fee_topups FOR SELECT TO gw_readonly USING (true);
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON fee_topups FROM gw_app;
--> statement-breakpoint
CREATE TRIGGER fee_topups_append_only BEFORE UPDATE OR DELETE ON fee_topups FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER fee_topups_no_truncate BEFORE TRUNCATE ON fee_topups FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

-- Journals match what they book: payment and fee journals their invoice (and confirmed payment), top-up journals
-- their top-up (same merchant, mode and token).
CREATE OR REPLACE FUNCTION ledger_journal_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i invoices; p payments; t fee_topups;
BEGIN
  IF NEW.kind = 'fee_topup' THEN
    SELECT * INTO t FROM fee_topups WHERE id = NEW.topup_id;
    IF NOT FOUND OR t.merchant_id <> NEW.merchant_id OR t.livemode <> NEW.livemode OR t.token_id <> NEW.token_id THEN
      RAISE EXCEPTION 'top-up journal does not match its top-up' USING ERRCODE = 'check_violation';
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
  RETURN NEW;
END $$;
--> statement-breakpoint

-- A top-up exists only together with its journal: checked at commit, so the app inserts both in one transaction.
CREATE FUNCTION fee_topup_has_journal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ledger_journals WHERE kind = 'fee_topup' AND topup_id = NEW.id) THEN
    RAISE EXCEPTION 'fee top-up % has no ledger journal', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER fee_topups_has_journal AFTER INSERT ON fee_topups DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fee_topup_has_journal();
--> statement-breakpoint

-- Invoice update guard, now also covering the fixed fee snapshot.
CREATE OR REPLACE FUNCTION invoice_update_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.livemode, NEW.chain_id, NEW.token_id, NEW.amount_expected, NEW.deposit_address_id,
      NEW.deposit_address, NEW.custody_mode, NEW.underpay_tolerance_bps, NEW.fee_bps, NEW.fee_fixed, NEW.external_order_id,
      NEW.payment_link_id, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.merchant_id, OLD.livemode, OLD.chain_id, OLD.token_id, OLD.amount_expected, OLD.deposit_address_id,
      OLD.deposit_address, OLD.custody_mode, OLD.underpay_tolerance_bps, OLD.fee_bps, OLD.fee_fixed, OLD.external_order_id,
      OLD.payment_link_id, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'invoice identity and amount are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.fee_amount IS NOT NULL AND NEW.fee_amount IS DISTINCT FROM OLD.fee_amount THEN
    RAISE EXCEPTION 'invoice fee is set once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT EXISTS (SELECT 1 FROM invoice_transitions WHERE from_status = OLD.status AND to_status = NEW.status) THEN
      RAISE EXCEPTION 'illegal invoice transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    NEW.status_changed_at := now();
  END IF;
  RETURN NEW;
END $$;
