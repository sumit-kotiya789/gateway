-- MONEY-CRITICAL
-- Merchant whitelists (D-109) and API key analytics (D-110). Tenant tables (RLS), never deleted. The database refuses
-- a customer payout to an address that is not an active whitelisted address while the merchant's address whitelist is
-- on for that mode, and refuses switching a whitelist off before its scheduled time.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['merchant_security_settings', 'whitelisted_addresses', 'api_key_usage', 'api_key_clients'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %I TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id()) WITH CHECK (app_is_system() OR merchant_id = app_merchant_id())', t);
    EXECUTE format('CREATE POLICY readonly_all ON %I FOR SELECT TO gw_readonly USING (true)', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM gw_app', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- A whitelist that is on stays on until its scheduled switch-off time has passed.
CREATE FUNCTION merchant_security_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.addresses_live AND NOT NEW.addresses_live AND (OLD.addresses_live_disable_at IS NULL OR OLD.addresses_live_disable_at > now()))
     OR (OLD.addresses_test AND NOT NEW.addresses_test AND (OLD.addresses_test_disable_at IS NULL OR OLD.addresses_test_disable_at > now()))
     OR (OLD.ips AND NOT NEW.ips AND (OLD.ips_disable_at IS NULL OR OLD.ips_disable_at > now())) THEN
    RAISE EXCEPTION 'a whitelist can only be switched off once its scheduled time has passed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.merchant_id IS DISTINCT FROM OLD.merchant_id THEN
    RAISE EXCEPTION 'merchant_id is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER merchant_security_guard BEFORE UPDATE ON merchant_security_settings FOR EACH ROW EXECUTE FUNCTION merchant_security_guard();
--> statement-breakpoint

-- A whitelisted address is immutable; it can only be removed, once.
CREATE FUNCTION whitelisted_address_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.livemode, NEW.family, NEW.address, NEW.label, NEW.created_by, NEW.created_at, NEW.activates_at)
     IS DISTINCT FROM (OLD.id, OLD.merchant_id, OLD.livemode, OLD.family, OLD.address, OLD.label, OLD.created_by, OLD.created_at, OLD.activates_at)
     OR OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL THEN
    RAISE EXCEPTION 'a whitelisted address is immutable; it can only be removed, once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER whitelisted_address_guard BEFORE UPDATE ON whitelisted_addresses FOR EACH ROW EXECUTE FUNCTION whitelisted_address_guard();
--> statement-breakpoint

-- Customer payouts (D-100) while the address whitelist is on for that mode: only to an active whitelisted address.
CREATE FUNCTION withdrawal_whitelist_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s merchant_security_settings; c chains; is_on boolean;
BEGIN
  IF NEW.kind <> 'customer' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO s FROM merchant_security_settings WHERE merchant_id = NEW.merchant_id;
  IF s.merchant_id IS NULL THEN
    RETURN NEW;
  END IF;
  is_on := CASE WHEN NEW.livemode
    THEN s.addresses_live AND (s.addresses_live_disable_at IS NULL OR s.addresses_live_disable_at > now())
    ELSE s.addresses_test AND (s.addresses_test_disable_at IS NULL OR s.addresses_test_disable_at > now()) END;
  IF NOT is_on THEN
    RETURN NEW;
  END IF;
  SELECT * INTO c FROM chains WHERE id = NEW.chain_id;
  IF NOT EXISTS (
    SELECT 1 FROM whitelisted_addresses w
    WHERE w.merchant_id = NEW.merchant_id AND w.livemode = NEW.livemode AND w.family = c.family::text
      AND lower(w.address) = lower(NEW.to_address) AND w.removed_at IS NULL AND w.activates_at <= now()) THEN
    RAISE EXCEPTION 'payouts go only to active whitelisted addresses while the address whitelist is on' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER withdrawal_whitelist_guard BEFORE INSERT ON withdrawals FOR EACH ROW EXECUTE FUNCTION withdrawal_whitelist_guard();
