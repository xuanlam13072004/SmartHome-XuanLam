SET search_path TO public;

ALTER TABLE device_metadata
    ALTER COLUMN gateway_id TYPE TEXT USING gateway_id::text;

CREATE TABLE IF NOT EXISTS command_outbox (
    command_id uuid PRIMARY KEY REFERENCES device_commands(id) ON DELETE CASCADE,
    payload jsonb NOT NULL,
    published_at timestamp with time zone,
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_command_outbox_pending
    ON command_outbox (created_at)
    WHERE published_at IS NULL;
