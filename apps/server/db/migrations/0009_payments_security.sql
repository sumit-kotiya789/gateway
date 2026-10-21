-- MONEY-CRITICAL
-- Payment guards. A payment row is what gets credited, so the database refuses rows that do not match their invoice,
-- edits to what was paid, and any way back from confirmed.

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON payments TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id())
  WITH CHECK (app_is_system() OR merchant_id = app_merchant_id());
--> statement-breakpoint
CREATE POLICY readonly_all ON payments FOR SELECT TO gw_readonly USING (true);
--> statement-breakpoint

-- Financial records: never deleted.
REVOKE DELETE, TRUNCATE ON payments FROM gw_app;
--> statement-breakpoint
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER payments_no_truncate BEFORE TRUNCATE ON payments FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

-- Insert: must start detected and match the invoice's merchant, mode, chain, token and deposit address.
CREATE FUNCTION payment_insert_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i invoices;
BEGIN
  IF NEW.status <> 'detected' THEN
    RAISE EXCEPTION 'payments must be created in status detected' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO i FROM invoices WHERE id = NEW.invoice_id;
  IF NOT FOUND OR i.merchant_id <> NEW.merchant_id OR i.livemode <> NEW.livemode OR i.chain_id <> NEW.chain_id
     OR i.token_id <> NEW.token_id OR lower(i.deposit_address) <> lower(NEW.to_address) THEN
    RAISE EXCEPTION 'payment does not match invoice' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payments_insert_guard BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION payment_insert_guard();
--> statement-breakpoint

-- Update: what was paid never changes. Status: detected -> confirmed | orphaned, orphaned -> detected (re-mined).
-- Block position may change only while unconfirmed (re-mined in another block). Confirmed is final.
CREATE FUNCTION payment_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.livemode, NEW.invoice_id, NEW.chain_id, NEW.token_id, NEW.tx_hash, NEW.log_index,
      NEW.from_address, NEW.to_address, NEW.amount, NEW.required_confirmations, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.merchant_id, OLD.livemode, OLD.invoice_id, OLD.chain_id, OLD.token_id, OLD.tx_hash, OLD.log_index,
      OLD.from_address, OLD.to_address, OLD.amount, OLD.required_confirmations, OLD.created_at) THEN
    RAISE EXCEPTION 'payment identity and amount are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'confirmed' THEN
    RAISE EXCEPTION 'confirmed payments are final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'detected' AND NEW.status IN ('confirmed', 'orphaned'))
    OR (OLD.status = 'orphaned' AND NEW.status = 'detected')) THEN
    RAISE EXCEPTION 'illegal payment transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payments_update_guard BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION payment_update_guard();
