-- MONEY-CRITICAL
-- Custodial partial payments (D-092): an underpaid custodial invoice may close as partially_paid (the worker does it
-- after the deadline), never a non-custodial one, and a settlement journal may credit a partially_paid invoice. Guard
-- functions replaced whole (previous versions: invoice_update_guard 0018, ledger_journal_guard 0038); the
-- one-settlement-per-invoice index still makes the credit once.

INSERT INTO invoice_transitions (from_status, to_status) VALUES ('underpaid', 'partially_paid');
--> statement-breakpoint

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
    -- A partial payment is a custodial outcome only: non-custodial merchants already hold what arrived.
    IF NEW.status = 'partially_paid' AND OLD.custody_mode <> 'custodial' THEN
      RAISE EXCEPTION 'only custodial invoices close as partially paid' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM invoice_transitions WHERE from_status = OLD.status AND to_status = NEW.status) THEN
      RAISE EXCEPTION 'illegal invoice transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    NEW.status_changed_at := now();
  END IF;
  RETURN NEW;
END $$;
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
  IF NEW.kind = 'settlement' AND (i.custody_mode <> 'custodial' OR i.status NOT IN ('paid', 'overpaid', 'partially_paid')) THEN
    RAISE EXCEPTION 'settlement journals are for paid custodial invoices' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
