-- Voice assistant ("Trợ lý", docs/architecture/assistant.md): plans with a
-- monthly token allowance, per-account usage, a short log of turns, and voice
-- verifications made for spoken commands.

-- Plans. Prices and allowances are data: changed here, never in code.
CREATE TABLE public.assistant_plans (
    code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,31}$'),
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 40),
    monthly_tokens bigint NOT NULL CHECK (monthly_tokens > 0),
    price_vnd integer NOT NULL CHECK (price_vnd >= 0),
    position smallint NOT NULL,
    is_active boolean NOT NULL DEFAULT true
);

INSERT INTO public.assistant_plans (code, name, monthly_tokens, price_vnd, position) VALUES
    ('free', 'Miễn phí', 100000, 0, 0),
    ('basic', 'Cơ bản', 1500000, 49000, 1),
    ('pro', 'Nâng cao', 5000000, 99000, 2);

-- The account's paid plan until it expires; no row (or an expired one) means
-- the free plan. Payments (phase C) write here.
CREATE TABLE public.account_plans (
    account_id uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
    plan_code text NOT NULL REFERENCES public.assistant_plans(code),
    started_at timestamp with time zone NOT NULL DEFAULT now(),
    expires_at timestamp with time zone NOT NULL CHECK (expires_at > started_at)
);

-- Tokens Gemini reported, per account and calendar month (Vietnam time).
CREATE TABLE public.assistant_usage (
    account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    period date NOT NULL CHECK (extract(day FROM period) = 1),
    tokens bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
    requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
    PRIMARY KEY (account_id, period)
);

-- One row per assistant turn, kept 30 days (debugging and the thesis report).
CREATE TABLE public.assistant_turns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    channel text NOT NULL CHECK (channel IN ('voice', 'text')),
    message text NOT NULL CHECK (length(message) <= 1000),
    reply text NOT NULL CHECK (length(reply) <= 4000),
    outcome text NOT NULL CHECK (outcome IN ('chat', 'action', 'clarify', 'confirm', 'refused', 'error')),
    actions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(actions) = 'array'),
    tokens integer NOT NULL DEFAULT 0 CHECK (tokens >= 0),
    voice_verified boolean,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_assistant_turns_account ON public.assistant_turns (account_id, created_at DESC);
CREATE INDEX idx_assistant_turns_created ON public.assistant_turns (created_at);

-- Verifications made for a spoken command (kind 'verify'), told apart from
-- the "Thử giọng nói" tests in the evaluation report.
ALTER TABLE public.voice_attempts ADD COLUMN for_command boolean NOT NULL DEFAULT false;
