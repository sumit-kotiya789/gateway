-- MONEY-CRITICAL
-- Custodial ledger guards (M7, D-087). Journals match the invoice's custody mode, and every entry uses only the
-- account kinds its journal kind allows, so a custodial booking can never touch a non-custodial account (or the
-- reverse) even if application code is wrong.

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
  -- Fees of non-custodial invoices are charged to the prepaid balance; custodial invoices pay theirs at settlement.
  IF NEW.kind = 'fee' AND i.custody_mode <> 'non_custodial_xpub' THEN
    RAISE EXCEPTION 'fee journals are for non-custodial invoices' USING ERRCODE = 'check_violation';
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
    ELSE ARRAY[]::text[]
  END;
  IF NOT (a.kind::text = ANY (allowed)) THEN
    RAISE EXCEPTION 'account % is not allowed in a % journal', a.kind, j.kind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
