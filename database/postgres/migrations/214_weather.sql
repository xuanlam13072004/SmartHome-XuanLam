-- Weather (docs/architecture/weather.md): where the account's home is, for
-- the forecast its automations, its assistant and the app read. Coarse on
-- purpose: a province centre or a searched place rounded to about 1 km,
-- never the phone's GPS. Removing it clears all three columns.
ALTER TABLE public.account_preferences
    ADD COLUMN home_latitude double precision
        CHECK (home_latitude IS NULL OR home_latitude BETWEEN -90 AND 90),
    ADD COLUMN home_longitude double precision
        CHECK (home_longitude IS NULL OR home_longitude BETWEEN -180 AND 180),
    ADD COLUMN home_place text
        CHECK (home_place IS NULL OR length(btrim(home_place)) BETWEEN 1 AND 120),
    ADD CONSTRAINT account_preferences_home_complete CHECK (
        (home_latitude IS NULL) = (home_longitude IS NULL) AND (home_latitude IS NULL) = (home_place IS NULL)
    );

-- Weather conditions live in automations.conditions next to device ones:
-- {"kind": "weather", "weather": "rain_next_3h", "operator": "eq", "value": true}.
-- Why the last occurrence did nothing when the devices are not the reason
-- (for now 'weather_unavailable': no forecast to check a weather condition).
ALTER TABLE public.automations
    ADD COLUMN last_skip_reason text
        CHECK (last_skip_reason IS NULL OR last_skip_reason ~ '^[a-z][a-z_]{1,39}$');

-- Accounts whose automations need a forecast: the refresher reads these.
CREATE INDEX idx_automations_weather ON public.automations (account_id)
    WHERE enabled AND conditions @> '[{"kind": "weather"}]';
