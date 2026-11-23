-- Administration (docs/architecture/admin.md): the company's operator works
-- from the Simulator's "Quản trị" page, which reaches the Gateway's /admin API
-- with a server-held key. Every change made there (or with the CLI tools) is
-- written here with its reason; customers' rows are never edited silently.

CREATE TABLE public.admin_audit_log (
    id bigserial PRIMARY KEY,
    -- 'admin': the Quản trị page; 'cli': a tool run inside the Gateway container.
    -- (Named operators can be added later without changing the rows written so far.)
    actor text NOT NULL CHECK (actor ~ '^[a-z][a-z0-9_:.-]{1,63}$'),
    action text NOT NULL CHECK (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
    target_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
    -- Kept so the log stays readable after the account is deleted.
    target_email text CHECK (target_email IS NULL OR length(target_email) <= 320),
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
    details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_admin_audit_log_created ON public.admin_audit_log (created_at DESC, id DESC);
CREATE INDEX idx_admin_audit_log_target ON public.admin_audit_log (target_account_id, created_at DESC)
    WHERE target_account_id IS NOT NULL;

-- Overview charts: new accounts and paid orders per day.
CREATE INDEX idx_accounts_created ON public.accounts (created_at);
CREATE INDEX idx_payment_orders_paid ON public.payment_orders (paid_at) WHERE status = 'paid';
