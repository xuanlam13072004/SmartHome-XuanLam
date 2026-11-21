# Voice verification ("Giọng nói")

Status: phase A implemented 2026-11-21 (schema **208**). Phase B (voice
assistant: PhoWhisper + Gemini function calling, token limits) builds on it.
Target scale: 7–8k accounts, 30k devices.

## What it does

**1:1 verification**: is this recording the signed-in account owner's own,
live voice? It never searches across accounts (no "who is speaking?"), so cost
does not grow with the number of users and one user's data never decides
another's result. The assistant (phase B) will call `verifyVoice()` before
running a spoken command.

Decision = three checks, all required (`voice-service/app/scoring.py`):

1. **Speaker**: ECAPA-TDNN embedding (SpeechBrain, VoxCeleb, 192 numbers)
   against the centroid of the profile's templates. With a cohort loaded the
   score is **AS-norm** normalized (≥ `norm` 3.0 and raw cosine ≥ 0.45);
   otherwise raw cosine ≥ `speaker` 0.68.
2. **Anti-spoof** (hard floor): a per-profile RawNet2-style network says the
   voice is live, not a replay through a speaker or a synthetic voice.
3. **Fusion**: `w·similarity + (1-w)·anti_spoof ≥ fusion` 0.64
   (w = 0.65 when the recording is clean, SNR ≥ 14 dB, else 0.55).

Rejection reasons, checked in this order: `spoof_suspected`, `not_matched`,
`low_confidence`. A recording that cannot be judged (no speech, too short, too
noisy, clipped, too quiet) is a 422 with a Vietnamese message and is **not**
an attempt: it neither counts towards the lock nor is stored.

## Components

```
app ──multipart WAV──▶ api-gateway /voice/* ──x-voice-token──▶ voice-service ──▶ PostgreSQL (208)
       (JWT, rate limit,          (auth, lock in Redis,          (audio, ECAPA, RawNet2,
        on-device checks)          notifications)                  AS-norm, thresholds)
```

- **voice-service** (`voice-service/`, Python 3.12, FastAPI, CPU only): the only
  writer of the voice tables. Reached only from the Docker network with
  `VOICE_SERVICE_TOKEN` (root `.env`). Runs at most `VOICE_MAX_CONCURRENCY`
  (2) recordings at once; anti-spoof retraining runs one at a time in a
  background thread. Model weights are baked into the image at build time.
- **API Gateway** (`api-gateway/src/modules/voice/`): authentication, upload
  limits (multipart, 1 MB per file, ≤ 6 files), rate limits, the temporary
  lock, the security notification and password re-entry for deletion.
- **App** (`smarthome_app/lib/features/voice/`, Cá nhân → Giọng nói): records,
  checks each take on the phone with the same rules as the service
  (`audio/voice_audio.dart` mirrors `app/audio.py`), uploads WAV.

## Recording: same source, checked on the phone

Every take is 16 kHz mono 16-bit PCM from the `record` package with automatic
gain, echo cancellation and noise suppression **off**, and on Android the
`voiceRecognition` microphone path. Enrollment and verification are therefore
recorded the same way (a common source of false rejections otherwise), and
the anti-spoof model sees raw audio instead of audio already "cleaned" by the
phone.

Quality rules (identical in app and service):

| Rule | Speech | SNR | Clipped samples | Used for |
|---|---|---|---|---|
| profile | ≥ 1.5 s | ≥ 12 dB | ≤ 1% | enroll, calibrate, samples |
| verify | ≥ 0.8 s | ≥ 8 dB | ≤ 1% | verification |
| spoof | ≥ 1.0 s | ≥ 3 dB | ≤ 5% | recorded replays |

SNR = loud frames (90th percentile of 25 ms frame RMS) against the background
(10th percentile, or the 2 s of silence recorded at enrollment). Speech frames
are those ≥ 6 dB above the background. Recordings longer than 15 s are refused.

## Data (migration 208)

| Table | Content | Limits |
|---|---|---|
| `voice_profiles` | consent time, noise floor, thresholds, `calibrated_at` | one per account |
| `voice_templates` | embeddings (768 bytes), source `enroll`/`sample`/`auto` | ≤ 30; trimmed `auto` first, then `sample`; `enroll` always kept |
| `voice_clips` | 2 s float16 clips for anti-spoof training: `bonafide` / `spoof` | ≤ 10 / ≤ 20, newest kept |
| `voice_antispoof_models` | float16 weights (~0.5 MB), version, score statistics | one per profile |
| `voice_attempts` | scores of verifications/calibrations, no audio | 30 days (hourly purge) |

Biometric data is written only after explicit consent (`consent=true`, stored
time), cascades with the profile and the account, and deleting the profile
also deletes its attempts. No full recordings are kept.

`account_notifications.kind` (`automation` | `security`) carries the lock notice.

## Profile lifecycle

