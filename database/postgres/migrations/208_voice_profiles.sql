-- Voice profiles ("Giọng nói"): an account's voiceprint, used to confirm that
-- a spoken command comes from the account's owner (voice-service,
-- docs/architecture/voice.md). Biometric data: written only by voice-service,
-- only after the owner's consent, and deleted with the profile or the account.

-- Account notifications also carry security notices (voice verification
-- locked after repeated failures), not only automation messages.
ALTER TABLE public.account_notifications
    ADD COLUMN kind text NOT NULL DEFAULT 'automation' CHECK (kind IN ('automation', 'security'));

CREATE TABLE public.voice_profiles (
    account_id uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
    consent_at timestamp with time zone NOT NULL,
    -- Background noise measured from the silence recorded at enrollment.
    noise_floor_rms real NOT NULL CHECK (noise_floor_rms > 0),
    -- Decision thresholds; calibration with extra samples replaces the defaults.
    -- speaker: cosine to the profile's centroid; norm: AS-norm score.
    speaker_threshold real NOT NULL CHECK (speaker_threshold BETWEEN 0 AND 1),
    norm_threshold real NOT NULL CHECK (norm_threshold BETWEEN 0 AND 20),
    fusion_threshold real NOT NULL CHECK (fusion_threshold BETWEEN 0 AND 1),
    calibrated_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_voice_profiles_updated_at BEFORE UPDATE ON public.voice_profiles
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- The profile's gallery: ECAPA-TDNN embeddings (192 float32, little-endian,
-- unit length). voice-service keeps at most 30 per profile.
CREATE TABLE public.voice_templates (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES public.voice_profiles(account_id) ON DELETE CASCADE,
    embedding bytea NOT NULL CHECK (octet_length(embedding) = 768),
    -- enroll: the enrollment sentences; sample: added by the owner;
    -- auto: a very confident verification added automatically.
    source text NOT NULL CHECK (source IN ('enroll', 'sample', 'auto')),
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_voice_templates_account ON public.voice_templates (account_id, created_at);

-- Short clips for (re)training the profile's anti-spoof model: the owner's
-- own voice (bonafide) and replays or synthetic voices the owner recorded
-- (spoof). 16 kHz mono float16, at most 2 s.
CREATE TABLE public.voice_clips (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES public.voice_profiles(account_id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('bonafide', 'spoof')),
    audio bytea NOT NULL CHECK (octet_length(audio) BETWEEN 2 AND 64000),
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_voice_clips_account ON public.voice_clips (account_id, kind, created_at);

-- The profile's own anti-spoof model (RawNet2-style, float16 weights) and the
-- score statistics its thresholds come from.
CREATE TABLE public.voice_antispoof_models (
    account_id uuid PRIMARY KEY REFERENCES public.voice_profiles(account_id) ON DELETE CASCADE,
    version integer NOT NULL CHECK (version > 0),
    weights bytea NOT NULL CHECK (octet_length(weights) BETWEEN 1 AND 2000000),
    stats jsonb NOT NULL CHECK (jsonb_typeof(stats) = 'object'),
    trained_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Scores of verifications and calibrations (no audio), kept 30 days for the
-- evaluation report; deleted with the profile.
CREATE TABLE public.voice_attempts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('verify', 'calibrate')),
    accepted boolean NOT NULL,
    reason text CHECK (reason IS NULL OR reason IN ('not_matched', 'spoof_suspected', 'low_confidence')),
    similarity real,
    normalized real,
    anti_spoof real,
    fusion real,
    snr_db real,
    duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_voice_attempts_account ON public.voice_attempts (account_id, created_at DESC);
CREATE INDEX idx_voice_attempts_created ON public.voice_attempts (created_at);
