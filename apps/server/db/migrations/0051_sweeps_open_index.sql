-- One sweep in flight per address (was: one non-failed sweep ever). A user's permanent deposit address (D-101) is
-- swept again after each later deposit; the amount is still confirmed payments minus confirmed sweeps (signer re-checks).
DROP INDEX "sweeps_open_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "sweeps_open_uq" ON "sweeps" USING btree ("deposit_address_id") WHERE "sweeps"."status" in ('pending', 'gas_sent', 'sweep_sent');