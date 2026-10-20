-- Security layer: roles, grants, append-only audit log with hash chain, row-level security.
-- Runs as the schema owner (migration role). The application connects as a LOGIN user that is a member of gw_app.

-- Group roles (NOLOGIN). Login users are created per environment and granted one of these.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gw_app') THEN CREATE ROLE gw_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gw_readonly') THEN CREATE ROLE gw_readonly NOLOGIN; END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO gw_app, gw_readonly;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gw_app;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO gw_readonly;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gw_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gw_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO gw_readonly;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO gw_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint

-- Append-only enforcement, reusable for ledger_entries later. Privileges AND trigger: the trigger also stops the owner.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM gw_app;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update_delete BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

-- Tamper-evident hash chain: hash = sha256(prev_hash || canonical_payload).
-- jsonb text output is deterministic (sorted keys); timestamps are hashed as epoch microseconds so the
-- session TimeZone cannot change the payload.
CREATE FUNCTION audit_payload(r audit_logs) RETURNS bytea LANGUAGE sql STABLE AS $$
  SELECT convert_to(jsonb_build_object(
    'seq', r.seq, 'id', r.id, 'at_us', (extract(epoch FROM r.at) * 1000000)::bigint,
    'actor_type', r.actor_type, 'actor_id', r.actor_id, 'merchant_id', r.merchant_id,
    'action', r.action, 'target_type', r.target_type, 'target_id', r.target_id,
    'ip', host(r.ip), 'user_agent', r.user_agent, 'request_id', r.request_id,
    'before', r.before, 'after', r.after
  )::text, 'UTF8')
$$;
--> statement-breakpoint
-- SECURITY DEFINER: runs as the table owner so it sees every tenant's rows (RLS) when linking the chain.
-- The transaction-scoped advisory lock serializes appends; seq is gap-free (a rolled-back insert frees its seq).
CREATE FUNCTION audit_chain() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  last_seq bigint;
  last_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(7342001);
  SELECT seq, hash INTO last_seq, last_hash FROM audit_logs ORDER BY seq DESC LIMIT 1;
  NEW.seq := COALESCE(last_seq, 0) + 1;
  NEW.at := clock_timestamp();
  NEW.prev_hash := COALESCE(last_hash, decode(repeat('00', 32), 'hex'));
  NEW.hash := sha256(NEW.prev_hash || audit_payload(NEW));
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_chain BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_chain();
--> statement-breakpoint
-- Returns the first seq whose link or hash does not verify, or NULL if the whole chain is intact.
CREATE FUNCTION audit_verify() RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r audit_logs;
  prev bytea := decode(repeat('00', 32), 'hex');
  expected bigint := 1;
BEGIN
  FOR r IN SELECT * FROM audit_logs ORDER BY seq LOOP
    IF r.seq <> expected OR r.prev_hash <> prev OR r.hash <> sha256(prev || audit_payload(r)) THEN
      RETURN r.seq;
    END IF;
    prev := r.hash;
    expected := expected + 1;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION audit_verify() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit_verify() TO gw_app;
--> statement-breakpoint

-- Row-level security: second isolation layer behind repository scoping. The app sets, per transaction,
-- app.merchant_id (tenant context) or app.system = 'on' (cross-tenant system context). Neither set = no rows.
-- This guards against forgotten WHERE clauses; it is not a boundary against arbitrary SQL execution.
CREATE FUNCTION app_merchant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.merchant_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION app_is_system() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.system', true), '') = 'on'
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_merchant_id(), app_is_system() TO gw_app, gw_readonly;
--> statement-breakpoint
ALTER TABLE merchants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON merchants TO gw_app
  USING (app_is_system() OR id = app_merchant_id())
  WITH CHECK (app_is_system() OR id = app_merchant_id());
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['merchant_users', 'recovery_codes', 'sessions', 'api_keys', 'audit_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant ON %I TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id()) '
      'WITH CHECK (app_is_system() OR merchant_id = app_merchant_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['merchants', 'merchant_users', 'api_keys', 'audit_logs'] LOOP
    EXECUTE format('CREATE POLICY readonly_all ON %I FOR SELECT TO gw_readonly USING (true)', t);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY system_only ON admin_users TO gw_app USING (app_is_system()) WITH CHECK (app_is_system());