| Gateway route | Rate limit | voice-service | Notes |
|---|---|---|---|
| `GET /voice/profile` | — | `GET /v1/profiles/{id}` | `profile: null` before enrollment, plus `lock` |
| `POST /voice/profile` | 5/h | `PUT …` | `ambient` (2 s silence) + `samples` ×3–5 + `consent=true` |
| `POST /voice/verify` | 10/min | `POST …/verify` | `audio`; counts towards the lock |
| `POST /voice/calibrate` | 10/h | `POST …/calibrate` | `samples` ×3–5 |
| `POST /voice/samples` | 30/h | `POST …/samples` | `audio` |
| `POST /voice/antispoof` | 10/h | `POST …/antispoof` | `samples` ×1–5 replays |
| `DELETE /voice/profile` | 5/min | `DELETE …` | JSON `{password}`; clears the lock |

- **Enroll**: the 2 s silence gives the noise floor; each sentence must pass
  the profile rule and resemble the other sentences (cosine ≥ 0.55 to their
  centroid, else `VOICE_INCONSISTENT` naming the sentence); the anti-spoof
  model is trained before the profile is saved, in one transaction.
- **Verify**: a very confident match (similarity > 0.85, anti-spoof > 0.8,
  SNR ≥ 12 dB, not a near-duplicate) is added to the gallery as `auto`, so the
  profile follows slow voice changes.
- **Calibrate**: thresholds become mean − 2σ of the owner's extra recordings,
  clamped to safe bands (speaker 0.60–0.80, AS-norm 2.5–8.0, fusion
  0.55–0.85): calibration can reduce false rejections but never makes the
  profile lax. Each sentence must resemble the profile (cosine ≥ 0.5).
- **Samples** add a template and a bonafide clip; **replays** add spoof clips.
  Both retrain the anti-spoof model in the background (`training: true` in the
  summary; the app refreshes until done).
- Errors keep `details.sample` (index, or `ambient`) so the app marks the take
  to redo.

## Temporary lock

`api-gateway/src/modules/voice/lockout.ts`: 5 rejected verifications, each
within 10 minutes of the previous one (Redis `voice:fail:<account>`), lock
voice verification **and profile changes** for 15 minutes
(`voice:lock:<account>`, 423 `VOICE_LOCKED` with `details.locked_until`). The
lock is created with `SET NX`, so concurrent failures notify once: a
`security` account notification ("Giọng nói tạm khóa") plus
`notification_created` to the open apps. A match resets the count. Deleting
the profile (password required) removes the lock.

## Anti-spoof model (kept from the original system, fixed)

Architecture unchanged (`app/rawnet.py`). Fixes:

- **Stateless**: the original shared one model object between owners
  (concurrent requests could score with another owner's weights). Now weights
  live in PostgreSQL and loaded models are cached per (profile, version).
- **Honest thresholds**: score statistics come from augmented takes the model
  was not trained on, and the floor is computed in the same score space as the
  score (the original mixed probability space and blended space). Floor =
  midpoint between live and attack scores, clamped 0.30–0.70; a model that
  barely separates the classes is marked `weak` (the app suggests teaching it
  replays).
- **Raw input**: no spectral subtraction before anti-spoofing (it removes the
  replay artifacts the model needs); the loudest 2 s of speech is stored and
  up to 3 windows spread over the speech are scored.
- Mini-batch training with class weighting and a fixed seed; recorded replays
  kept balanced (newest `max(8, 2 × bonafide)`).
- Training data: the owner's clips (+ one augmented take each), three
  simulated attacks per clip (replay through a room, phone speaker band-pass,
  TTS-like quantization) and the owner's recorded replays.

## AS-norm cohort

`python -m tools.build_cohort <dir>` embeds speakers who are **not** users of
the system (e.g. the VIVOS corpus, one folder per speaker) into
`/data/cohort.npy` (`E:/smarthome_data/voice`). With ≥ 50 embeddings the
service normalizes scores: `0.5·((s − μₑ)/σₑ + (s − μₚ)/σₚ)` over the 200 most
similar cohort voices of the profile and of the probe. Normalized scores have
a speaker-independent scale, so one threshold fits every profile and every
recording condition better than raw cosine. Without a cohort the service
uses raw cosine.

## Evaluation (thesis report)

`python -m tools.evaluate /eval` — `speakers/<person>/*.wav` (≥ 4 each) and
optional `spoof/<person>/*.wav`. The first 3 files enroll each person; the
rest are genuine trials, other people's files impostor trials, spoof files
replay attacks. Reports EER (cosine, AS-norm, anti-spoof) and FAR/FRR at the
service thresholds, with the real pipeline. `--from-db` summarizes the
service's own 30-day attempt log (outcomes, mean scores) without audio.

## Tests

- voice-service: `pytest` (fake embedder that "hears" pitch, numpy logistic
  anti-spoof backend, in-memory store; PostgreSQL store test with
  `VOICE_TEST_DATABASE_URL`; RawNet2 test when PyTorch is installed — inside
  the image: `docker compose run --rm voice-service python -m pytest -q`).
- Gateway: `test/voice.test.ts` against a stand-in voice-service.
- App: `test/voice_audio_test.dart` (on-device checks, WAV, models).
