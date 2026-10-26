-- Email tokens and outbox (M10): tenant isolation, no deletes, single-use tokens, final delivery states.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['email_tokens', 'email_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant ON %I TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id()) '
      'WITH CHECK (app_is_system() OR merchant_id = app_merchant_id())', t);
    EXECUTE format('CREATE POLICY readonly_all ON %I FOR SELECT TO gw_readonly USING (true)', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM gw_app', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- A token is used at most once and never changes otherwise (an attacker with app-level SQL cannot revive one).
CREATE FUNCTION email_token_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.user_id, NEW.purpose, NEW.token_hash, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.merchant_id, OLD.user_id, OLD.purpose, OLD.token_hash, OLD.expires_at, OLD.created_at)
     OR OLD.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'email token is immutable once used' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER email_tokens_guard BEFORE UPDATE ON email_tokens FOR EACH ROW EXECUTE FUNCTION email_token_guard();
--> statement-breakpoint

-- Sent and failed are final; what was sent (kind, merchant) never changes.
CREATE FUNCTION email_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.kind, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.merchant_id, OLD.kind, OLD.created_at)
     OR OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'email outbox row is final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER email_outbox_guard BEFORE UPDATE ON email_outbox FOR EACH ROW EXECUTE FUNCTION email_outbox_guard();
