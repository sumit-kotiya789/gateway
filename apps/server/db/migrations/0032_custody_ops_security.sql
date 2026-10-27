-- MONEY-CRITICAL
-- Custodial operations (M7b/c, D-088): the signer's own database role, and guards on platform wallets, sweeps and
-- signatures. The app (gw_app) can read signatures but never write them: only the signer records what it signed.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gw_signer') THEN CREATE ROLE gw_signer NOLOGIN; END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO gw_signer;
--> statement-breakpoint

-- What the signer may read to check an intent, and the one table it writes.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chains', 'tokens', 'wallet_accounts', 'deposit_addresses', 'invoices', 'payments', 'sweeps',
                           'platform_wallets', 'signer_controls', 'signer_signatures'] LOOP
    EXECUTE format('GRANT SELECT ON %I TO gw_signer', t);
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = format('public.%I', t)::regclass) THEN
      EXECUTE format('CREATE POLICY signer_read ON %I FOR SELECT TO gw_signer USING (true)', t);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
GRANT INSERT ON signer_signatures TO gw_signer;
--> statement-breakpoint

-- Signatures: written by the signer only, then never changed.
ALTER TABLE signer_signatures ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY signer_read ON signer_signatures FOR SELECT TO gw_signer USING (true);
--> statement-breakpoint
CREATE POLICY signer_write ON signer_signatures FOR INSERT TO gw_signer WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY system_read ON signer_signatures FOR SELECT TO gw_app USING (app_is_system());
--> statement-breakpoint
CREATE POLICY readonly_all ON signer_signatures FOR SELECT TO gw_readonly USING (true);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON signer_signatures FROM gw_app;
--> statement-breakpoint
CREATE TRIGGER signer_signatures_append_only BEFORE UPDATE OR DELETE ON signer_signatures FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER signer_signatures_no_truncate BEFORE TRUNCATE ON signer_signatures FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

-- Platform wallets and the signer switch: system context only (admin and worker code paths).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_wallets', 'signer_controls'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY system_only ON %I TO gw_app USING (app_is_system()) WITH CHECK (app_is_system())', t);
    EXECUTE format('CREATE POLICY readonly_all ON %I FOR SELECT TO gw_readonly USING (true)', t);
    EXECUTE format('CREATE POLICY signer_read ON %I FOR SELECT TO gw_signer USING (true)', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM gw_app', t);
  END LOOP;
END $$;
--> statement-breakpoint
INSERT INTO signer_controls (id, paused) VALUES (1, false);
--> statement-breakpoint

-- A platform wallet never changes; it can only be retired, once.
CREATE FUNCTION platform_wallet_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.family, NEW.livemode, NEW.kind, NEW.address, NEW.derivation_path, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.family, OLD.livemode, OLD.kind, OLD.address, OLD.derivation_path, OLD.created_at)
     OR OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'platform wallets are immutable; retire and register a new one' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER platform_wallets_guard BEFORE UPDATE ON platform_wallets FOR EACH ROW EXECUTE FUNCTION platform_wallet_guard();
--> statement-breakpoint

-- Sweeps: tenant isolation, no deletes; what is swept, from and to where, never changes; status only moves forward.
ALTER TABLE sweeps ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON sweeps TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id())
  WITH CHECK (app_is_system() OR merchant_id = app_merchant_id());
--> statement-breakpoint
CREATE POLICY readonly_all ON sweeps FOR SELECT TO gw_readonly USING (true);
--> statement-breakpoint
CREATE POLICY signer_read ON sweeps FOR SELECT TO gw_signer USING (true);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON sweeps FROM gw_app;
--> statement-breakpoint
CREATE FUNCTION sweep_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d deposit_addresses; i invoices; w platform_wallets;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO d FROM deposit_addresses WHERE id = NEW.deposit_address_id;
    SELECT * INTO i FROM invoices WHERE id = NEW.invoice_id;
    SELECT * INTO w FROM platform_wallets WHERE kind = 'hot' AND family = d.family AND livemode = NEW.livemode AND retired_at IS NULL;
    IF d.source <> 'platform' OR d.merchant_id <> NEW.merchant_id OR d.livemode <> NEW.livemode OR d.chain_id <> NEW.chain_id
       OR lower(d.address) <> lower(NEW.from_address) OR i.deposit_address_id <> d.id OR i.custody_mode <> 'custodial'
       OR i.token_id <> NEW.token_id OR w.id IS NULL OR lower(w.address) <> lower(NEW.to_address) OR NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'sweep must move a custodial deposit address into the active hot wallet' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.merchant_id, NEW.livemode, NEW.chain_id, NEW.token_id, NEW.deposit_address_id, NEW.invoice_id,
      NEW.from_address, NEW.to_address, NEW.amount, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.merchant_id, OLD.livemode, OLD.chain_id, OLD.token_id, OLD.deposit_address_id, OLD.invoice_id,
      OLD.from_address, OLD.to_address, OLD.amount, OLD.created_at)
     OR OLD.status IN ('confirmed', 'failed')
     OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (
          (OLD.status = 'pending' AND NEW.status IN ('gas_sent', 'sweep_sent', 'failed'))
       OR (OLD.status = 'gas_sent' AND NEW.status IN ('sweep_sent', 'failed'))
       OR (OLD.status = 'sweep_sent' AND NEW.status IN ('confirmed', 'failed')))) THEN
    RAISE EXCEPTION 'sweep identity is immutable and its status only moves forward' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sweeps_guard BEFORE INSERT OR UPDATE ON sweeps FOR EACH ROW EXECUTE FUNCTION sweep_guard();
