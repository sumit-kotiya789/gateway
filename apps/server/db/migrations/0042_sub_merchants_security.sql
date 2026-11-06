-- MONEY-CRITICAL
-- Marketplace sellers (M9, D-095): tenant isolation, a seller's identity never changes, an invoice keeps its seller,
-- events carry the seller, and a seller-scoped webhook endpoint only gets that seller's events.

ALTER TABLE sub_merchants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON sub_merchants TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id())
  WITH CHECK (app_is_system() OR merchant_id = app_merchant_id());
--> statement-breakpoint
CREATE POLICY readonly_all ON sub_merchants FOR SELECT TO gw_readonly USING (true);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON sub_merchants FROM gw_app;
--> statement-breakpoint
CREATE FUNCTION sub_merchant_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.livemode, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.merchant_id, OLD.livemode, OLD.created_at) THEN
    RAISE EXCEPTION 'sub-merchant identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sub_merchants_identity BEFORE UPDATE ON sub_merchants FOR EACH ROW EXECUTE FUNCTION sub_merchant_identity_immutable();
--> statement-breakpoint

-- Invoice update guard (previous version: 0018), now also covering the seller.
CREATE OR REPLACE FUNCTION invoice_update_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.livemode, NEW.chain_id, NEW.token_id, NEW.amount_expected, NEW.deposit_address_id,
      NEW.deposit_address, NEW.custody_mode, NEW.underpay_tolerance_bps, NEW.fee_bps, NEW.fee_fixed, NEW.external_order_id,
      NEW.payment_link_id, NEW.sub_merchant_id, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.merchant_id, OLD.livemode, OLD.chain_id, OLD.token_id, OLD.amount_expected, OLD.deposit_address_id,
      OLD.deposit_address, OLD.custody_mode, OLD.underpay_tolerance_bps, OLD.fee_bps, OLD.fee_fixed, OLD.external_order_id,
      OLD.payment_link_id, OLD.sub_merchant_id, OLD.expires_at, OLD.created_at) THEN
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

-- Outbox writer (previous version: 0011): events also carry the seller (null for the merchant's own invoices).
CREATE OR REPLACE FUNCTION invoice_outbox_writer() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'created' THEN
    INSERT INTO outbox_events (merchant_id, livemode, type, invoice_id, data)
    VALUES (NEW.merchant_id, NEW.livemode, 'invoice.' || NEW.status, NEW.id, jsonb_build_object(
      'invoice_id', NEW.id, 'status', NEW.status, 'previous_status', OLD.status, 'token', NEW.token_id,
      'amount_expected', NEW.amount_expected::text, 'amount_received', NEW.amount_received::text,
      'fee_amount', NEW.fee_amount::text, 'external_order_id', NEW.external_order_id,
      'sub_merchant_id', NEW.sub_merchant_id,
      'reason', coalesce(nullif(current_setting('app.transition_reason', true), ''), 'unspecified')));
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

-- Fan-out (previous version: 0014): an endpoint scoped to a seller gets only that seller's invoice events.
CREATE OR REPLACE FUNCTION outbox_webhook_fanout() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO webhook_deliveries (endpoint_id, merchant_id, event_id)
  SELECT w.id, NEW.merchant_id, NEW.id FROM webhook_endpoints w
  WHERE w.merchant_id = NEW.merchant_id AND w.livemode = NEW.livemode
    AND (w.sub_merchant_id IS NULL OR w.sub_merchant_id::text = NEW.data ->> 'sub_merchant_id');
  RETURN NULL;
END $$;
