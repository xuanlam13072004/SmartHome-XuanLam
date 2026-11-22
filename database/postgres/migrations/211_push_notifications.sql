-- Push notifications (docs/architecture/push.md): the phones of each signed-in
-- session receive alerts through Firebase Cloud Messaging even when the app is
-- closed, and reminders before a paid assistant plan ends.

-- One row per phone (FCM registration token). Tied to the session that
-- registered it: a revoked or expired session stops receiving at once.
CREATE TABLE public.push_tokens (
    token text PRIMARY KEY CHECK (length(token) BETWEEN 20 AND 4096),
    account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    session_id uuid NOT NULL REFERENCES public.user_sessions(id) ON DELETE CASCADE,
    platform text NOT NULL CHECK (platform IN ('android', 'ios')),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_push_tokens_account ON public.push_tokens (account_id);
CREATE INDEX idx_push_tokens_session ON public.push_tokens (session_id);

-- Reminders already sent for one end date of a plan (a renewal moves the end
-- date and starts a new round). The primary key lets exactly one Gateway send.
CREATE TABLE public.plan_reminders (
    account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    plan_expires_at timestamp with time zone NOT NULL,
    stage text NOT NULL CHECK (stage IN ('3d', '1d', 'expired')),
    sent_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, plan_expires_at, stage)
);

CREATE INDEX idx_plan_reminders_sent ON public.plan_reminders (sent_at);
CREATE INDEX idx_account_plans_expires ON public.account_plans (expires_at);
