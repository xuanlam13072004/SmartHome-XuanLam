-- Scene schedules ("Hẹn giờ"): run a scene at a local time on chosen weekdays.
-- The Gateway's scene runner fires due schedules; firing (creating the run)
-- and moving next_run_at forward happen in one transaction, so a schedule
-- fires exactly once per occurrence even with several Gateway instances.

-- A schedule's account must be its scene's account (composite foreign key).
ALTER TABLE public.scenes ADD CONSTRAINT scenes_id_account_key UNIQUE (id, account_id);

-- First moment strictly after `after` that is `local_time` on one of `days`
-- (ISO weekdays, 1 = Monday … 7 = Sunday) in time zone `zone`. PostgreSQL's
-- time zone rules handle daylight-saving gaps and overlaps.
CREATE FUNCTION public.scene_schedule_next_run(
    local_time time,
    days smallint[],
    zone text,
    after timestamp with time zone
) RETURNS timestamp with time zone
    LANGUAGE sql
    STABLE
    PARALLEL SAFE
AS $$
    SELECT candidate
    FROM (
        SELECT ((local_day + local_time) AT TIME ZONE zone) AS candidate, local_day
        FROM (
            SELECT (after AT TIME ZONE zone)::date + offset_days AS local_day
            FROM generate_series(0, 7) AS offset_days
        ) AS day_list
    ) AS candidates
    WHERE extract(isodow FROM local_day)::smallint = ANY (days)
      AND candidate > after
    ORDER BY candidate
    LIMIT 1
$$;

CREATE TABLE public.scene_schedules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scene_id uuid NOT NULL,
    account_id uuid NOT NULL,
    local_time time NOT NULL,
    days smallint[] NOT NULL,
    timezone text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    -- When it fires next; NULL while disabled.
    next_run_at timestamp with time zone,
    last_fired_at timestamp with time zone,
    last_result text,
    last_run_id uuid REFERENCES public.scene_runs(id) ON DELETE SET NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    FOREIGN KEY (scene_id, account_id) REFERENCES public.scenes (id, account_id) ON DELETE CASCADE,
    CHECK (local_time = date_trunc('minute', local_time)),
    CHECK (cardinality(days) BETWEEN 1 AND 7 AND days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]),
    CHECK (length(timezone) BETWEEN 1 AND 64),
    CHECK (enabled = (next_run_at IS NOT NULL)),
    CHECK (last_result IS NULL OR last_result IN (
        'started', 'skipped_running', 'skipped_protected', 'skipped_empty', 'missed'
    ))
);

-- The same time and days twice on one scene would only run it twice.
CREATE UNIQUE INDEX uq_scene_schedules_slot ON public.scene_schedules (scene_id, local_time, days);
CREATE INDEX idx_scene_schedules_due ON public.scene_schedules (next_run_at) WHERE enabled;
CREATE INDEX idx_scene_schedules_account ON public.scene_schedules (account_id);
CREATE TRIGGER trg_scene_schedules_updated_at BEFORE UPDATE ON public.scene_schedules
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
