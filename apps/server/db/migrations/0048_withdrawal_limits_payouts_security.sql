-- MONEY-CRITICAL
-- Merchant withdrawal limits, payout fee and payouts to the merchant's users (D-100). The database enforces the same
-- rules as the app, so a bug or a direct write cannot get around them:
--  * limits: one withdrawal at most per_tx, at most per_day over any 24 hours (all withdrawals of the merchant in that
--    mode and token that are not failed, rejected or cancelled); live user payouts need both limits set;
--  * a user payout (kind customer) is auto-approved, never goes to a platform wallet, a deposit address or a blocked
--    address, and carries exactly the merchant's payout fee;
--  * the confirmed payout books its fee to the platform (ledger_entry_guard); events are payout.<status>.
-- Functions replaced whole from their current versions (withdrawal_guard and withdrawal_outbox_writer 0036,
-- ledger_entry_guard 0044).

-- Limits: tenant isolation like every merchant table; rows are updated in place (null = no limit), never deleted.
ALTER TABLE merchant_withdrawal_limits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON merchant_withdrawal_limits TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id())
  WITH CHECK (app_is_system() OR merchant_id = app_merchant_id());
--> statement-breakpoint
CREATE POLICY readonly_all ON merchant_withdrawal_limits FOR SELECT TO gw_readonly USING (true);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON merchant_withdrawal_limits FROM gw_app;
--> statement-breakpoint
-- The signer re-checks limits and the payout destination before it signs.
GRANT SELECT ON merchant_withdrawal_limits TO gw_signer;
--> statement-breakpoint
CREATE POLICY signer_read ON merchant_withdrawal_limits FOR SELECT TO gw_signer USING (true);
--> statement-breakpoint
GRANT SELECT ON risk_blocked_addresses TO gw_signer;
--> statement-breakpoint

-- Where a payout to a user may go: never a platform wallet, any deposit address (of any merchant) or a blocked address.
-- SECURITY DEFINER so the app (tenant context, which cannot see those rows) and the signer get the same answer; it
-- only returns a boolean.
CREATE FUNCTION payout_destination_allowed(addr text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM platform_wallets WHERE lower(address) = lower(addr))
     AND NOT EXISTS (SELECT 1 FROM deposit_addresses WHERE family = 'evm' AND lower(address) = lower(addr))
     AND NOT EXISTS (SELECT 1 FROM risk_blocked_addresses WHERE lower(address) = lower(addr));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION payout_destination_allowed(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION payout_destination_allowed(text) TO gw_app, gw_signer;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION withdrawal_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a payout_addresses; m merchants; cur uuid; l merchant_withdrawal_limits; dec integer; day numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO m FROM merchants WHERE id = NEW.merchant_id;
    IF m.custody_mode <> 'custodial' OR m.status <> 'active' OR 'payouts_frozen' = ANY (m.risk_flags)
       OR cardinality(NEW.approved_by) <> 0
       OR NEW.status <> (CASE WHEN NEW.approvals_required = 0 THEN 'approved' ELSE 'pending_approval' END)::withdrawal_status THEN
      RAISE EXCEPTION 'withdrawals are for active, unfrozen custodial merchants' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.kind = 'merchant' THEN
      SELECT * INTO a FROM payout_addresses WHERE id = NEW.payout_address_id;
      SELECT id INTO cur FROM payout_addresses
        WHERE merchant_id = NEW.merchant_id AND livemode = NEW.livemode AND family = a.family AND cancelled_at IS NULL AND activates_at <= now()
        ORDER BY activates_at DESC, created_at DESC LIMIT 1;
      IF cur IS DISTINCT FROM NEW.payout_address_id OR lower(a.address) <> lower(NEW.to_address) THEN
        RAISE EXCEPTION 'withdrawal must go to the current payout address' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      SELECT decimals INTO dec FROM tokens WHERE id = NEW.token_id;
      IF NEW.approvals_required <> 0
         OR NEW.fee <> trunc(m.payout_fee * power(10::numeric, dec))
         OR NOT payout_destination_allowed(NEW.to_address) THEN
        RAISE EXCEPTION 'payout to a user: auto-approved, the merchant payout fee, never to a platform, deposit or blocked address'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    SELECT * INTO l FROM merchant_withdrawal_limits WHERE merchant_id = NEW.merchant_id AND livemode = NEW.livemode AND token_id = NEW.token_id;
    IF NEW.kind = 'customer' AND NEW.livemode AND (l.per_tx IS NULL OR l.per_day IS NULL) THEN
      RAISE EXCEPTION 'live payouts to users need both withdrawal limits set' USING ERRCODE = 'check_violation';
    END IF;
    IF l.per_tx IS NOT NULL AND NEW.amount > l.per_tx THEN
      RAISE EXCEPTION 'withdrawal above the merchant one-time limit' USING ERRCODE = 'check_violation';
    END IF;
    IF l.per_day IS NOT NULL THEN
      SELECT coalesce(sum(amount), 0) INTO day FROM withdrawals
        WHERE merchant_id = NEW.merchant_id AND livemode = NEW.livemode AND token_id = NEW.token_id
          AND status NOT IN ('failed', 'rejected', 'cancelled') AND created_at > now() - interval '24 hours';
      IF day + NEW.amount > l.per_day THEN
        RAISE EXCEPTION 'withdrawal above the merchant daily limit' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.merchant_id, NEW.livemode, NEW.chain_id, NEW.token_id, NEW.amount, NEW.kind, NEW.payout_address_id,
      NEW.customer_ref, NEW.to_address, NEW.fee, NEW.approvals_required, NEW.requested_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.merchant_id, OLD.livemode, OLD.chain_id, OLD.token_id, OLD.amount, OLD.kind, OLD.payout_address_id,
      OLD.customer_ref, OLD.to_address, OLD.fee, OLD.approvals_required, OLD.requested_by, OLD.created_at)
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

