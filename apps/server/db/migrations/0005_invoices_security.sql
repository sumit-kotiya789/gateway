-- MONEY-CRITICAL
-- Invoice guards. The transition table below MUST equal INVOICE_TRANSITIONS in packages/core/src/invoice.ts
-- (enforced by test: invoices.test.ts "DB transition table matches core").

-- Tenant isolation.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices', 'invoice_status_history', 'payment_links', 'idempotency_keys'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant ON %I TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id()) '
      'WITH CHECK (app_is_system() OR merchant_id = app_merchant_id())', t);
    EXECUTE format('CREATE POLICY readonly_all ON %I FOR SELECT TO gw_readonly USING (true)', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- Invoices are financial records: never deleted.
REVOKE DELETE, TRUNCATE ON invoices FROM gw_app;
--> statement-breakpoint
CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER invoices_no_truncate BEFORE TRUNCATE ON invoices FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

-- Status history is append-only and written ONLY by the trigger below (app role cannot insert directly).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON invoice_status_history FROM gw_app;
--> statement-breakpoint
CREATE TRIGGER invoice_status_history_no_update_delete BEFORE UPDATE OR DELETE ON invoice_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER invoice_status_history_no_truncate BEFORE TRUNCATE ON invoice_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

CREATE TABLE invoice_transitions (
  from_status invoice_status NOT NULL,
  to_status invoice_status NOT NULL,
  PRIMARY KEY (from_status, to_status)
);
--> statement-breakpoint
INSERT INTO invoice_transitions (from_status, to_status) VALUES
  ('created', 'pending'), ('created', 'failed'),
  ('pending', 'detected'), ('pending', 'expired'), ('pending', 'cancelled'),
  ('detected', 'confirming'), ('detected', 'pending'),
  ('confirming', 'paid'), ('confirming', 'underpaid'), ('confirming', 'overpaid'), ('confirming', 'pending'),
  ('underpaid', 'detected'), ('underpaid', 'paid'),
  ('paid', 'settled'), ('overpaid', 'settled'),
  ('expired', 'late_payment'), ('cancelled', 'late_payment'),
  ('late_payment', 'paid');
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON invoice_transitions FROM gw_app;
--> statement-breakpoint

-- Insert: must start at 'created'; deposit address must belong to the same merchant / mode / chain, text must match.
CREATE FUNCTION invoice_insert_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d deposit_addresses;
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
  NEW.status_changed_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoices_insert_guard BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION invoice_insert_guard();
--> statement-breakpoint

-- Update: identity is immutable; status changes only along invoice_transitions.
CREATE FUNCTION invoice_update_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.livemode, NEW.chain_id, NEW.token_id, NEW.amount_expected, NEW.deposit_address_id,
      NEW.deposit_address, NEW.custody_mode, NEW.underpay_tolerance_bps, NEW.external_order_id, NEW.payment_link_id,
      NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.merchant_id, OLD.livemode, OLD.chain_id, OLD.token_id, OLD.amount_expected, OLD.deposit_address_id,
      OLD.deposit_address, OLD.custody_mode, OLD.underpay_tolerance_bps, OLD.external_order_id, OLD.payment_link_id,
      OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'invoice identity and amount are immutable' USING ERRCODE = 'insufficient_privilege';
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
CREATE TRIGGER invoices_update_guard BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoice_update_guard();
--> statement-breakpoint

-- Every status (including the initial one) is recorded. Reason comes from the transaction-local setting
-- app.transition_reason, set by the application right before the change.
CREATE FUNCTION invoice_history_writer() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO invoice_status_history (invoice_id, merchant_id, from_status, to_status, reason)
    VALUES (NEW.id, NEW.merchant_id, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END, NEW.status,
            coalesce(nullif(current_setting('app.transition_reason', true), ''), 'unspecified'));
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoices_history AFTER INSERT OR UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoice_history_writer();
--> statement-breakpoint

-- custody_mode is immutable once the merchant has any live invoice (admin migration flow comes later, audited).
CREATE FUNCTION merchant_custody_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.custody_mode IS DISTINCT FROM OLD.custody_mode
     AND EXISTS (SELECT 1 FROM invoices WHERE merchant_id = OLD.id AND livemode) THEN
    RAISE EXCEPTION 'custody mode is locked after the first live invoice' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER merchants_custody_guard BEFORE UPDATE ON merchants FOR EACH ROW EXECUTE FUNCTION merchant_custody_guard();
--> statement-breakpoint

-- Idempotency records are immutable once written (a replay must return exactly what was returned before).
REVOKE UPDATE ON idempotency_keys FROM gw_app;
