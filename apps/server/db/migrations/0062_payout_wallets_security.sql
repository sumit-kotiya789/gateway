-- MONEY-CRITICAL
-- Payout wallets (D-114): a self withdrawal may go to ANY of the merchant's active payout addresses, not only the
-- newest. Still only the merchant's own, in its mode and the chain's family, activated (live: 24 h after being added,
-- owners emailed) and not removed. And an active address can now be removed (cancelled once); its other fields stay
-- immutable. withdrawal_guard is replaced whole from its 0048 version; only the merchant branch changed.

CREATE OR REPLACE FUNCTION payout_address_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.livemode, NEW.family, NEW.address, NEW.label, NEW.created_by, NEW.activates_at, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.merchant_id, OLD.livemode, OLD.family, OLD.address, OLD.label, OLD.created_by, OLD.activates_at, OLD.created_at)
     OR OLD.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'payout addresses are immutable; one can only be cancelled or removed, once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION withdrawal_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a payout_addresses; m merchants; l merchant_withdrawal_limits; dec integer; day numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO m FROM merchants WHERE id = NEW.merchant_id;
    IF m.custody_mode <> 'custodial' OR m.status <> 'active' OR 'payouts_frozen' = ANY (m.risk_flags)
       OR cardinality(NEW.approved_by) <> 0
       OR NEW.status <> (CASE WHEN NEW.approvals_required = 0 THEN 'approved' ELSE 'pending_approval' END)::withdrawal_status THEN
      RAISE EXCEPTION 'withdrawals are for active, unfrozen custodial merchants' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.kind = 'merchant' THEN
      -- One of the merchant's own payout wallets (D-114): this mode, the chain's family, activated, not removed.
      SELECT * INTO a FROM payout_addresses WHERE id = NEW.payout_address_id;
      IF a.id IS NULL OR a.merchant_id <> NEW.merchant_id OR a.livemode <> NEW.livemode
         OR a.family <> (SELECT family FROM chains WHERE id = NEW.chain_id)
         OR a.cancelled_at IS NOT NULL OR a.activates_at > now() OR lower(a.address) <> lower(NEW.to_address) THEN
        RAISE EXCEPTION 'withdrawal must go to one of the merchant''s active payout addresses' USING ERRCODE = 'check_violation';
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
