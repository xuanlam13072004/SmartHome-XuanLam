-- ============================================================================
-- SmartHome-XuanLam Database Migration - Version 6
-- Goal: Introduce the Hub-Node network topology source of truth.
-- ============================================================================

SET search_path TO public;

CREATE TABLE IF NOT EXISTS device_networks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    network_fingerprint text NOT NULL,
    active_hub_device_id uuid,
    topology_epoch bigint DEFAULT 0 NOT NULL,
    next_join_rank bigint DEFAULT 1 NOT NULL,
    topology_state text DEFAULT 'electing'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT device_networks_pkey PRIMARY KEY (id),
    CONSTRAINT device_networks_owner_fingerprint_key
        UNIQUE (owner_id, network_fingerprint),
    CONSTRAINT device_networks_id_owner_key
        UNIQUE (id, owner_id),
    CONSTRAINT device_networks_fingerprint_format_check
        CHECK (network_fingerprint ~ '^[0-9a-f]{64}$'::text),
    CONSTRAINT device_networks_topology_epoch_check
        CHECK (topology_epoch >= 0),
    CONSTRAINT device_networks_next_join_rank_check
        CHECK (next_join_rank >= 1),
    CONSTRAINT device_networks_topology_state_check
        CHECK (topology_state = ANY (
            ARRAY[
                'stable'::text,
                'degraded_direct'::text,
                'electing'::text,
                'empty'::text
            ]
        )),
    CONSTRAINT device_networks_state_hub_check
        CHECK (
            (topology_state <> 'stable' OR active_hub_device_id IS NOT NULL)
            AND (topology_state <> 'empty' OR active_hub_device_id IS NULL)
        )
);

ALTER TABLE device_metadata
    ADD COLUMN IF NOT EXISTS network_id uuid,
    ADD COLUMN IF NOT EXISTS join_rank bigint;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'device_metadata_network_membership_pair_check'
          AND conrelid = 'public.device_metadata'::regclass
    ) THEN
        ALTER TABLE device_metadata
            ADD CONSTRAINT device_metadata_network_membership_pair_check
            CHECK (
                (network_id IS NULL AND join_rank IS NULL)
                OR (network_id IS NOT NULL AND join_rank IS NOT NULL)
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'device_metadata_join_rank_check'
          AND conrelid = 'public.device_metadata'::regclass
    ) THEN
        ALTER TABLE device_metadata
            ADD CONSTRAINT device_metadata_join_rank_check
            CHECK (join_rank IS NULL OR join_rank >= 1);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'device_metadata_id_network_key'
          AND conrelid = 'public.device_metadata'::regclass
    ) THEN
        ALTER TABLE device_metadata
            ADD CONSTRAINT device_metadata_id_network_key
            UNIQUE (id, network_id);
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_device_metadata_network_join_rank
    ON device_metadata (network_id, join_rank)
    WHERE network_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_device_metadata_network
    ON device_metadata (network_id, join_rank)
    WHERE network_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_device_networks_owner_state
    ON device_networks (owner_id, topology_state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_device_networks_active_hub
    ON device_networks (active_hub_device_id)
    WHERE active_hub_device_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'device_networks_owner_id_fkey'
          AND conrelid = 'public.device_networks'::regclass
    ) THEN
        ALTER TABLE device_networks
            ADD CONSTRAINT device_networks_owner_id_fkey
            FOREIGN KEY (owner_id)
            REFERENCES accounts(id)
            ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'device_metadata_network_owner_fkey'
          AND conrelid = 'public.device_metadata'::regclass
    ) THEN
        ALTER TABLE device_metadata
            ADD CONSTRAINT device_metadata_network_owner_fkey
            FOREIGN KEY (network_id, owner_id)
            REFERENCES device_networks(id, owner_id)
            DEFERRABLE INITIALLY DEFERRED;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'device_networks_active_hub_membership_fkey'
          AND conrelid = 'public.device_networks'::regclass
    ) THEN
        ALTER TABLE device_networks
            ADD CONSTRAINT device_networks_active_hub_membership_fkey
            FOREIGN KEY (active_hub_device_id, id)
            REFERENCES device_metadata(id, network_id)
            DEFERRABLE INITIALLY DEFERRED;
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS topology_outbox (
    id bigserial PRIMARY KEY,
    network_id uuid NOT NULL,
    topology_epoch bigint NOT NULL,
    reason text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    processed_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT topology_outbox_network_epoch_key
        UNIQUE (network_id, topology_epoch),
    CONSTRAINT topology_outbox_epoch_check
        CHECK (topology_epoch >= 0),
    CONSTRAINT topology_outbox_reason_check
        CHECK (length(btrim(reason)) > 0),
    CONSTRAINT topology_outbox_payload_check
        CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT topology_outbox_attempts_check
        CHECK (attempts >= 0)
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'topology_outbox_network_id_fkey'
          AND conrelid = 'public.topology_outbox'::regclass
    ) THEN
        ALTER TABLE topology_outbox
            ADD CONSTRAINT topology_outbox_network_id_fkey
            FOREIGN KEY (network_id)
            REFERENCES device_networks(id)
            ON DELETE CASCADE;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_topology_outbox_pending
    ON topology_outbox (id)
    WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_topology_outbox_network_timeline
    ON topology_outbox (network_id, topology_epoch DESC);

DROP TRIGGER IF EXISTS trg_device_networks_updated_at ON device_networks;
CREATE TRIGGER trg_device_networks_updated_at
    BEFORE UPDATE ON device_networks
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_topology_outbox_updated_at ON topology_outbox;
CREATE TRIGGER trg_topology_outbox_updated_at
    BEFORE UPDATE ON topology_outbox
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
