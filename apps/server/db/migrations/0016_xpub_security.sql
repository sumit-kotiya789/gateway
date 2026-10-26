-- MONEY-CRITICAL
-- Guards for pending xpub changes (live cooldown, D-075) and the ownership proof timestamp.

ALTER TABLE xpub_changes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON xpub_changes TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id())
  WITH CHECK (app_is_system() OR merchant_id = app_merchant_id());
--> statement-breakpoint
CREATE POLICY readonly_all ON xpub_changes FOR SELECT TO gw_readonly USING (true);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON xpub_changes FROM gw_app;
--> statement-breakpoint

-- A change request is a record: only its resolution may be written, once, and only out of `pending`.
CREATE FUNCTION xpub_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.family, NEW.livemode, NEW.xpub, NEW.key_fingerprint, NEW.requested_by,
      NEW.ownership_proved_at, NEW.activates_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.merchant_id, OLD.family, OLD.livemode, OLD.xpub, OLD.key_fingerprint, OLD.requested_by,
      OLD.ownership_proved_at, OLD.activates_at, OLD.created_at) THEN
    RAISE EXCEPTION 'xpub change request is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'xpub change request is already resolved' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER xpub_changes_guard BEFORE UPDATE ON xpub_changes FOR EACH ROW EXECUTE FUNCTION xpub_change_guard();
--> statement-breakpoint

-- Ownership proof is recorded once, never rewritten or removed.
CREATE OR REPLACE FUNCTION xpub_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.next_index < OLD.next_index THEN
    RAISE EXCEPTION 'derivation index cannot move backwards' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.xpub IS DISTINCT FROM OLD.xpub OR NEW.key_fingerprint IS DISTINCT FROM OLD.key_fingerprint
     OR NEW.family IS DISTINCT FROM OLD.family OR NEW.livemode IS DISTINCT FROM OLD.livemode THEN
    RAISE EXCEPTION 'extended key identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Nested: wallet_accounts has no ownership_proved_at, and PL/pgSQL evaluates every field of an AND chain.
  IF TG_TABLE_NAME = 'merchant_xpubs' THEN
    IF OLD.ownership_proved_at IS NOT NULL AND NEW.ownership_proved_at IS DISTINCT FROM OLD.ownership_proved_at THEN
      RAISE EXCEPTION 'ownership proof is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- One key, one owner, now also across pending change requests: a key waiting out its cooldown for one merchant
-- cannot be registered by another merchant (or the platform) in the meantime. The same merchant's pending key may
-- of course become its active key.
CREATE OR REPLACE FUNCTION key_fingerprint_unique() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME <> 'wallet_accounts' AND EXISTS (SELECT 1 FROM wallet_accounts WHERE key_fingerprint = NEW.key_fingerprint) THEN
    RAISE EXCEPTION 'extended key already registered' USING ERRCODE = 'unique_violation';
  END IF;
  IF TG_TABLE_NAME <> 'merchant_xpubs' AND EXISTS (SELECT 1 FROM merchant_xpubs WHERE key_fingerprint = NEW.key_fingerprint) THEN
    RAISE EXCEPTION 'extended key already registered' USING ERRCODE = 'unique_violation';
  END IF;
  -- Separate branches: wallet_accounts has no merchant_id, and NEW.merchant_id would be evaluated even if unused.
  IF TG_TABLE_NAME = 'wallet_accounts' THEN
    IF EXISTS (SELECT 1 FROM xpub_changes WHERE key_fingerprint = NEW.key_fingerprint AND status = 'pending') THEN
      RAISE EXCEPTION 'extended key already registered' USING ERRCODE = 'unique_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'merchant_xpubs' THEN
    IF EXISTS (SELECT 1 FROM xpub_changes WHERE key_fingerprint = NEW.key_fingerprint AND status = 'pending'
               AND merchant_id <> NEW.merchant_id) THEN
      RAISE EXCEPTION 'extended key already registered' USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER xpub_changes_fingerprint BEFORE INSERT ON xpub_changes FOR EACH ROW EXECUTE FUNCTION key_fingerprint_unique();
