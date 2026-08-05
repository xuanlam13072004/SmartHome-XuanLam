BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamp with time zone NOT NULL DEFAULT now()
);

INSERT INTO public.schema_migrations (version, name)
VALUES (201, 'schema_v2_resource_credential_contract')
ON CONFLICT (version) DO NOTHING;

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE FUNCTION public.operation_input_has_sensitive_key(payload jsonb) RETURNS boolean
    LANGUAGE plpgsql
    IMMUTABLE
    PARALLEL SAFE
AS $$
DECLARE
    item_key text;
    item_value jsonb;
BEGIN
    IF payload IS NULL THEN
        RETURN false;
    END IF;

    IF jsonb_typeof(payload) = 'object' THEN
        FOR item_key, item_value IN SELECT key, value FROM jsonb_each(payload)
        LOOP
            IF item_key ~* '(^|_)(pin|password|secret|face_template|embedding|fingerprint_template|rfid_value)($|_)' THEN
                RETURN true;
            END IF;
            IF public.operation_input_has_sensitive_key(item_value) THEN
                RETURN true;
            END IF;
        END LOOP;
    ELSIF jsonb_typeof(payload) = 'array' THEN
        FOR item_value IN SELECT value FROM jsonb_array_elements(payload)
        LOOP
            IF public.operation_input_has_sensitive_key(item_value) THEN
                RETURN true;
            END IF;
        END LOOP;
    END IF;

    RETURN false;
END;
$$;

CREATE TABLE public.accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    password_hash text NOT NULL,
    full_name text NOT NULL,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled', 'pending_deletion')),
    token_version integer NOT NULL DEFAULT 1 CHECK (token_version >= 1),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (email = lower(btrim(email))),
    CHECK (length(email) BETWEEN 3 AND 320),
    CHECK (length(btrim(full_name)) BETWEEN 1 AND 120)
);

CREATE UNIQUE INDEX uq_accounts_email_normalized ON public.accounts (lower(email));

CREATE TABLE public.user_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    refresh_token_hash text NOT NULL,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked', 'expired')),
    expires_at timestamp with time zone NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at)
);

CREATE INDEX idx_user_sessions_account_status
    ON public.user_sessions (account_id, status, expires_at DESC);
CREATE INDEX idx_user_sessions_expiry
    ON public.user_sessions (expires_at)
    WHERE status = 'active';

