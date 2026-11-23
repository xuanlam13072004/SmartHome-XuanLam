-- Admin Console staff (docs/architecture/admin.md): the company's own people,
-- separate from customers' accounts. One root (created with a CLI tool inside
-- the Gateway container) manages the others and the permissions they get.

CREATE TABLE public.staff_accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    full_name text NOT NULL,
    password_hash text NOT NULL,
    is_root boolean NOT NULL DEFAULT false,
    -- Granted permission codes (modules/admin/permissions.ts); the root has all.
    permissions text[] NOT NULL DEFAULT '{}',
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    -- Set for a temporary password: nothing but changing it is allowed.
    must_change_password boolean NOT NULL DEFAULT true,
    failed_logins smallint NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
    locked_until timestamp with time zone,
    created_by uuid REFERENCES public.staff_accounts(id) ON DELETE SET NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 320),
    CHECK (length(btrim(full_name)) BETWEEN 1 AND 120),
    CHECK (NOT is_root OR status = 'active')
);

CREATE UNIQUE INDEX uq_staff_accounts_email ON public.staff_accounts (email);
-- Exactly one root at most.
CREATE UNIQUE INDEX uq_staff_accounts_root ON public.staff_accounts (is_root) WHERE is_root;

CREATE TRIGGER trg_staff_accounts_updated_at BEFORE UPDATE ON public.staff_accounts
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- A signed-in browser of the Admin Console: SHA-256 of a random token kept in
-- an httpOnly cookie. Ends when revoked, after 30 idle minutes or 12 hours.
CREATE TABLE public.staff_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id uuid NOT NULL REFERENCES public.staff_accounts(id) ON DELETE CASCADE,
    token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    client text CHECK (client IS NULL OR length(client) <= 200),
    ip text CHECK (ip IS NULL OR length(ip) <= 64),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    last_used_at timestamp with time zone NOT NULL DEFAULT now(),
    expires_at timestamp with time zone NOT NULL,
    CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX uq_staff_sessions_token ON public.staff_sessions (token_hash);
CREATE INDEX idx_staff_sessions_staff ON public.staff_sessions (staff_id, status, created_at DESC);

-- Who did it: the staff member (kept readable if the staff row is deleted).
ALTER TABLE public.admin_audit_log ADD COLUMN staff_id uuid REFERENCES public.staff_accounts(id) ON DELETE SET NULL;
ALTER TABLE public.admin_audit_log ADD COLUMN staff_email text CHECK (staff_email IS NULL OR length(staff_email) <= 320);
CREATE INDEX idx_admin_audit_log_staff ON public.admin_audit_log (staff_id, created_at DESC) WHERE staff_id IS NOT NULL;
