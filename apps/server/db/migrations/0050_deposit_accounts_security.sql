-- MONEY-CRITICAL
-- Permanent deposit addresses per user (D-101). An account ties one of the merchant's users to one deposit address of
-- the merchant, mode and chain, from the source its custody mode uses; each transfer to it becomes a deposit invoice
-- of exactly that account (same merchant, mode, token, address and custody mode; a forwarder account's fee rate).
-- Functions replaced whole from their current versions (invoice_insert_guard 0044, invoice_update_guard 0046,
-- invoice_outbox_writer 0011).

ALTER TABLE deposit_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON deposit_accounts TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id())
  WITH CHECK (app_is_system() OR merchant_id = app_merchant_id());
--> statement-breakpoint
CREATE POLICY readonly_all ON deposit_accounts FOR SELECT TO gw_readonly USING (true);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON deposit_accounts FROM gw_app;
--> statement-breakpoint

CREATE FUNCTION deposit_account_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d deposit_addresses;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO d FROM deposit_addresses WHERE id = NEW.deposit_address_id;
    IF d.id IS NULL OR d.merchant_id <> NEW.merchant_id OR d.livemode <> NEW.livemode OR d.chain_id <> NEW.chain_id
       OR NEW.retired_at IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM tokens WHERE id = NEW.token_id AND chain_id = NEW.chain_id)
       OR (d.source = 'platform') <> (NEW.custody_mode = 'custodial')
       OR (d.source = 'merchant_xpub') <> (NEW.custody_mode = 'non_custodial_xpub')
       OR (d.source = 'forwarder') <> (NEW.custody_mode = 'non_custodial_forwarder')
       OR (d.source = 'forwarder' AND NOT EXISTS (SELECT 1 FROM forwarder_params WHERE deposit_address_id = d.id AND token_id = NEW.token_id))
       OR EXISTS (SELECT 1 FROM invoices WHERE deposit_address_id = d.id) THEN
      RAISE EXCEPTION 'deposit account must use an unused deposit address of the same merchant, mode, chain, token and custody'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- Only retiring, once.
  IF (NEW.id, NEW.merchant_id, NEW.livemode, NEW.customer_ref, NEW.chain_id, NEW.token_id, NEW.custody_mode, NEW.deposit_address_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.merchant_id, OLD.livemode, OLD.customer_ref, OLD.chain_id, OLD.token_id, OLD.custody_mode, OLD.deposit_address_id, OLD.created_at)
     OR OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL THEN
    RAISE EXCEPTION 'a deposit account is immutable; it can only be retired, once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER deposit_accounts_guard BEFORE INSERT OR UPDATE ON deposit_accounts FOR EACH ROW EXECUTE FUNCTION deposit_account_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION invoice_insert_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d deposit_addresses; f forwarder_params; a deposit_accounts;
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
  IF NEW.kind = 'deposit' THEN
    -- A deposit invoice belongs to exactly its account: same merchant, mode, address, token, custody and user.
    SELECT * INTO a FROM deposit_accounts WHERE id = NEW.deposit_account_id;
    IF NOT FOUND OR a.merchant_id <> NEW.merchant_id OR a.livemode <> NEW.livemode OR a.deposit_address_id <> NEW.deposit_address_id
       OR a.token_id <> NEW.token_id OR a.custody_mode <> NEW.custody_mode OR a.customer_ref <> NEW.customer_ref THEN
      RAISE EXCEPTION 'deposit invoice does not match its deposit account' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM deposit_accounts WHERE deposit_address_id = NEW.deposit_address_id) THEN
    RAISE EXCEPTION 'a deposit account address takes deposits only' USING ERRCODE = 'check_violation';
  END IF;
  IF d.source = 'forwarder' OR NEW.custody_mode = 'non_custodial_forwarder' THEN
    SELECT * INTO f FROM forwarder_params WHERE deposit_address_id = d.id;
    -- An invoice's forwarder is capped at the fee on its amount; a user's permanent forwarder is uncapped (D-101).
    IF NOT FOUND OR d.source <> 'forwarder' OR NEW.custody_mode <> 'non_custodial_forwarder'
       OR f.token_id <> NEW.token_id OR f.fee_bps <> NEW.fee_bps OR NEW.fee_fixed <> 0
       OR (NEW.kind = 'payment' AND f.fee_cap <> trunc(NEW.amount_expected * NEW.fee_bps / 10000)) THEN
      RAISE EXCEPTION 'forwarder terms do not match the invoice' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.status_changed_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION invoice_update_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.livemode, NEW.chain_id, NEW.token_id, NEW.amount_expected, NEW.deposit_address_id,
      NEW.deposit_address, NEW.custody_mode, NEW.underpay_tolerance_bps, NEW.fee_bps, NEW.fee_fixed, NEW.external_order_id,
      NEW.payment_link_id, NEW.sub_merchant_id, NEW.kind, NEW.deposit_account_id, NEW.deposit_ref, NEW.customer_ref,
      NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.merchant_id, OLD.livemode, OLD.chain_id, OLD.token_id, OLD.amount_expected, OLD.deposit_address_id,
      OLD.deposit_address, OLD.custody_mode, OLD.underpay_tolerance_bps, OLD.fee_bps, OLD.fee_fixed, OLD.external_order_id,
      OLD.payment_link_id, OLD.sub_merchant_id, OLD.kind, OLD.deposit_account_id, OLD.deposit_ref, OLD.customer_ref,
      OLD.expires_at, OLD.created_at) THEN
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

-- Webhook events: deposits carry the user (customer_ref) and their account, so a web3 project can credit the right
-- user from the event alone.
CREATE OR REPLACE FUNCTION invoice_outbox_writer() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'created' THEN
    INSERT INTO outbox_events (merchant_id, livemode, type, invoice_id, data)
    VALUES (NEW.merchant_id, NEW.livemode, 'invoice.' || NEW.status, NEW.id, jsonb_build_object(
      'invoice_id', NEW.id, 'status', NEW.status, 'previous_status', OLD.status, 'token', NEW.token_id,
      'amount_expected', NEW.amount_expected::text, 'amount_received', NEW.amount_received::text,
      'fee_amount', NEW.fee_amount::text, 'external_order_id', NEW.external_order_id,
      'sub_merchant_id', NEW.sub_merchant_id,
      'kind', NEW.kind, 'deposit_account_id', NEW.deposit_account_id, 'customer_ref', NEW.customer_ref,
      'reason', coalesce(nullif(current_setting('app.transition_reason', true), ''), 'unspecified')));
  END IF;
  RETURN NULL;
END $$;