CREATE TABLE public.factory_devices (
    mac varchar(17) PRIMARY KEY,
    secret_key_hash text NOT NULL,
    credential_public_key_pem text NOT NULL,
    product_id text NOT NULL,
    catalog_revision integer NOT NULL DEFAULT 1 CHECK (catalog_revision >= 1),
    firmware_family text NOT NULL,
    hardware_revision text,
    is_claimed boolean NOT NULL DEFAULT false,
    claimed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (mac ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'),
    CHECK (product_id ~ '^prod_[a-z0-9_]+$'),
    CHECK (firmware_family ~ '^[a-z][a-z0-9_]+$'),
    CHECK ((is_claimed = true AND claimed_at IS NOT NULL) OR (is_claimed = false AND claimed_at IS NULL))
);

CREATE TABLE public.device_networks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    network_fingerprint text NOT NULL,
    active_hub_device_id uuid,
    topology_epoch bigint NOT NULL DEFAULT 0 CHECK (topology_epoch >= 0),
    next_join_rank bigint NOT NULL DEFAULT 1 CHECK (next_join_rank >= 1),
    topology_state text NOT NULL DEFAULT 'electing'
        CHECK (topology_state IN ('stable', 'electing', 'degraded_direct', 'empty')),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    UNIQUE (owner_id, network_fingerprint),
    UNIQUE (id, owner_id),
    UNIQUE (active_hub_device_id, id),
    CHECK (network_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE TABLE public.device_metadata (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    mac varchar(17) NOT NULL UNIQUE REFERENCES public.factory_devices(mac) ON DELETE RESTRICT,
    name text NOT NULL,
    product_id text NOT NULL,
    catalog_revision integer NOT NULL DEFAULT 1 CHECK (catalog_revision >= 1),
    firmware_version text,
    network_id uuid,
    join_rank bigint,
    is_active boolean NOT NULL DEFAULT true,
    claimed_at timestamp with time zone NOT NULL DEFAULT now(),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    UNIQUE (id, owner_id),
    UNIQUE (owner_id, mac),
    UNIQUE (owner_id, name),
    UNIQUE (id, network_id),
    FOREIGN KEY (network_id, owner_id)
        REFERENCES public.device_networks(id, owner_id)
        DEFERRABLE INITIALLY DEFERRED,
    CHECK (mac ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'),
    CHECK (product_id ~ '^prod_[a-z0-9_]+$'),
    CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    CHECK ((network_id IS NULL AND join_rank IS NULL) OR (network_id IS NOT NULL AND join_rank IS NOT NULL)),
    CHECK (join_rank IS NULL OR join_rank >= 1)
);

ALTER TABLE public.device_networks
    ADD CONSTRAINT device_networks_active_hub_membership_fkey
    FOREIGN KEY (active_hub_device_id, id)
    REFERENCES public.device_metadata(id, network_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX uq_device_metadata_network_join_rank
    ON public.device_metadata (network_id, join_rank)
    WHERE network_id IS NOT NULL;
CREATE INDEX idx_device_metadata_owner_active
    ON public.device_metadata (owner_id, is_active, created_at DESC);
CREATE INDEX idx_device_metadata_network
    ON public.device_metadata (network_id, join_rank)
    WHERE network_id IS NOT NULL;
CREATE INDEX idx_device_networks_owner_state
    ON public.device_networks (owner_id, topology_state, updated_at DESC);
CREATE INDEX idx_device_networks_active_hub
    ON public.device_networks (active_hub_device_id)
    WHERE active_hub_device_id IS NOT NULL;

CREATE TABLE public.permission_scopes (
    scope text PRIMARY KEY,
    description text NOT NULL,
    owner_only boolean NOT NULL DEFAULT false,
    delegable boolean NOT NULL DEFAULT true,
    CHECK (scope ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
    CHECK (NOT owner_only OR NOT delegable)
);

INSERT INTO public.permission_scopes (scope, description, owner_only, delegable) VALUES
    ('device.view', 'View device metadata and state', false, true),
    ('door.control', 'Lock and unlock an entrance device', false, true),
    ('camera.view', 'Create protected camera sessions', false, true),
    ('display.write', 'Change custom LCD content', false, true),
    ('cover.control', 'Move or stop a roof cover', false, true),
    ('irrigation.control', 'Start and stop bounded irrigation cycles', false, true),
    ('alarm.acknowledge', 'Mute or acknowledge an active alarm', false, true),
    ('automation.manage', 'Change schedules and non-critical automation', false, true),
    ('credential.manage', 'Manage PIN and biometric credentials', true, false),
    ('safety.configure', 'Change safety settings and dangerous recovery actions', true, false),
    ('device.share', 'Invite or revoke device members', true, false),
    ('device.unpair', 'Remove ownership and return a device to factory state', true, false);

CREATE TABLE public.device_memberships (
    device_id uuid NOT NULL REFERENCES public.device_metadata(id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('owner', 'controller', 'viewer')),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked', 'expired')),
    granted_by uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    expires_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, account_id),
    CHECK (role = 'owner' OR expires_at IS NULL OR expires_at > created_at),
    CHECK (role <> 'owner' OR (status = 'active' AND expires_at IS NULL))
);

CREATE UNIQUE INDEX uq_device_memberships_single_owner
    ON public.device_memberships (device_id)
    WHERE role = 'owner' AND status = 'active';
CREATE INDEX idx_device_memberships_account_active
    ON public.device_memberships (account_id, status, created_at DESC);

CREATE TABLE public.device_membership_permissions (
    device_id uuid NOT NULL,
    account_id uuid NOT NULL,
    permission_scope text NOT NULL REFERENCES public.permission_scopes(scope) ON DELETE RESTRICT,
    granted_by uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, account_id, permission_scope),
    FOREIGN KEY (device_id, account_id)
        REFERENCES public.device_memberships(device_id, account_id)
        ON DELETE CASCADE
);

CREATE TABLE public.device_invites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id uuid NOT NULL REFERENCES public.device_metadata(id) ON DELETE CASCADE,
    invited_email text NOT NULL,
    role text NOT NULL CHECK (role IN ('controller', 'viewer')),
    token_hash text NOT NULL UNIQUE,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    invited_by uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    expires_at timestamp with time zone NOT NULL,
    accepted_by uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (invited_email = lower(btrim(invited_email))),
    CHECK (expires_at > created_at),
    CHECK ((status = 'accepted' AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL)
        OR status <> 'accepted')
);

CREATE UNIQUE INDEX uq_device_invites_pending_email
    ON public.device_invites (device_id, lower(invited_email))
    WHERE status = 'pending';
CREATE INDEX idx_device_invites_expiry
    ON public.device_invites (expires_at)
    WHERE status = 'pending';

CREATE TABLE public.device_invite_permissions (
    invite_id uuid NOT NULL REFERENCES public.device_invites(id) ON DELETE CASCADE,
    permission_scope text NOT NULL REFERENCES public.permission_scopes(scope) ON DELETE RESTRICT,
    PRIMARY KEY (invite_id, permission_scope)
);

CREATE FUNCTION public.enforce_invite_permission() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    scope_owner_only boolean;
    scope_delegable boolean;
BEGIN
    SELECT owner_only, delegable
      INTO scope_owner_only, scope_delegable
    FROM public.permission_scopes
    WHERE scope = NEW.permission_scope;

    IF scope_owner_only OR NOT scope_delegable THEN
        RAISE EXCEPTION 'Permission % cannot be included in an invite', NEW.permission_scope;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_device_invite_permission
    BEFORE INSERT OR UPDATE
    ON public.device_invite_permissions
    FOR EACH ROW EXECUTE FUNCTION public.enforce_invite_permission();

CREATE FUNCTION public.enforce_device_membership_owner() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    actual_owner uuid;
BEGIN
    SELECT owner_id INTO actual_owner
    FROM public.device_metadata
    WHERE id = NEW.device_id;

    IF actual_owner IS NULL THEN
        RAISE EXCEPTION 'Device % does not exist', NEW.device_id;
    END IF;

    IF NEW.role = 'owner' AND NEW.account_id <> actual_owner THEN
        RAISE EXCEPTION 'Owner membership must match device_metadata.owner_id';
    END IF;

    IF NEW.role <> 'owner' AND NEW.account_id = actual_owner THEN
        RAISE EXCEPTION 'Device owner must use the owner membership role';
    END IF;

    IF NEW.granted_by IS NOT NULL AND NEW.granted_by <> actual_owner THEN
        RAISE EXCEPTION 'Only the device owner may grant a membership';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_device_membership_owner
    BEFORE INSERT OR UPDATE OF device_id, account_id, role
    ON public.device_memberships
    FOR EACH ROW EXECUTE FUNCTION public.enforce_device_membership_owner();

CREATE FUNCTION public.enforce_membership_permission() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    membership_role text;
    scope_owner_only boolean;
    scope_delegable boolean;
    actual_owner uuid;
BEGIN
    SELECT role INTO membership_role
    FROM public.device_memberships
    WHERE device_id = NEW.device_id
      AND account_id = NEW.account_id
      AND status = 'active';

    IF membership_role IS NULL THEN
        RAISE EXCEPTION 'Permission requires an active membership';
    END IF;

    SELECT owner_only, delegable
      INTO scope_owner_only, scope_delegable
    FROM public.permission_scopes
    WHERE scope = NEW.permission_scope;

    IF scope_owner_only AND membership_role <> 'owner' THEN
        RAISE EXCEPTION 'Permission % is owner-only', NEW.permission_scope;
    END IF;

    IF NOT scope_delegable AND membership_role <> 'owner' THEN
        RAISE EXCEPTION 'Permission % is not delegable', NEW.permission_scope;
    END IF;

    SELECT owner_id INTO actual_owner
    FROM public.device_metadata
    WHERE id = NEW.device_id;

    IF NEW.granted_by IS NOT NULL AND NEW.granted_by <> actual_owner THEN
        RAISE EXCEPTION 'Only the device owner may grant a permission';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_device_membership_permission
    BEFORE INSERT OR UPDATE
    ON public.device_membership_permissions
    FOR EACH ROW EXECUTE FUNCTION public.enforce_membership_permission();

CREATE FUNCTION public.ensure_device_active_owner() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    target_device_id uuid;
    expected_owner uuid;
    active_owner_count integer;
BEGIN
    IF TG_TABLE_NAME = 'device_metadata' THEN
        IF TG_OP = 'DELETE' THEN
            target_device_id := OLD.id;
        ELSE
            target_device_id := NEW.id;
        END IF;
    ELSE
        IF TG_OP = 'DELETE' THEN
            target_device_id := OLD.device_id;
        ELSE
            target_device_id := NEW.device_id;
        END IF;
    END IF;

    SELECT owner_id INTO expected_owner
    FROM public.device_metadata
    WHERE id = target_device_id;

    IF expected_owner IS NULL THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;

    SELECT count(*) INTO active_owner_count
    FROM public.device_memberships
    WHERE device_id = target_device_id
      AND account_id = expected_owner
      AND role = 'owner'
      AND status = 'active';

    IF active_owner_count <> 1 THEN
        RAISE EXCEPTION 'Device % must have exactly one active owner membership matching device_metadata.owner_id', target_device_id;
    END IF;

    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_device_metadata_active_owner
    AFTER INSERT OR UPDATE OF owner_id
    ON public.device_metadata
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.ensure_device_active_owner();

CREATE CONSTRAINT TRIGGER trg_device_membership_active_owner
    AFTER INSERT OR UPDATE OR DELETE
    ON public.device_memberships
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.ensure_device_active_owner();

CREATE FUNCTION public.enforce_device_inviter_owner() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    actual_owner uuid;
BEGIN
    SELECT owner_id INTO actual_owner
    FROM public.device_metadata
    WHERE id = NEW.device_id;

    IF actual_owner IS NULL OR NEW.invited_by <> actual_owner THEN
        RAISE EXCEPTION 'Only the device owner may create an invite';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_device_inviter_owner
    BEFORE INSERT OR UPDATE OF device_id, invited_by
    ON public.device_invites
    FOR EACH ROW EXECUTE FUNCTION public.enforce_device_inviter_owner();

CREATE TABLE public.device_policies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id uuid NOT NULL REFERENCES public.device_metadata(id) ON DELETE CASCADE,
    created_by uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    name text NOT NULL,
    instance_id text NOT NULL,
    policy_type text NOT NULL CHECK (policy_type IN ('schedule', 'threshold', 'automation', 'safety_setting')),
    configuration jsonb NOT NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    enabled boolean NOT NULL DEFAULT true,
    sync_status text NOT NULL DEFAULT 'pending'
        CHECK (sync_status IN ('pending', 'synced', 'rejected', 'failed')),
    last_synced_version bigint CHECK (last_synced_version IS NULL OR last_synced_version >= 1),
    last_sync_error text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    UNIQUE (device_id, name),
    CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    CHECK (instance_id ~ '^[a-z][a-z0-9_]+$'),
    CHECK (jsonb_typeof(configuration) = 'object'),
    CHECK (NOT public.operation_input_has_sensitive_key(configuration)),
    CHECK (last_synced_version IS NULL OR last_synced_version <= version)
);

CREATE INDEX idx_device_policies_device_enabled
    ON public.device_policies (device_id, enabled, policy_type);
CREATE INDEX idx_device_policies_pending_sync
    ON public.device_policies (updated_at, id)
    WHERE sync_status IN ('pending', 'failed');

CREATE TABLE public.device_policy_outbox (
    id bigserial PRIMARY KEY,
    policy_id uuid NOT NULL REFERENCES public.device_policies(id) ON DELETE CASCADE,
    device_id uuid NOT NULL REFERENCES public.device_metadata(id) ON DELETE CASCADE,
    policy_version bigint NOT NULL CHECK (policy_version >= 1),
    payload jsonb NOT NULL,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at timestamp with time zone NOT NULL DEFAULT now(),
    published_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    UNIQUE (policy_id, policy_version),
    CHECK (jsonb_typeof(payload) = 'object'),
    CHECK (NOT public.operation_input_has_sensitive_key(payload))
);

CREATE INDEX idx_device_policy_outbox_pending
    ON public.device_policy_outbox (available_at, id)
    WHERE published_at IS NULL;

CREATE TABLE public.device_operations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id uuid NOT NULL REFERENCES public.device_metadata(id) ON DELETE CASCADE,
    actor_account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    instance_id text NOT NULL,
    operation_name text NOT NULL,
    permission_scope text NOT NULL REFERENCES public.permission_scopes(scope) ON DELETE RESTRICT,
    risk text NOT NULL CHECK (risk IN ('normal', 'sensitive', 'dangerous')),
    input jsonb NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key text,
    expected_state_version bigint CHECK (expected_state_version IS NULL OR expected_state_version >= 0),
    status text NOT NULL DEFAULT 'accepted'
        CHECK (status IN ('accepted', 'queued', 'dispatched', 'executing', 'succeeded', 'rejected', 'failed', 'timed_out', 'cancelled')),
    reason_code text,
    catalog_revision integer NOT NULL CHECK (catalog_revision >= 1),
    timeout_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone NOT NULL DEFAULT now(),
    completed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (instance_id ~ '^[a-z][a-z0-9_]+$'),
    CHECK (operation_name ~ '^[a-z][a-z0-9_]+$'),
    CHECK (jsonb_typeof(input) = 'object'),
    CHECK (NOT public.operation_input_has_sensitive_key(input)),
    CHECK ((status IN ('succeeded', 'rejected', 'failed', 'timed_out', 'cancelled') AND completed_at IS NOT NULL)
        OR (status IN ('accepted', 'queued', 'dispatched', 'executing') AND completed_at IS NULL)),
    CHECK (timeout_at > accepted_at)
);

