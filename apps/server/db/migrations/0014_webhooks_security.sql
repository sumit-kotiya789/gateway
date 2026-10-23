-- Webhook delivery guards. Delivery rows are created only by the outbox trigger, in the same transaction as the event,
-- so an event can never be committed without its deliveries (and vice versa).

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON webhook_deliveries TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id())
  WITH CHECK (app_is_system() OR merchant_id = app_merchant_id());
--> statement-breakpoint
CREATE POLICY readonly_all ON webhook_deliveries FOR SELECT TO gw_readonly USING (true);
--> statement-breakpoint
-- The app updates delivery state and purges old rows; it never creates deliveries itself.
REVOKE INSERT, TRUNCATE ON webhook_deliveries FROM gw_app;
--> statement-breakpoint

-- Which endpoint receives which event never changes after creation.
CREATE FUNCTION webhook_delivery_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.endpoint_id, NEW.merchant_id, NEW.event_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.endpoint_id, OLD.merchant_id, OLD.event_id, OLD.created_at) THEN
    RAISE EXCEPTION 'webhook delivery identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER webhook_deliveries_identity BEFORE UPDATE ON webhook_deliveries FOR EACH ROW EXECUTE FUNCTION webhook_delivery_identity_immutable();
--> statement-breakpoint

-- Fan-out: every event goes to every endpoint of the same merchant and mode that exists when the event is written.
CREATE FUNCTION outbox_webhook_fanout() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO webhook_deliveries (endpoint_id, merchant_id, event_id)
  SELECT w.id, NEW.merchant_id, NEW.id FROM webhook_endpoints w WHERE w.merchant_id = NEW.merchant_id AND w.livemode = NEW.livemode;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER outbox_events_webhooks AFTER INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION outbox_webhook_fanout();
--> statement-breakpoint

ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_previous_secret
  CHECK ((previous_secret_enc IS NULL) = (previous_secret_expires_at IS NULL));
