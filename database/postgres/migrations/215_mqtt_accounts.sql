-- MQTT accounts (docs/architecture/mqtt-security.md): one row per broker
-- login, read by EMQX on every CONNECT through a read-only role. Adding a
-- device adds one row and retiring it removes one row: there is no broker-side
-- list to rewrite.
--
-- Devices: username = the MAC, written with the factory record (API xưởng)
-- and removed with it. Services (mqtt-worker-service): written by
-- db-initialize from the root .env. Passwords are 32 random bytes, so a salted
-- SHA-256 is enough and costs microseconds per CONNECT (a slow hash would make
-- every reconnect storm a CPU storm on the broker).
CREATE TABLE public.mqtt_accounts (
    username text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('device', 'service')),
    factory_mac varchar(17) UNIQUE REFERENCES public.factory_devices(mac) ON DELETE CASCADE,
    -- hex(sha256(password || salt)), as EMQX checks it (salt_position = suffix).
    password_hash text NOT NULL CHECK (password_hash ~ '^[0-9a-f]{64}$'),
    salt text NOT NULL CHECK (salt ~ '^[0-9a-f]{32}$'),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT mqtt_accounts_kind_identity CHECK (
        (kind = 'device' AND factory_mac IS NOT NULL AND username = factory_mac)
        OR (kind = 'service' AND factory_mac IS NULL AND username ~ '^[a-z][a-z0-9-]{2,63}$')
    )
);