CREATE UNIQUE INDEX uq_device_operations_idempotency
    ON public.device_operations (device_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_device_operations_device_timeline
    ON public.device_operations (device_id, created_at DESC);
CREATE INDEX idx_device_operations_active_timeout
    ON public.device_operations (timeout_at)
    WHERE status IN ('accepted', 'queued', 'dispatched', 'executing');
CREATE INDEX idx_device_operations_actor
    ON public.device_operations (actor_account_id, created_at DESC)
    WHERE actor_account_id IS NOT NULL;

CREATE TABLE public.device_operation_transitions (
    id bigserial PRIMARY KEY,
    operation_id uuid NOT NULL REFERENCES public.device_operations(id) ON DELETE CASCADE,
    from_status text,
    to_status text NOT NULL
        CHECK (to_status IN ('accepted', 'queued', 'dispatched', 'executing', 'succeeded', 'rejected', 'failed', 'timed_out', 'cancelled')),
    reason_code text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(metadata) = 'object'),
    CHECK (NOT public.operation_input_has_sensitive_key(metadata))
);

CREATE INDEX idx_operation_transitions_timeline
    ON public.device_operation_transitions (operation_id, occurred_at, id);

CREATE TABLE public.operation_outbox (
    id bigserial PRIMARY KEY,
    operation_id uuid NOT NULL REFERENCES public.device_operations(id) ON DELETE CASCADE,
    topic text NOT NULL,
    payload jsonb NOT NULL,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at timestamp with time zone NOT NULL DEFAULT now(),
    published_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(payload) = 'object'),
    CHECK (NOT public.operation_input_has_sensitive_key(payload))
);

