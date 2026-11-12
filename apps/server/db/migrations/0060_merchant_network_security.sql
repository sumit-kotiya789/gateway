-- Per-merchant network (D-113), chosen by the merchant (dashboard, owner or admin role + 2FA). The database only allows
-- a mainnet: test mode is never restricted, so a testnet here would be meaningless.

CREATE FUNCTION merchant_network_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.allowed_chain_id IS NOT NULL
     AND NEW.allowed_chain_id IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.allowed_chain_id END)
     AND NOT EXISTS (SELECT 1 FROM chains WHERE id = NEW.allowed_chain_id AND NOT testnet) THEN
    RAISE EXCEPTION 'a merchant''s network must be a mainnet' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER merchants_network_guard BEFORE INSERT OR UPDATE ON merchants FOR EACH ROW EXECUTE FUNCTION merchant_network_guard();
