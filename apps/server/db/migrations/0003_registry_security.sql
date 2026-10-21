-- MONEY-CRITICAL
-- Guards for the chain/token registry and deposit-address allocation. Defense in depth behind application code:
-- these rules hold even if a code path forgets a check.

-- Tenant isolation for merchant-owned address data.
ALTER TABLE merchant_xpubs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE deposit_addresses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['merchant_xpubs', 'deposit_addresses'] LOOP
    EXECUTE format(
      'CREATE POLICY tenant ON %I TO gw_app USING (app_is_system() OR merchant_id = app_merchant_id()) '
      'WITH CHECK (app_is_system() OR merchant_id = app_merchant_id())', t);
    EXECUTE format('CREATE POLICY readonly_all ON %I FOR SELECT TO gw_readonly USING (true)', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- Deposit addresses are financial records: never deleted; the address <-> derivation mapping never changes.
REVOKE DELETE, TRUNCATE ON deposit_addresses FROM gw_app;
--> statement-breakpoint
CREATE TRIGGER deposit_addresses_no_delete BEFORE DELETE ON deposit_addresses
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER deposit_addresses_no_truncate BEFORE TRUNCATE ON deposit_addresses
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE FUNCTION deposit_address_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.merchant_id, NEW.livemode, NEW.family, NEW.chain_id, NEW.source, NEW.wallet_account_id, NEW.merchant_xpub_id,
      NEW.derivation_index, NEW.derivation_path, NEW.address)
     IS DISTINCT FROM
     (OLD.merchant_id, OLD.livemode, OLD.family, OLD.chain_id, OLD.source, OLD.wallet_account_id, OLD.merchant_xpub_id,
      OLD.derivation_index, OLD.derivation_path, OLD.address) THEN
    RAISE EXCEPTION 'deposit address identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER deposit_addresses_immutable BEFORE UPDATE ON deposit_addresses
  FOR EACH ROW EXECUTE FUNCTION deposit_address_immutable();
--> statement-breakpoint

-- Allocation guard: chain must be enabled, match the family, and match test/live mode; the address source must match
-- the merchant's custody mode (custodial -> platform wallet; non_custodial_xpub -> merchant xpub; forwarder -> none yet).
CREATE FUNCTION deposit_address_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c chains;
  mode custody_mode;
BEGIN
  SELECT * INTO c FROM chains WHERE id = NEW.chain_id;
  IF NOT FOUND OR NOT c.enabled THEN
    RAISE EXCEPTION 'chain % is not enabled', NEW.chain_id USING ERRCODE = 'check_violation';
  END IF;
  IF c.family <> NEW.family THEN
    RAISE EXCEPTION 'chain family mismatch' USING ERRCODE = 'check_violation';
  END IF;
  IF c.testnet = NEW.livemode THEN
    RAISE EXCEPTION 'live addresses need a mainnet chain; test addresses need a testnet' USING ERRCODE = 'check_violation';
  END IF;
  SELECT custody_mode INTO mode FROM merchants WHERE id = NEW.merchant_id;
  IF mode IS NULL
     OR (mode = 'custodial' AND NEW.source <> 'platform')
     OR (mode = 'non_custodial_xpub' AND NEW.source <> 'merchant_xpub')
     OR mode = 'non_custodial_forwarder' THEN
    RAISE EXCEPTION 'address source % not allowed for custody mode %', NEW.source, mode USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER deposit_addresses_guard BEFORE INSERT ON deposit_addresses
  FOR EACH ROW EXECUTE FUNCTION deposit_address_guard();
--> statement-breakpoint

-- Derivation counters only move forward (an index is never handed out twice).
-- Keys (xpub + fingerprint) never change in place: retire the row and add a new one.
CREATE FUNCTION xpub_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.next_index < OLD.next_index THEN
    RAISE EXCEPTION 'derivation index cannot move backwards' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.xpub IS DISTINCT FROM OLD.xpub OR NEW.key_fingerprint IS DISTINCT FROM OLD.key_fingerprint
     OR NEW.family IS DISTINCT FROM OLD.family OR NEW.livemode IS DISTINCT FROM OLD.livemode THEN
    RAISE EXCEPTION 'extended key identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER merchant_xpubs_guard BEFORE UPDATE ON merchant_xpubs FOR EACH ROW EXECUTE FUNCTION xpub_row_guard();
--> statement-breakpoint
CREATE TRIGGER wallet_accounts_guard BEFORE UPDATE ON wallet_accounts FOR EACH ROW EXECUTE FUNCTION xpub_row_guard();
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON merchant_xpubs, wallet_accounts FROM gw_app;
--> statement-breakpoint

-- A key may be registered once across platform AND merchants. Without this, a merchant could register the
-- platform's (public) xpub and receive invoices on addresses only the platform can spend, or vice versa.
-- SECURITY DEFINER: must see every tenant's merchant_xpubs despite RLS.
CREATE FUNCTION key_fingerprint_unique() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'merchant_xpubs' AND EXISTS (SELECT 1 FROM wallet_accounts WHERE key_fingerprint = NEW.key_fingerprint) THEN
    RAISE EXCEPTION 'extended key already registered' USING ERRCODE = 'unique_violation';
  END IF;
  IF TG_TABLE_NAME = 'wallet_accounts' AND EXISTS (SELECT 1 FROM merchant_xpubs WHERE key_fingerprint = NEW.key_fingerprint) THEN
    RAISE EXCEPTION 'extended key already registered' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER merchant_xpubs_fingerprint BEFORE INSERT ON merchant_xpubs FOR EACH ROW EXECUTE FUNCTION key_fingerprint_unique();
--> statement-breakpoint
CREATE TRIGGER wallet_accounts_fingerprint BEFORE INSERT ON wallet_accounts FOR EACH ROW EXECUTE FUNCTION key_fingerprint_unique();
--> statement-breakpoint

-- A token's contract and decimals define what gets credited. They never change under an existing token id.
CREATE FUNCTION token_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.chain_id IS DISTINCT FROM OLD.chain_id OR lower(NEW.contract_address) IS DISTINCT FROM lower(OLD.contract_address)
     OR NEW.decimals IS DISTINCT FROM OLD.decimals THEN
    RAISE EXCEPTION 'token chain, contract and decimals are immutable; create a new token' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER tokens_identity_immutable BEFORE UPDATE ON tokens FOR EACH ROW EXECUTE FUNCTION token_identity_immutable();
--> statement-breakpoint
CREATE FUNCTION chain_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.family IS DISTINCT FROM OLD.family OR NEW.evm_chain_id IS DISTINCT FROM OLD.evm_chain_id
     OR NEW.testnet IS DISTINCT FROM OLD.testnet THEN
    RAISE EXCEPTION 'chain family, network id and testnet flag are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER chains_identity_immutable BEFORE UPDATE ON chains FOR EACH ROW EXECUTE FUNCTION chain_identity_immutable();
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON chains, tokens FROM gw_app;