CREATE INDEX idx_operation_outbox_pending
    ON public.operation_outbox (available_at, id)
    WHERE published_at IS NULL;

CREATE TABLE public.device_resource_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id uuid NOT NULL REFERENCES public.device_metadata(id) ON DELETE CASCADE,
    actor_account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    operation_id uuid NOT NULL UNIQUE REFERENCES public.device_operations(id) ON DELETE CASCADE,
    instance_id text NOT NULL,
    resource_id text NOT NULL,
    permission_scope text NOT NULL REFERENCES public.permission_scopes(scope) ON DELETE RESTRICT,
    resource_kind text NOT NULL,
    status text NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested', 'ready', 'failed', 'expired', 'revoked')),
    access_token_hash text NOT NULL,
    resource_locator text,
    reason_code text,
    expires_at timestamp with time zone NOT NULL,
    ready_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (instance_id ~ '^[a-z][a-z0-9_]+$'),
    CHECK (resource_id ~ '^[a-z][a-z0-9_]+$'),
    CHECK (resource_kind IN ('video_stream', 'snapshot', 'audio_stream', 'document', 'binary')),
    CHECK (expires_at > created_at),
    CHECK ((status = 'ready' AND ready_at IS NOT NULL AND resource_locator IS NOT NULL)
        OR (status <> 'ready'))
);

