-- Tenant isolation for webhook endpoints (they carry an encrypted signing secret).
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON webhook_endpoints TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id())
  WITH CHECK (app_is_system() OR merchant_id = app_merchant_id());
--> statement-breakpoint
CREATE POLICY readonly_all ON webhook_endpoints FOR SELECT TO gw_readonly USING (true);
