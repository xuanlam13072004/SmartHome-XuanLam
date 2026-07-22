SET search_path TO public;

CREATE TABLE IF NOT EXISTS device_shadow_outbox (
    id bigserial PRIMARY KEY,
    mac varchar(17) NOT NULL,
    operation text NOT NULL CHECK (operation IN ('upsert', 'unpair', 'rename')),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    processed_at timestamp with time zone,
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_shadow_outbox_pending
    ON device_shadow_outbox (id)
    WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_device_shadow_outbox_mac_pending
    ON device_shadow_outbox (mac, id)
    WHERE processed_at IS NULL;