CREATE INDEX idx_device_resource_sessions_actor_expiry
    ON public.device_resource_sessions (actor_account_id, expires_at DESC);
CREATE INDEX idx_device_resource_sessions_device_status
    ON public.device_resource_sessions (device_id, status, expires_at DESC);

CREATE TABLE public.device_credentials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id uuid NOT NULL REFERENCES public.device_metadata(id) ON DELETE CASCADE,
    instance_id text NOT NULL,
    credential_name text NOT NULL,
    credential_kind text NOT NULL CHECK (credential_kind IN ('pin', 'face', 'rfid', 'fingerprint')),
    label text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'revoked', 'failed')),
    created_by uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    catalog_revision integer NOT NULL CHECK (catalog_revision >= 1),
    rotated_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (length(btrim(label)) BETWEEN 1 AND 120),
    CHECK (instance_id ~ '^[a-z][a-z0-9_]+$'),
    CHECK (credential_name ~ '^[a-z][a-z0-9_]+$'),
    CHECK (jsonb_typeof(metadata) = 'object'),
    CHECK (NOT public.operation_input_has_sensitive_key(metadata)),
    CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);

CREATE INDEX idx_device_credentials_device_status
    ON public.device_credentials (device_id, status, credential_kind);
CREATE UNIQUE INDEX uq_device_credentials_active_label
    ON public.device_credentials (device_id, instance_id, credential_name, label)
    WHERE status IN ('pending', 'active');

