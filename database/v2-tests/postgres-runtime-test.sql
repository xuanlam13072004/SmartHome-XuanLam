BEGIN;

INSERT INTO public.accounts (id, email, password_hash, full_name) VALUES
    ('00000000-0000-4000-8000-000000000001', 'owner@example.test', 'hash-owner', 'Owner Test'),
    ('00000000-0000-4000-8000-000000000002', 'viewer@example.test', 'hash-viewer', 'Viewer Test');

INSERT INTO public.factory_devices (
    mac,
    secret_key_hash,
    product_id,
    catalog_revision,
    firmware_family
) VALUES (
    '02:00:00:00:00:01',
    'factory-secret-hash',
    'prod_entrance_controller',
    1,
    'entrance_controller'
);

INSERT INTO public.device_networks (
    id,
    owner_id,
    network_fingerprint
) VALUES (
    '10000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001',
    repeat('a', 64)
);

INSERT INTO public.device_metadata (
    id,
    owner_id,
    mac,
    name,
    product_id,
    catalog_revision,
    network_id,
    join_rank
) VALUES (
    '20000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001',
    '02:00:00:00:00:01',
    'Entrance Test',
    'prod_entrance_controller',
    1,
    '10000000-0000-4000-8000-000000000001',
    1
);

INSERT INTO public.device_memberships (
    device_id,
    account_id,
    role,
    granted_by
) VALUES
    (
        '20000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000001',
        'owner',
        '00000000-0000-4000-8000-000000000001'
    ),
    (
        '20000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        'viewer',
        '00000000-0000-4000-8000-000000000001'
    );

INSERT INTO public.device_membership_permissions (
    device_id,
    account_id,
    permission_scope,
    granted_by
) VALUES
    (
        '20000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000001',
        'credential.manage',
        '00000000-0000-4000-8000-000000000001'
    ),
    (
        '20000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        'device.view',
        '00000000-0000-4000-8000-000000000001'
    );

DO $$
BEGIN
    BEGIN
        INSERT INTO public.device_membership_permissions (
            device_id,
            account_id,
            permission_scope,
            granted_by
        ) VALUES (
            '20000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000002',
            'credential.manage',
            '00000000-0000-4000-8000-000000000001'
        );
        RAISE EXCEPTION 'owner-only permission unexpectedly accepted';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE 'Permission credential.manage is owner-only%' THEN
            RAISE;
        END IF;
    END;
END;
$$;

INSERT INTO public.device_invites (
    id,
    device_id,
    invited_email,
    role,
    token_hash,
    invited_by,
    expires_at
) VALUES (
    '50000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'guest@example.test',
    'viewer',
    'invite-token-hash',
    '00000000-0000-4000-8000-000000000001',
    now() + interval '1 day'
);

INSERT INTO public.device_invite_permissions (invite_id, permission_scope) VALUES
    ('50000000-0000-4000-8000-000000000001', 'device.view'),
    ('50000000-0000-4000-8000-000000000001', 'camera.view');

DO $$
BEGIN
    BEGIN
        INSERT INTO public.device_invites (
            device_id,
            invited_email,
            role,
            token_hash,
            invited_by,
            expires_at
        ) VALUES (
            '20000000-0000-4000-8000-000000000001',
            'unauthorized@example.test',
            'viewer',
            'unauthorized-invite-token-hash',
            '00000000-0000-4000-8000-000000000002',
            now() + interval '1 day'
        );
        RAISE EXCEPTION 'non-owner invite unexpectedly accepted';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE 'Only the device owner may create an invite%' THEN
            RAISE;
        END IF;
    END;
END;
$$;

INSERT INTO public.device_policies (
    id,
    device_id,
    created_by,
    name,
    instance_id,
    policy_type,
    configuration
) VALUES (
    '60000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001',
    'Auto relock',
    'main_lock',
    'safety_setting',
    '{"delay_seconds":30}'::jsonb
);

INSERT INTO public.device_policy_outbox (
    policy_id,
    device_id,
    policy_version,
    payload
) VALUES (
    '60000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    1,
    '{"policy_id":"60000000-0000-4000-8000-000000000001","version":1}'::jsonb
);

UPDATE public.device_networks
SET active_hub_device_id = '20000000-0000-4000-8000-000000000001',
    topology_state = 'stable'
WHERE id = '10000000-0000-4000-8000-000000000001';

INSERT INTO public.device_operations (
    id,
    device_id,
    actor_account_id,
    instance_id,
    operation_name,
    permission_scope,
    risk,
    input,
    catalog_revision,
    timeout_at
) VALUES (
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001',
    'main_lock',
    'unlock',
    'door.control',
    'sensitive',
    '{}'::jsonb,
    1,
    now() + interval '30 seconds'
);

DO $$
BEGIN
    BEGIN
        INSERT INTO public.device_operations (
            device_id,
            actor_account_id,
            instance_id,
            operation_name,
            permission_scope,
            risk,
            input,
            catalog_revision,
            timeout_at
        ) VALUES (
            '20000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000001',
            'main_lock',
            'unlock',
            'door.control',
            'sensitive',
            '{"wrapper":{"pin_code":"1234"}}'::jsonb,
            1,
            now() + interval '30 seconds'
        );
        RAISE EXCEPTION 'nested credential material unexpectedly accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
END;
$$;

INSERT INTO public.device_credentials (
    id,
    device_id,
    credential_type,
    label,
    material_digest,
    status,
    created_by
) VALUES (
    '40000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'pin',
    'Primary PIN',
    'pin-verifier-digest',
    'active',
    '00000000-0000-4000-8000-000000000001'
);

DO $$
BEGIN
    BEGIN
        INSERT INTO public.device_credentials (
            device_id,
            credential_type,
            label,
            material_digest,
            status,
            created_by
        ) VALUES (
            '20000000-0000-4000-8000-000000000001',
            'pin',
            'Viewer PIN',
            'viewer-pin-verifier',
            'active',
            '00000000-0000-4000-8000-000000000002'
        );
        RAISE EXCEPTION 'non-owner credential unexpectedly accepted';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE 'Only the device owner may manage credentials%' THEN
            RAISE;
        END IF;
    END;
END;
$$;

DO $$
BEGIN
    BEGIN
        INSERT INTO public.device_credentials (
            device_id,
            credential_type,
            label,
            material_ciphertext,
            encryption_key_version,
            status,
            created_by
        ) VALUES (
            '20000000-0000-4000-8000-000000000001',
            'pin',
            'Unsafe PIN',
            decode('31323334', 'hex'),
            1,
            'active',
            '00000000-0000-4000-8000-000000000001'
        );
        RAISE EXCEPTION 'encrypted PIN material unexpectedly accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
END;
$$;

SET CONSTRAINTS ALL IMMEDIATE;

DO $$
DECLARE
    active_hub uuid;
    operation_count integer;
    credential_count integer;
BEGIN
    SELECT active_hub_device_id INTO active_hub
    FROM public.device_networks
    WHERE id = '10000000-0000-4000-8000-000000000001';

    SELECT count(*) INTO operation_count FROM public.device_operations;
    SELECT count(*) INTO credential_count FROM public.device_credentials;

    IF active_hub <> '20000000-0000-4000-8000-000000000001'::uuid THEN
        RAISE EXCEPTION 'active hub foreign key was not persisted';
    END IF;
    IF operation_count <> 1 THEN
        RAISE EXCEPTION 'unexpected operation count: %', operation_count;
    END IF;
    IF credential_count <> 1 THEN
        RAISE EXCEPTION 'unexpected credential count: %', credential_count;
    END IF;
END;
$$;

ROLLBACK;
