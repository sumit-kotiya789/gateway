-- Team invitations and membership changes (M10).

ALTER TABLE team_invites ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON team_invites TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id())
  WITH CHECK (app_is_system() OR merchant_id = app_merchant_id());
--> statement-breakpoint
CREATE POLICY readonly_all ON team_invites FOR SELECT TO gw_readonly USING (true);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON team_invites FROM gw_app;
--> statement-breakpoint

-- An invitation is closed once (accepted or revoked) and otherwise never changes: who was invited, with which role.
CREATE FUNCTION team_invite_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.email, NEW.role, NEW.token_hash, NEW.invited_by, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.merchant_id, OLD.email, OLD.role, OLD.token_hash, OLD.invited_by, OLD.expires_at, OLD.created_at)
     OR OLD.accepted_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'team invite is immutable once closed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER team_invites_guard BEFORE UPDATE ON team_invites FOR EACH ROW EXECUTE FUNCTION team_invite_guard();
--> statement-breakpoint

-- Every merchant keeps at least one active owner (checked at commit, so a swap within one transaction is fine).
-- SECURITY DEFINER: sees the merchant's other users regardless of RLS context.
CREATE FUNCTION merchant_keeps_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.role = 'owner' AND OLD.removed_at IS NULL AND NOT EXISTS (
       SELECT 1 FROM merchant_users WHERE merchant_id = NEW.merchant_id AND role = 'owner' AND removed_at IS NULL) THEN
    RAISE EXCEPTION 'merchant % would have no active owner', NEW.merchant_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER merchant_users_keep_owner AFTER UPDATE OF role, removed_at ON merchant_users DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION merchant_keeps_owner();