CREATE TABLE public.credential_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id uuid NOT NULL REFERENCES public.device_metadata(id) ON DELETE CASCADE,
    credential_id uuid REFERENCES public.device_credentials(id) ON DELETE SET NULL,
    actor_account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    instance_id text NOT NULL,
    credential_name text NOT NULL,
    action text NOT NULL CHECK (action IN ('enroll', 'rotate', 'revoke')),
    status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'dispatched', 'succeeded', 'rejected', 'failed', 'timed_out')),
    reason_code text,
    catalog_revision integer NOT NULL CHECK (catalog_revision >= 1),
    idempotency_key text,
    timeout_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (instance_id ~ '^[a-z][a-z0-9_]+$'),
    CHECK (credential_name ~ '^[a-z][a-z0-9_]+$'),
    CHECK ((status IN ('succeeded', 'rejected', 'failed', 'timed_out') AND completed_at IS NOT NULL)
        OR (status IN ('queued', 'dispatched') AND completed_at IS NULL)),
    CHECK (timeout_at > created_at)
);

CREATE INDEX idx_credential_jobs_active_timeout
    ON public.credential_jobs (timeout_at)
    WHERE status IN ('queued', 'dispatched');
CREATE UNIQUE INDEX uq_credential_jobs_idempotency
    ON public.credential_jobs (device_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE public.credential_outbox (
    id bigserial PRIMARY KEY,
    job_id uuid NOT NULL REFERENCES public.credential_jobs(id) ON DELETE CASCADE,
    payload jsonb NOT NULL,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at timestamp with time zone NOT NULL DEFAULT now(),
    published_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(payload) = 'object'),
    CHECK (payload ? 'encrypted_envelope'),
    CHECK (NOT public.operation_input_has_sensitive_key(payload))
);

CREATE INDEX idx_credential_outbox_pending
    ON public.credential_outbox (available_at, id)
    WHERE published_at IS NULL;

CREATE FUNCTION public.enforce_credential_owner() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    actual_owner uuid;
    actor_id uuid;
BEGIN
    SELECT owner_id INTO actual_owner
    FROM public.device_metadata
    WHERE id = NEW.device_id;

    IF TG_TABLE_NAME = 'device_credentials' THEN
        actor_id := NEW.created_by;
    ELSE
        actor_id := NEW.actor_account_id;
    END IF;

    IF actual_owner IS NULL OR actor_id <> actual_owner THEN
        RAISE EXCEPTION 'Only the device owner may manage credentials';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_device_credential_owner
    BEFORE INSERT OR UPDATE OF device_id, created_by
    ON public.device_credentials
    FOR EACH ROW EXECUTE FUNCTION public.enforce_credential_owner();

