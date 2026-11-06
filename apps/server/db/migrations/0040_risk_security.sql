-- MONEY-CRITICAL
-- Risk hooks (M9, D-094). A held invoice's payments are confirmed (and booked) but it is not paid: only an admin moves
-- it on, to the status its confirmed total classifies as (release) or to failed (reject). Keep in sync with
-- INVOICE_TRANSITIONS in packages/core/src/invoice.ts (test: "DB transition table matches core").
INSERT INTO invoice_transitions (from_status, to_status) VALUES
  ('confirming', 'held'),
  ('held', 'paid'),
  ('held', 'overpaid'),
  ('held', 'underpaid'),
  ('held', 'failed');
--> statement-breakpoint

-- Limits: tenant isolation like every merchant table; rows are replaced, never deleted.
ALTER TABLE merchant_risk_limits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON merchant_risk_limits TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id())
  WITH CHECK (app_is_system() OR merchant_id = app_merchant_id());
--> statement-breakpoint
CREATE POLICY readonly_all ON merchant_risk_limits FOR SELECT TO gw_readonly USING (true);
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON merchant_risk_limits FROM gw_app;
--> statement-breakpoint

-- Blocked payer addresses: platform-wide (no merchant column), written only from the admin console in system context.
-- Unblocking deletes the row; the audit log keeps who did it and why.
REVOKE UPDATE, TRUNCATE ON risk_blocked_addresses FROM gw_app;
