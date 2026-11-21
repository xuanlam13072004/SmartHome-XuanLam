from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import quote


@dataclass(frozen=True)
class Settings:
    token: str
    database_url: str
    cohort_path: str
    model_dir: str
    max_concurrency: int
    torch_threads: int
    attempt_retention_days: int
    max_upload_bytes: int


def _database_url(env: dict[str, str]) -> str:
    if env.get("DATABASE_URL"):
        return env["DATABASE_URL"]
    user = quote(env.get("PG_USER", "postgres"), safe="")
    password = quote(env.get("PG_PASSWORD", ""), safe="")
    host = env.get("PG_HOST", "localhost")
    port = env.get("PG_PORT", "5432")
    database = env.get("PG_DATABASE", "smarthome")
    return f"postgresql://{user}:{password}@{host}:{port}/{database}"


def load_settings(env: dict[str, str] | None = None) -> Settings:
    env = dict(os.environ if env is None else env)
    token = env.get("VOICE_SERVICE_TOKEN", "")
    if len(token) < 16:
        raise RuntimeError("VOICE_SERVICE_TOKEN must be set (at least 16 characters).")
    return Settings(
        token=token,
        database_url=_database_url(env),
        cohort_path=env.get("VOICE_COHORT_PATH", "/data/cohort.npy"),
        model_dir=env.get("VOICE_MODEL_DIR", "/models/ecapa"),
        max_concurrency=max(1, int(env.get("VOICE_MAX_CONCURRENCY", "2"))),
        torch_threads=max(0, int(env.get("VOICE_TORCH_THREADS", "0"))),
        attempt_retention_days=max(1, int(env.get("VOICE_ATTEMPT_RETENTION_DAYS", "30"))),
        max_upload_bytes=max(64_000, int(env.get("VOICE_MAX_UPLOAD_BYTES", "1048576"))),
    )
