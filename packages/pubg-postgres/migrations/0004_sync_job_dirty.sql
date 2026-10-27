-- A team's roster changed (an account was linked) or a retry was asked for while a worker held the team's
-- lease. The lease keeps the next-attempt time untouched, so the change used to wait for the next hourly slot.
-- dirty_at records it; completing the lease then leaves the team due now instead. Additive: older code ignores it.
ALTER TABLE pubg_sync_jobs ADD COLUMN IF NOT EXISTS dirty_at TIMESTAMPTZ;
