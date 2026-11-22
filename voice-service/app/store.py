"""PostgreSQL storage (migration 208). voice-service is the only writer."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Iterable

import numpy as np

from .antispoof import MAX_BONAFIDE_CLIPS, MAX_SPOOF_CLIPS, TrainedModel
from .embedding import from_bytes, to_bytes
from .errors import VoiceError
from .scoring import MAX_TEMPLATES, Scores, Thresholds


@dataclass(frozen=True)
class Template:
    id: int
    source: str
    vector: np.ndarray


@dataclass(frozen=True)
class Profile:
    account_id: str
    consent_at: datetime
    noise_floor_rms: float
    thresholds: Thresholds
    calibrated_at: datetime | None
    created_at: datetime


@dataclass(frozen=True)
class Bundle:
    """Everything a verification needs, read in one go."""
    profile: Profile
    templates: list[Template]
    model: TrainedModel | None
    model_version: int


def profile_exists() -> VoiceError:
    return VoiceError(409, "VOICE_PROFILE_EXISTS", "Bạn đã đăng ký giọng nói. Hãy xóa hồ sơ cũ trước khi đăng ký lại.")


PROFILE_COLUMNS = ("account_id, consent_at, noise_floor_rms, speaker_threshold, norm_threshold, "
                   "fusion_threshold, calibrated_at, created_at")


def _profile(row) -> Profile:
    return Profile(
        account_id=str(row[0]), consent_at=row[1], noise_floor_rms=float(row[2]),
        thresholds=Thresholds(speaker=float(row[3]), norm=float(row[4]), fusion=float(row[5])),
        calibrated_at=row[6], created_at=row[7],
    )


class PostgresStore:
    def __init__(self, conninfo: str, max_size: int = 4):
        from psycopg_pool import ConnectionPool

        self.pool = ConnectionPool(conninfo, min_size=1, max_size=max_size, open=False)

    def open(self) -> None:
        self.pool.open(wait=True, timeout=30)

    def close(self) -> None:
        self.pool.close()

    # --- reads ---------------------------------------------------------------

    def load(self, account_id: str, with_model: bool = True) -> Bundle | None:
        with self.pool.connection() as conn:
            row = conn.execute(f"SELECT {PROFILE_COLUMNS} FROM voice_profiles WHERE account_id = %s",
                               (account_id,)).fetchone()
            if row is None:
                return None
            templates = [
                Template(id=r[0], source=r[1], vector=from_bytes(r[2]))
                for r in conn.execute(
                    "SELECT id, source, embedding FROM voice_templates WHERE account_id = %s ORDER BY created_at, id",
                    (account_id,))
            ]
            model, version = None, 0
            if with_model:
                m = conn.execute("SELECT version, weights, stats FROM voice_antispoof_models WHERE account_id = %s",
                                 (account_id,)).fetchone()
                if m is not None:
                    version, model = m[0], TrainedModel(weights=bytes(m[1]), stats=m[2])
            return Bundle(profile=_profile(row), templates=templates, model=model, model_version=version)

    def exists(self, account_id: str) -> bool:
        with self.pool.connection() as conn:
            return conn.execute("SELECT 1 FROM voice_profiles WHERE account_id = %s", (account_id,)).fetchone() is not None

    def clips(self, account_id: str) -> tuple[list[bytes], list[bytes]]:
        """(bonafide, spoof), oldest first."""
        with self.pool.connection() as conn:
            rows = conn.execute("SELECT kind, audio FROM voice_clips WHERE account_id = %s ORDER BY created_at, id",
                                (account_id,)).fetchall()
        return [bytes(r[1]) for r in rows if r[0] == "bonafide"], [bytes(r[1]) for r in rows if r[0] == "spoof"]

    def counts(self, account_id: str) -> dict:
        with self.pool.connection() as conn:
            templates = dict(conn.execute(
                "SELECT source, count(*)::int FROM voice_templates WHERE account_id = %s GROUP BY source",
                (account_id,)).fetchall())
            clips = dict(conn.execute(
                "SELECT kind, count(*)::int FROM voice_clips WHERE account_id = %s GROUP BY kind",
                (account_id,)).fetchall())
            model = conn.execute(
                "SELECT version, stats, trained_at FROM voice_antispoof_models WHERE account_id = %s",
                (account_id,)).fetchone()
            attempts = conn.execute(
                """SELECT count(*) FILTER (WHERE accepted)::int, count(*) FILTER (WHERE NOT accepted)::int,
                          max(created_at)
                   FROM voice_attempts
                   WHERE account_id = %s AND kind = 'verify' AND NOT for_command
                     AND created_at > now() - interval '30 days'""",
                (account_id,)).fetchone()
        return {"templates": templates, "clips": clips, "model": model, "attempts": attempts}

    # --- writes --------------------------------------------------------------

    def create(self, profile: Profile, vectors: Iterable[np.ndarray], clips: Iterable[bytes], model: TrainedModel) -> None:
        import psycopg

        try:
            with self.pool.connection() as conn:
                conn.execute(
                    """INSERT INTO voice_profiles (account_id, consent_at, noise_floor_rms, speaker_threshold,
                                                   norm_threshold, fusion_threshold)
                       VALUES (%s, %s, %s, %s, %s, %s)""",
                    (profile.account_id, profile.consent_at, profile.noise_floor_rms, profile.thresholds.speaker,
                     profile.thresholds.norm, profile.thresholds.fusion))
                with conn.cursor() as cur:
                    cur.executemany("INSERT INTO voice_templates (account_id, embedding, source) VALUES (%s, %s, 'enroll')",
                                    [(profile.account_id, to_bytes(v)) for v in vectors])
                    cur.executemany("INSERT INTO voice_clips (account_id, kind, audio) VALUES (%s, 'bonafide', %s)",
                                    [(profile.account_id, c) for c in clips])
                conn.execute(
                    "INSERT INTO voice_antispoof_models (account_id, version, weights, stats) VALUES (%s, 1, %s, %s)",
                    (profile.account_id, model.weights, psycopg.types.json.Jsonb(model.stats)))
        except psycopg.errors.UniqueViolation as exc:
            raise profile_exists() from exc
        except psycopg.errors.ForeignKeyViolation as exc:
            raise VoiceError(404, "VOICE_ACCOUNT_NOT_FOUND", "Tài khoản không tồn tại.") from exc

    def delete(self, account_id: str) -> bool:
        with self.pool.connection() as conn:
            conn.execute("DELETE FROM voice_attempts WHERE account_id = %s", (account_id,))
            return conn.execute("DELETE FROM voice_profiles WHERE account_id = %s", (account_id,)).rowcount > 0

    def add_template(self, account_id: str, vector: np.ndarray, source: str) -> bool:
        """Adds to the gallery, then trims it to MAX_TEMPLATES: automatic templates
        go first, then the owner's samples; enrollment templates always stay."""
        with self.pool.connection() as conn:
            # Serializes concurrent additions to one profile.
            if conn.execute("SELECT 1 FROM voice_profiles WHERE account_id = %s FOR UPDATE",
                            (account_id,)).fetchone() is None:
                return False
            conn.execute("INSERT INTO voice_templates (account_id, embedding, source) VALUES (%s, %s, %s)",
                         (account_id, to_bytes(vector), source))
            conn.execute(
                """DELETE FROM voice_templates WHERE id IN (
                       SELECT id FROM voice_templates WHERE account_id = %s AND source <> 'enroll'
                       ORDER BY (source = 'auto') DESC, created_at, id
                       LIMIT GREATEST(0, (SELECT count(*) FROM voice_templates WHERE account_id = %s) - %s))""",
                (account_id, account_id, MAX_TEMPLATES))
            return True

    def add_clips(self, account_id: str, kind: str, clips: list[bytes]) -> None:
        keep = MAX_BONAFIDE_CLIPS if kind == "bonafide" else MAX_SPOOF_CLIPS
        with self.pool.connection() as conn:
            if conn.execute("SELECT 1 FROM voice_profiles WHERE account_id = %s FOR UPDATE",
                            (account_id,)).fetchone() is None:
                return
            with conn.cursor() as cur:
                cur.executemany("INSERT INTO voice_clips (account_id, kind, audio) VALUES (%s, %s, %s)",
                                [(account_id, kind, c) for c in clips])
            conn.execute(
                """DELETE FROM voice_clips WHERE id IN (
                       SELECT id FROM voice_clips WHERE account_id = %s AND kind = %s
                       ORDER BY created_at DESC, id DESC OFFSET %s)""",
                (account_id, kind, keep))

    def save_model(self, account_id: str, model: TrainedModel) -> int | None:
        import psycopg

        try:
            with self.pool.connection() as conn:
                row = conn.execute(
                    """INSERT INTO voice_antispoof_models (account_id, version, weights, stats)
                       VALUES (%s, 1, %s, %s)
                       ON CONFLICT (account_id) DO UPDATE
                       SET version = voice_antispoof_models.version + 1, weights = EXCLUDED.weights,
                           stats = EXCLUDED.stats, trained_at = now()
                       RETURNING version""",
                    (account_id, model.weights, psycopg.types.json.Jsonb(model.stats))).fetchone()
                return int(row[0])
        except psycopg.errors.ForeignKeyViolation:
            return None  # the profile was deleted while training

    def set_thresholds(self, account_id: str, thresholds: Thresholds) -> None:
        with self.pool.connection() as conn:
            conn.execute(
                """UPDATE voice_profiles SET speaker_threshold = %s, norm_threshold = %s, fusion_threshold = %s,
                          calibrated_at = now() WHERE account_id = %s""",
                (thresholds.speaker, thresholds.norm, thresholds.fusion, account_id))

    def record_attempt(self, account_id: str, kind: str, accepted: bool, reason: str | None,
                       scores: Scores, duration_ms: int, for_command: bool = False) -> None:
        with self.pool.connection() as conn:
            conn.execute(
                """INSERT INTO voice_attempts (account_id, kind, accepted, reason, similarity, normalized,
                                               anti_spoof, fusion, snr_db, duration_ms, for_command)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (account_id, kind, accepted, reason, scores.similarity, scores.normalized, scores.anti_spoof,
                 scores.fusion, scores.snr_db, duration_ms, for_command))

    def purge_attempts(self, days: int) -> int:
        with self.pool.connection() as conn:
            return conn.execute(
                """DELETE FROM voice_attempts WHERE id IN (
                       SELECT id FROM voice_attempts WHERE created_at < now() - make_interval(days => %s) LIMIT 5000)""",
                (days,)).rowcount
