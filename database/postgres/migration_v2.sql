-- ============================================================================
-- SmartHome-XuanLam Database Migration - Version 2
-- Goal: Introduce event_version concurrency control & decouple workers
-- ============================================================================

SET search_path TO public;

-- 1. Add event_version concurrency control column
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS event_version BIGINT NOT NULL DEFAULT 0;

-- 2. Add retry_count metadata column for audit/debugging
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;

-- 3. Create partial index for optimized command timeout scanning
CREATE INDEX IF NOT EXISTS idx_device_commands_active_timeout 
ON device_commands (updated_at)
WHERE status IN ('sending', 'sent');

-- 4. Update the command status CHECK constraint to allow intermediate 'sending' status
ALTER TABLE device_commands DROP CONSTRAINT IF EXISTS device_commands_status_check;
ALTER TABLE device_commands ADD CONSTRAINT device_commands_status_check 
CHECK (status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'acked'::text, 'failed'::text, 'timeout'::text]));
