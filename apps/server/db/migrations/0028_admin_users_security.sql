-- Admin accounts managed from the console (M9): an active superadmin always remains, and the session epoch only goes up.

-- Checked at commit, so a swap within one transaction is fine. SECURITY DEFINER: sees every admin regardless of RLS.
CREATE FUNCTION admin_keeps_superadmin() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.role = 'superadmin' AND OLD.disabled_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM admin_users WHERE role = 'superadmin' AND disabled_at IS NULL) THEN
    RAISE EXCEPTION 'no active superadmin would remain' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER admin_users_keep_superadmin AFTER UPDATE OF role, disabled_at ON admin_users DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION admin_keeps_superadmin();
--> statement-breakpoint

-- A lowered epoch would revive tokens that a credential reset signed out.
CREATE FUNCTION admin_epoch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.session_epoch < OLD.session_epoch THEN
    RAISE EXCEPTION 'admin session epoch cannot go down' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER admin_users_epoch_guard BEFORE UPDATE OF session_epoch ON admin_users FOR EACH ROW EXECUTE FUNCTION admin_epoch_guard();
