-- Scenes ("Kịch bản"): an account's named lists of device operations, run in
-- order by the API Gateway through the normal operation pipeline (same
-- permission checks as a tap in the app). Scenes are personal, like rooms.

CREATE TABLE public.scenes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    name text NOT NULL,
    icon text NOT NULL DEFAULT 'play',
    position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (length(btrim(name)) BETWEEN 1 AND 60),
    CHECK (icon ~ '^[a-z][a-z0-9_]{0,31}$')
);

CREATE UNIQUE INDEX uq_scenes_account_name ON public.scenes (account_id, lower(btrim(name)));
CREATE INDEX idx_scenes_account_position ON public.scenes (account_id, position, created_at);
CREATE TRIGGER trg_scenes_updated_at BEFORE UPDATE ON public.scenes
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- One device operation per step. `delay_seconds` is the wait before the step.
-- A removed device takes its steps with it.
CREATE TABLE public.scene_steps (
    scene_id uuid NOT NULL REFERENCES public.scenes(id) ON DELETE CASCADE,
    step_index smallint NOT NULL CHECK (step_index BETWEEN 0 AND 19),
    device_id uuid NOT NULL REFERENCES public.device_metadata(id) ON DELETE CASCADE,
    instance_id text NOT NULL CHECK (instance_id ~ '^[a-z][a-z0-9_]+$'),
    operation_name text NOT NULL CHECK (operation_name ~ '^[a-z][a-z0-9_]+$'),
    input jsonb NOT NULL DEFAULT '{}'::jsonb,
    delay_seconds integer NOT NULL DEFAULT 0 CHECK (delay_seconds BETWEEN 0 AND 3600),
    PRIMARY KEY (scene_id, step_index),
    CHECK (jsonb_typeof(input) = 'object' AND octet_length(input::text) <= 2048),
    CHECK (NOT public.operation_input_has_sensitive_key(input))
);

CREATE INDEX idx_scene_steps_device ON public.scene_steps (device_id);

-- One execution. Steps are copied when it starts, so editing or deleting the
-- scene does not change a run in progress, and history keeps its names.
-- The runner claims due runs with FOR UPDATE SKIP LOCKED and a short lease on
-- next_step_at; each step's operation carries an idempotency key, so a run
-- picked up again after a crash never sends a step twice.
CREATE TABLE public.scene_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    scene_id uuid REFERENCES public.scenes(id) ON DELETE SET NULL,
    scene_name text NOT NULL,
    trigger text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'schedule', 'automation')),
    status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
    reauthenticated boolean NOT NULL DEFAULT false,
    next_step_index smallint NOT NULL DEFAULT 0 CHECK (next_step_index >= 0),
    -- When to send next_step_index; NULL once every step has been sent.
    next_step_at timestamp with time zone,
    started_at timestamp with time zone NOT NULL DEFAULT now(),
    finished_at timestamp with time zone,
    CHECK ((status = 'running') = (finished_at IS NULL)),
    CHECK (status = 'running' OR next_step_at IS NULL)
);

-- At most one run in progress per scene (a double tap starts one run).
CREATE UNIQUE INDEX uq_scene_runs_one_running ON public.scene_runs (scene_id)
    WHERE status = 'running' AND scene_id IS NOT NULL;
CREATE INDEX idx_scene_runs_due ON public.scene_runs (next_step_at)
    WHERE status = 'running' AND next_step_at IS NOT NULL;
CREATE INDEX idx_scene_runs_account_started ON public.scene_runs (account_id, started_at DESC, id DESC);
CREATE INDEX idx_scene_runs_finished ON public.scene_runs (finished_at) WHERE finished_at IS NOT NULL;
-- Last run of each scene, shown on its card.
CREATE INDEX idx_scene_runs_scene_started ON public.scene_runs (scene_id, started_at DESC)
    WHERE scene_id IS NOT NULL;

CREATE TABLE public.scene_run_steps (
    run_id uuid NOT NULL REFERENCES public.scene_runs(id) ON DELETE CASCADE,
    step_index smallint NOT NULL CHECK (step_index >= 0),
    device_id uuid REFERENCES public.device_metadata(id) ON DELETE SET NULL,
    device_name text NOT NULL,
    instance_id text NOT NULL,
    operation_name text NOT NULL,
    operation_label text NOT NULL,
    input jsonb NOT NULL DEFAULT '{}'::jsonb,
    delay_seconds integer NOT NULL DEFAULT 0 CHECK (delay_seconds >= 0),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'dispatched', 'succeeded', 'failed')),
    reason_code text,
    operation_id uuid UNIQUE REFERENCES public.device_operations(id) ON DELETE SET NULL,
    dispatched_at timestamp with time zone,
    completed_at timestamp with time zone,
    PRIMARY KEY (run_id, step_index),
    CHECK (NOT public.operation_input_has_sensitive_key(input))
);

-- Steps still waiting for their device: what the runner reconciles each second.
CREATE INDEX idx_scene_run_steps_open ON public.scene_run_steps (run_id)
    WHERE status IN ('pending', 'dispatched');
