-- MONEY-CRITICAL
-- Ledger and outbox guards. The ledger is append-only double entry: every journal sums to zero in one token, checked at
-- commit. Outbox events are written only by the invoice trigger, in the same transaction as the status change.

-- Existing invoices take their merchant's current fee (before fee_bps becomes immutable below).
UPDATE invoices i SET fee_bps = m.fee_bps FROM merchants m WHERE m.id = i.merchant_id AND i.fee_bps <> m.fee_bps;
--> statement-breakpoint

-- Tenant isolation. Platform ledger rows (merchant_id null) are visible to the system context only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ledger_accounts', 'ledger_journals', 'ledger_entries', 'outbox_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant ON %I TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id()) '
      'WITH CHECK (app_is_system() OR merchant_id = app_merchant_id())', t);
    EXECUTE format('CREATE POLICY readonly_all ON %I FOR SELECT TO gw_readonly USING (true)', t);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE reconciliation_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY system_only ON reconciliation_runs TO gw_app USING (app_is_system()) WITH CHECK (app_is_system());
--> statement-breakpoint
CREATE POLICY readonly_all ON reconciliation_runs FOR SELECT TO gw_readonly USING (true);
--> statement-breakpoint

-- Append-only: journals and entries are never changed or removed (corrections are new journals).
REVOKE UPDATE, DELETE, TRUNCATE ON ledger_journals, ledger_entries, ledger_accounts FROM gw_app;
--> statement-breakpoint
CREATE TRIGGER ledger_journals_append_only BEFORE UPDATE OR DELETE ON ledger_journals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_accounts_append_only BEFORE UPDATE OR DELETE ON ledger_accounts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_journals_no_truncate BEFORE TRUNCATE ON ledger_journals FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

-- Each entry: account in the journal's mode and token, owned by the journal's merchant (or the platform);
-- entry.merchant_id mirrors the account owner.
CREATE FUNCTION ledger_entry_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j ledger_journals; a ledger_accounts;
BEGIN
  SELECT * INTO j FROM ledger_journals WHERE id = NEW.journal_id;
  SELECT * INTO a FROM ledger_accounts WHERE id = NEW.account_id;
  IF a.livemode <> j.livemode OR a.token_id <> j.token_id
     OR (a.merchant_id IS NOT NULL AND a.merchant_id <> j.merchant_id)
     OR NEW.merchant_id IS DISTINCT FROM a.merchant_id THEN
    RAISE EXCEPTION 'ledger entry does not match its journal' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_guard BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_entry_guard();
--> statement-breakpoint

-- Balanced at commit: deferred, so a journal's lines can be inserted one by one inside the transaction.
CREATE FUNCTION ledger_journal_balanced() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE total numeric; n int;
BEGIN
  SELECT coalesce(sum(amount), 0), count(*) INTO total, n FROM ledger_entries WHERE journal_id = NEW.journal_id;
  IF total <> 0 OR n < 2 THEN
    RAISE EXCEPTION 'ledger journal % is not balanced', NEW.journal_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_journal_balanced();
--> statement-breakpoint
-- A journal with no entries at all is also unbalanced.
CREATE FUNCTION ledger_journal_has_entries() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ledger_entries WHERE journal_id = NEW.id) THEN
    RAISE EXCEPTION 'ledger journal % has no entries', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_journals_has_entries AFTER INSERT ON ledger_journals DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_journal_has_entries();
--> statement-breakpoint

-- Payment journals only for confirmed payments of the same invoice.
CREATE FUNCTION ledger_journal_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i invoices; p payments;
BEGIN
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
CREATE TRIGGER ledger_journals_guard BEFORE INSERT ON ledger_journals FOR EACH ROW EXECUTE FUNCTION ledger_journal_guard();
--> statement-breakpoint

-- Invoice update guard, now also covering the fee: fee_bps is part of the invoice identity, fee_amount is set once.
CREATE OR REPLACE FUNCTION invoice_update_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.livemode, NEW.chain_id, NEW.token_id, NEW.amount_expected, NEW.deposit_address_id,
      NEW.deposit_address, NEW.custody_mode, NEW.underpay_tolerance_bps, NEW.fee_bps, NEW.external_order_id,
      NEW.payment_link_id, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.merchant_id, OLD.livemode, OLD.chain_id, OLD.token_id, OLD.amount_expected, OLD.deposit_address_id,
      OLD.deposit_address, OLD.custody_mode, OLD.underpay_tolerance_bps, OLD.fee_bps, OLD.external_order_id,
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
--> statement-breakpoint

-- Outbox: one event per status change (the initial created -> pending is the merchant's own action, not an event).
-- Amounts are minor-unit strings; consumers format them with the token's (immutable) decimals.
CREATE FUNCTION invoice_outbox_writer() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'created' THEN
    INSERT INTO outbox_events (merchant_id, livemode, type, invoice_id, data)
    VALUES (NEW.merchant_id, NEW.livemode, 'invoice.' || NEW.status, NEW.id, jsonb_build_object(
      'invoice_id', NEW.id, 'status', NEW.status, 'previous_status', OLD.status, 'token', NEW.token_id,
      'amount_expected', NEW.amount_expected::text, 'amount_received', NEW.amount_received::text,
      'fee_amount', NEW.fee_amount::text, 'external_order_id', NEW.external_order_id,
      'reason', coalesce(nullif(current_setting('app.transition_reason', true), ''), 'unspecified')));
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoices_outbox AFTER UPDATE OF status ON invoices FOR EACH ROW EXECUTE FUNCTION invoice_outbox_writer();
--> statement-breakpoint
-- Only the trigger writes events; the app may read them (delivery bookkeeping lives in M6 tables).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON outbox_events FROM gw_app;
--> statement-breakpoint
CREATE TRIGGER outbox_events_append_only BEFORE UPDATE OR DELETE ON outbox_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