CREATE TRIGGER trg_credential_job_owner
    BEFORE INSERT OR UPDATE OF device_id, actor_account_id
    ON public.credential_jobs
    FOR EACH ROW EXECUTE FUNCTION public.enforce_credential_owner();

CREATE TABLE public.device_audit_logs (
    id bigserial PRIMARY KEY,
    device_id uuid REFERENCES public.device_metadata(id) ON DELETE SET NULL,
    actor_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
    action text NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'failed')),
    reason_code text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(metadata) = 'object'),
    CHECK (NOT public.operation_input_has_sensitive_key(metadata))
);

CREATE INDEX idx_device_audit_logs_device_timeline
    ON public.device_audit_logs (device_id, occurred_at DESC)
    WHERE device_id IS NOT NULL;
CREATE INDEX idx_device_audit_logs_actor_timeline
    ON public.device_audit_logs (actor_account_id, occurred_at DESC)
    WHERE actor_account_id IS NOT NULL;

CREATE TABLE public.device_shadow_outbox (
    id bigserial PRIMARY KEY,
    device_id uuid,
    mac varchar(17) NOT NULL,
    operation text NOT NULL CHECK (operation IN ('claim', 'upsert', 'rename', 'unpair')),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at timestamp with time zone NOT NULL DEFAULT now(),
    processed_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (mac ~ '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'),
    CHECK (jsonb_typeof(payload) = 'object'),
    CHECK (NOT public.operation_input_has_sensitive_key(payload))
);

CREATE INDEX idx_device_shadow_outbox_pending
    ON public.device_shadow_outbox (available_at, id)
    WHERE processed_at IS NULL;
CREATE INDEX idx_device_shadow_outbox_mac_pending
    ON public.device_shadow_outbox (mac, id)
    WHERE processed_at IS NULL;

CREATE TABLE public.topology_outbox (
    id bigserial PRIMARY KEY,
    network_id uuid NOT NULL REFERENCES public.device_networks(id) ON DELETE CASCADE,
    topology_epoch bigint NOT NULL CHECK (topology_epoch >= 0),
    event_type text NOT NULL
        CHECK (event_type IN ('membership_changed', 'hub_election_started', 'hub_changed', 'network_stable', 'network_empty')),
    payload jsonb NOT NULL,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at timestamp with time zone NOT NULL DEFAULT now(),
    processed_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    UNIQUE (network_id, topology_epoch, event_type),
    CHECK (jsonb_typeof(payload) = 'object'),
    CHECK (NOT public.operation_input_has_sensitive_key(payload))
);

CREATE INDEX idx_topology_outbox_pending
    ON public.topology_outbox (available_at, id)
    WHERE processed_at IS NULL;
CREATE INDEX idx_topology_outbox_network_timeline
    ON public.topology_outbox (network_id, topology_epoch DESC);

CREATE TRIGGER trg_accounts_updated_at
    BEFORE UPDATE ON public.accounts
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_user_sessions_updated_at
    BEFORE UPDATE ON public.user_sessions
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_factory_devices_updated_at
    BEFORE UPDATE ON public.factory_devices
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_device_networks_updated_at
    BEFORE UPDATE ON public.device_networks
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_device_metadata_updated_at
    BEFORE UPDATE ON public.device_metadata
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_device_memberships_updated_at
    BEFORE UPDATE ON public.device_memberships
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_device_invites_updated_at
    BEFORE UPDATE ON public.device_invites
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_device_operations_updated_at
    BEFORE UPDATE ON public.device_operations
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_device_resource_sessions_updated_at
    BEFORE UPDATE ON public.device_resource_sessions
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_device_policies_updated_at
    BEFORE UPDATE ON public.device_policies
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_device_credentials_updated_at
    BEFORE UPDATE ON public.device_credentials
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_credential_jobs_updated_at
    BEFORE UPDATE ON public.credential_jobs
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_topology_outbox_updated_at
    BEFORE UPDATE ON public.topology_outbox
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMIT;
