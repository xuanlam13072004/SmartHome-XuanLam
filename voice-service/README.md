# voice-service

Confirms that a recording is the account owner's own, live voice (1:1).
Design, rules and API: [docs/architecture/voice.md](../docs/architecture/voice.md).

- Python 3.12, FastAPI, PyTorch 2.2 CPU, SpeechBrain ECAPA-TDNN, per-profile
  RawNet2 anti-spoof, AS-norm.
- Called only by the API Gateway over the Docker network (`x-voice-token`).
- Stores in PostgreSQL (migration 208); the schema is created by `db-initialize`.

## Run

```powershell
# Root .env: VOICE_SERVICE_TOKEN=<random, >= 16 chars> (shared with api-gateway)
docker compose up -d --build voice-service api-gateway
docker compose logs -f voice-service
```

The first build downloads PyTorch (CPU) and the ECAPA model (~100 MB), then
the service runs offline.

## Optional: AS-norm cohort

```powershell
# One folder per speaker with WAV files, e.g. VIVOS train/waves
docker compose run --rm -v D:/vivos/train/waves:/cohort-audio:ro voice-service `
    python -m tools.build_cohort /cohort-audio --out /data/cohort.npy
docker compose restart voice-service
```

## Evaluate

```powershell
docker compose run --rm -v D:/voice-eval:/eval:ro voice-service python -m tools.evaluate /eval --json /data/report.json
docker compose run --rm voice-service python -m tools.evaluate --from-db
```

## Test

```powershell
docker compose run --rm voice-service python -m pytest -q
# Without Docker (no PyTorch: the RawNet2 test is skipped)
python -m venv .venv; .venv\Scripts\pip install numpy==1.26.4 scipy soundfile fastapi==0.134.0 python-multipart==0.0.22 "psycopg[binary]==3.2.13" psycopg-pool==3.2.8 pytest httpx
.venv\Scripts\python -m pytest -q
```
