-- Admin console settings (D-106): system context only (admin console code paths), one row, never deleted.
-- Changes are made by a superadmin with step-up 2FA and audited in the same transaction.

ALTER TABLE admin_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY system_only ON admin_settings TO gw_app USING (app_is_system()) WITH CHECK (app_is_system());
--> statement-breakpoint
CREATE POLICY readonly_all ON admin_settings FOR SELECT TO gw_readonly USING (true);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON admin_settings FROM gw_app;
--> statement-breakpoint
INSERT INTO admin_settings (id) VALUES (1);