-- Webhook events: withdrawal.<status> for the merchant's own withdrawals, payout.<status> for payouts to its users.
CREATE OR REPLACE FUNCTION withdrawal_outbox_writer() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO outbox_events (merchant_id, livemode, type, invoice_id, data)
    VALUES (NEW.merchant_id, NEW.livemode, (CASE WHEN NEW.kind = 'customer' THEN 'payout.' ELSE 'withdrawal.' END) || NEW.status, NULL, jsonb_build_object(
      'withdrawal_id', NEW.id, 'kind', NEW.kind, 'customer_ref', NEW.customer_ref, 'status', NEW.status,
      'previous_status', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
      'token', NEW.token_id, 'amount', NEW.amount::text, 'fee', NEW.fee::text, 'to_address', NEW.to_address, 'tx_hash', NEW.tx_hash));
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

-- A confirmed payout to a user also books its fee: merchant_withdrawing +(amount + fee), custody_hot -amount,
-- platform_fee_revenue -fee (the fee stays in the hot wallet as platform money).
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
    WHEN j.kind = 'withdrawal' THEN ARRAY['merchant_withdrawing', 'custody_hot', 'platform_fee_revenue']
    WHEN j.kind = 'withdrawal_release' THEN ARRAY['merchant_withdrawing', 'merchant_available']
    WHEN j.kind = 'treasury' THEN ARRAY['custody_hot', 'custody_cold']
    WHEN j.kind = 'forward_fee' AND mode = 'non_custodial_forwarder'
      THEN ARRAY['merchant_received', 'merchant_sales', 'platform_fee_wallet', 'platform_fee_revenue']
    ELSE ARRAY[]::text[]
  END;
  IF NOT (a.kind::text = ANY (allowed)) THEN
    RAISE EXCEPTION 'account % is not allowed in a % journal', a.kind, j.kind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
