-- Payments for assistant plans (docs/architecture/payments.md): a VietQR bank
-- transfer per order, confirmed by the SePay webhook, by hand, or simulated
-- in mock mode. A paid order extends `account_plans`.

-- Twelve months cost ten (prices stay data).
ALTER TABLE public.assistant_plans
    ADD COLUMN price_12m_vnd integer CHECK (price_12m_vnd IS NULL OR price_12m_vnd >= 0);
UPDATE public.assistant_plans SET price_12m_vnd = price_vnd * 10 WHERE price_vnd > 0;

CREATE TABLE public.payment_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Written in the transfer note: "SH" + 8 characters without look-alikes (0/O, 1/I).
    code text NOT NULL UNIQUE CHECK (code ~ '^SH[A-HJ-NP-Z2-9]{8}$'),
    account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    plan_code text NOT NULL REFERENCES public.assistant_plans(code),
    months smallint NOT NULL CHECK (months IN (1, 12)),
    -- Set by the server from the plan's price; never by the client.
    amount_vnd integer NOT NULL CHECK (amount_vnd > 0),
    -- pending: waiting for the transfer (shown as expired after expires_at, a
    -- late full transfer is still honoured); review: part of the amount arrived.
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled', 'review')),
    expires_at timestamp with time zone NOT NULL,
    received_vnd integer NOT NULL DEFAULT 0 CHECK (received_vnd >= 0),
    paid_at timestamp with time zone,
    paid_via text CHECK (paid_via IS NULL OR paid_via IN ('sepay', 'manual', 'mock')),
    -- When the plan ends after this order (extension or upgrade).
    plan_expires_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK ((status = 'paid') = (paid_at IS NOT NULL))
);

CREATE INDEX idx_payment_orders_account ON public.payment_orders (account_id, created_at DESC);
CREATE INDEX idx_payment_orders_open ON public.payment_orders (status, created_at) WHERE status IN ('pending', 'review');

-- Every incoming bank notification, matched or not (reconciliation, SePay's
-- monthly quota). provider_ref makes a retried webhook harmless.
CREATE TABLE public.payment_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL CHECK (provider IN ('sepay', 'manual')),
    provider_ref text NOT NULL CHECK (length(provider_ref) BETWEEN 1 AND 100),
    amount_vnd bigint NOT NULL,
    content text NOT NULL DEFAULT '' CHECK (length(content) <= 500),
    account_number text CHECK (account_number IS NULL OR length(account_number) <= 40),
    transferred_at timestamp with time zone,
    order_id uuid REFERENCES public.payment_orders(id) ON DELETE SET NULL,
    outcome text NOT NULL CHECK (outcome IN
        ('paid', 'partial', 'already_paid', 'unmatched', 'other_account', 'outgoing')),
    received_at timestamp with time zone NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_ref)
);

CREATE INDEX idx_payment_transactions_received ON public.payment_transactions (received_at DESC);
CREATE INDEX idx_payment_transactions_order ON public.payment_transactions (order_id) WHERE order_id IS NOT NULL;
