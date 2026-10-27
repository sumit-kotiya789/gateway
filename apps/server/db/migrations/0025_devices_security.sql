-- Known sign-in devices (M10): tenant isolation, no deletes, a device stays bound to its user and token.

ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON user_devices TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id())
  WITH CHECK (app_is_system() OR merchant_id = app_merchant_id());
--> statement-breakpoint
CREATE POLICY readonly_all ON user_devices FOR SELECT TO gw_readonly USING (true);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON user_devices FROM gw_app;
--> statement-breakpoint

-- Only when and from where it was last seen change.
CREATE FUNCTION user_device_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.merchant_id, NEW.user_id, NEW.token_hash, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.merchant_id, OLD.user_id, OLD.token_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'user device identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER user_devices_guard BEFORE UPDATE ON user_devices FOR EACH ROW EXECUTE FUNCTION user_device_guard();
