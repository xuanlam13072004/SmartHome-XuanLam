-- Automations ("Tự động"): when a device changes state, reports an event or a
-- time of day comes, and the conditions hold, run one of the account's scenes
-- and/or send the account a notification. Personal, like scenes; the API
-- Gateway's automation engine evaluates them (docs/architecture/scenes.md).

-- True when [at] falls in the daily window [from, to) of [zone]; a window
-- whose end is before its start runs past midnight (23:00–05:00).
CREATE FUNCTION public.automation_window_open(
    window_from time,
    window_to time,
    zone text,
    at timestamp with time zone
) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT CASE
        WHEN window_from IS NULL THEN true
        WHEN window_from < window_to THEN local_now >= window_from AND local_now < window_to
        ELSE local_now >= window_from OR local_now < window_to
    END
    FROM (SELECT (at AT TIME ZONE zone)::time AS local_now) AS clock
$$;

CREATE TABLE public.automations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    name text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    -- "Khi": state = a property of a device becomes true for the comparison,
    -- event = a device reports an event, time = a local time on chosen days.
    trigger_kind text NOT NULL CHECK (trigger_kind IN ('state', 'event', 'time')),
    -- A removed device takes the automations it triggers with it.
    trigger_device_id uuid REFERENCES public.device_metadata(id) ON DELETE CASCADE,
    -- Catalog property path ('instances.door_position.reported.door_state').
    trigger_property text,
    trigger_operator text CHECK (trigger_operator IN ('eq', 'ne', 'gt', 'lt')),
    trigger_value jsonb,
    -- Catalog event key ('<instance>.<event>', e.g. 'hazard.incident_started').
    trigger_event text,
    trigger_time time,
    trigger_days smallint[],
    -- Time zone of trigger_time and of the active window.
    timezone text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
    -- "Nếu": up to 3 [{device_id, property, operator, value}], all must hold,
    -- read from the devices' current state when the trigger fires.
    conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
    active_from time,
    active_to time,
    -- "Thì": a scene (deleting it leaves the automation without one) and/or a
    -- notification text.
    scene_id uuid,
    notify_message text,
    -- No second action within this many seconds.
    cooldown_seconds integer NOT NULL DEFAULT 300 CHECK (cooldown_seconds IN (60, 300, 900, 3600)),
    -- state: whether the comparison currently holds (fires only on false → true).
    trigger_matched boolean NOT NULL DEFAULT false,
    -- event: the last event handled (every Gateway instance hears each event once).
    last_event_id text,
    -- time: the next occurrence; NULL while disabled.
    next_run_at timestamp with time zone,
    last_triggered_at timestamp with time zone,
    last_result text CHECK (last_result IS NULL OR last_result IN (
        'started', 'notified', 'skipped_running', 'skipped_protected', 'skipped_empty',
        'skipped_conditions', 'no_action', 'unavailable', 'missed'
    )),
    last_acted_at timestamp with time zone,
    last_run_id uuid REFERENCES public.scene_runs(id) ON DELETE SET NULL,
    -- Suggestion it was created from ('night_lock:AA:BB:…'), shown once per account.
    suggestion text CHECK (suggestion IS NULL OR length(suggestion) BETWEEN 1 AND 160),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    FOREIGN KEY (scene_id, account_id) REFERENCES public.scenes (id, account_id) ON DELETE SET NULL (scene_id),
    CHECK (length(btrim(name)) BETWEEN 1 AND 60),
    CHECK (
        (trigger_kind = 'state'
            AND trigger_device_id IS NOT NULL AND trigger_property IS NOT NULL
            AND trigger_operator IS NOT NULL AND trigger_value IS NOT NULL
            AND trigger_event IS NULL AND trigger_time IS NULL AND trigger_days IS NULL)
        OR (trigger_kind = 'event'
            AND trigger_device_id IS NOT NULL AND trigger_event IS NOT NULL
            AND trigger_property IS NULL AND trigger_operator IS NULL AND trigger_value IS NULL
            AND trigger_time IS NULL AND trigger_days IS NULL)
        OR (trigger_kind = 'time'
            AND trigger_device_id IS NULL AND trigger_time IS NOT NULL AND trigger_days IS NOT NULL
            AND trigger_property IS NULL AND trigger_operator IS NULL AND trigger_value IS NULL
            AND trigger_event IS NULL)
    ),
    CHECK (trigger_property IS NULL OR trigger_property ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,3}$'),
    CHECK (trigger_event IS NULL OR trigger_event ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
    CHECK (trigger_value IS NULL OR jsonb_typeof(trigger_value) IN ('boolean', 'number', 'string')),
    CHECK (trigger_time IS NULL OR trigger_time = date_trunc('minute', trigger_time)),
    CHECK (trigger_days IS NULL
        OR (cardinality(trigger_days) BETWEEN 1 AND 7 AND trigger_days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[])),
    CHECK (jsonb_typeof(conditions) = 'array' AND jsonb_array_length(conditions) <= 3),
    CHECK ((active_from IS NULL) = (active_to IS NULL)),
    CHECK (active_from IS NULL OR (active_from <> active_to
        AND active_from = date_trunc('minute', active_from) AND active_to = date_trunc('minute', active_to))),
    CHECK (notify_message IS NULL OR length(btrim(notify_message)) BETWEEN 1 AND 160),
    CHECK ((trigger_kind = 'time' AND enabled) = (next_run_at IS NOT NULL))
);

CREATE UNIQUE INDEX uq_automations_account_name ON public.automations (account_id, lower(btrim(name)));
CREATE UNIQUE INDEX uq_automations_suggestion ON public.automations (account_id, suggestion)
    WHERE suggestion IS NOT NULL;
CREATE INDEX idx_automations_account ON public.automations (account_id, created_at);
-- What the engine loads: enabled device triggers.
CREATE INDEX idx_automations_trigger_device ON public.automations (trigger_device_id)
    WHERE enabled AND trigger_device_id IS NOT NULL;
CREATE INDEX idx_automations_due ON public.automations (next_run_at) WHERE next_run_at IS NOT NULL;
CREATE INDEX idx_automations_scene ON public.automations (scene_id) WHERE scene_id IS NOT NULL;
CREATE TRIGGER trg_automations_updated_at BEFORE UPDATE ON public.automations
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Which automation started a run (history shows "Tự động: <tên>").
ALTER TABLE public.scene_runs
    ADD COLUMN automation_id uuid REFERENCES public.automations(id) ON DELETE SET NULL;
CREATE INDEX idx_scene_runs_automation ON public.scene_runs (automation_id) WHERE automation_id IS NOT NULL;

-- Notifications addressed to one account (an automation's "gửi thông báo").
-- Device events reach the notification center from MongoDB; the Gateway
-- merges these in. Millisecond timestamps keep the merged order exact.
CREATE TABLE public.account_notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    automation_id uuid REFERENCES public.automations(id) ON DELETE SET NULL,
    title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 60),
    body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 160),
    created_at timestamp(3) with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_account_notifications_account
    ON public.account_notifications (account_id, created_at DESC, id DESC);
CREATE INDEX idx_account_notifications_created ON public.account_notifications (created_at);
