"""Test doubles: synthetic voices, an embedder that hears only pitch, and an
in-memory store with the same behaviour as PostgresStore."""
from __future__ import annotations

import io
from datetime import datetime, timedelta, timezone

import numpy as np
import soundfile as sf

from app.antispoof import MAX_BONAFIDE_CLIPS, MAX_SPOOF_CLIPS, TrainedModel
from app.embedding import DIM, from_bytes, to_bytes
from app.errors import VoiceError
from app.scoring import MAX_TEMPLATES, Thresholds
from app.store import Bundle, Profile, Template, profile_exists

RATE = 16000


def voice(f0: float, seconds: float = 2.5, seed: int = 0, silence: float = 0.4, noise: float = 0.001,
          level: float = 0.2) -> np.ndarray:
    """A vowel-like voice at pitch f0 with syllable rhythm and breath noise,
    between two stretches of room noise. Different seeds = different sentences."""
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    t = np.arange(n) / RATE
    freq = f0 * (1 + 0.015 * np.sin(2 * np.pi * rng.uniform(2, 4) * t + rng.uniform(0, 6)))
    phase = 2 * np.pi * np.cumsum(freq) / RATE
    tone = sum(np.sin(k * phase) / k for k in range(1, 12))
    rate = rng.uniform(3.5, 5.0)
    envelope = np.clip(0.55 - 0.45 * np.cos(2 * np.pi * rate * t + rng.uniform(0, 6)), 0, 1)
    breath = np.convolve(rng.normal(0, 1, n), [1, -0.9], mode="same") * 0.08
    speech = (tone / 3 + breath) * envelope * level
    pad = int(silence * RATE)
    signal = np.concatenate([np.zeros(pad), speech, np.zeros(pad)])
    return (signal + rng.normal(0, noise, len(signal))).astype(np.float32)


def ambient(seconds: float = 2.0, noise: float = 0.001, seed: int = 99) -> np.ndarray:
    return np.random.default_rng(seed).normal(0, noise, int(seconds * RATE)).astype(np.float32)


def wav(x: np.ndarray, rate: int = RATE) -> bytes:
    buffer = io.BytesIO()
    sf.write(buffer, np.clip(x, -1, 1), rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def pitch(x: np.ndarray) -> float:
    x = x - x.mean()
    corr = np.correlate(x[:8000], x[:8000], mode="full")[7999:]
    lo, hi = RATE // 400, RATE // 60
    return RATE / (lo + int(np.argmax(corr[lo:hi])))


class PitchEmbedder:
    """'Hears' only pitch: a bump at a position given by log f0. Same speaker
    (pitch within a few %) -> cosine near 1; 30% apart -> near 0."""

    def __init__(self):
        self.calls = 0

    @staticmethod
    def vector_at(f0: float) -> np.ndarray:
        pos = (np.log(f0) - np.log(60)) / (np.log(400) - np.log(60)) * (DIM - 1)
        v = np.exp(-0.5 * ((np.arange(DIM) - pos) / 6.0) ** 2)
        return (v / np.linalg.norm(v)).astype(np.float32)

    def embed_batch(self, waves):
        self.calls += 1
        return np.stack([self.vector_at(pitch(w)) for w in waves])


def cohort(count: int = 120, seed: int = 5) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return np.stack([PitchEmbedder.vector_at(f) for f in rng.uniform(70, 380, count)])


class FakeTranscriber:
    """Returns the queued texts in order (default: one fixed command)."""

    def __init__(self, *texts: str):
        self.texts = list(texts) or ["mở mái che"]
        self.calls = 0

    def transcribe(self, audio):
        self.calls += 1
        return self.texts[min(self.calls - 1, len(self.texts) - 1)]


class MemoryStore:
    def __init__(self):
        self.profiles: dict[str, Profile] = {}
        self.templates: dict[str, list[tuple[int, str, bytes]]] = {}
        self.clip_rows: dict[str, list[tuple[int, str, bytes]]] = {}
        self.models: dict[str, tuple[int, TrainedModel, datetime]] = {}
        self.attempts: list[dict] = []
        self._id = 0

    def _next(self) -> int:
        self._id += 1
        return self._id

    def load(self, account_id, with_model=True):
        profile = self.profiles.get(account_id)
        if profile is None:
            return None
        model = self.models.get(account_id) if with_model else None
        return Bundle(profile=profile,
                      templates=[Template(id=i, source=s, vector=from_bytes(b)) for i, s, b in self.templates[account_id]],
                      model=model[1] if model else None, model_version=model[0] if model else 0)

    def exists(self, account_id):
        return account_id in self.profiles

    def clips(self, account_id):
        rows = self.clip_rows.get(account_id, [])
        return [b for _, k, b in rows if k == "bonafide"], [b for _, k, b in rows if k == "spoof"]

    def counts(self, account_id):
        templates, clips = {}, {}
        for _, source, _ in self.templates.get(account_id, []):
            templates[source] = templates.get(source, 0) + 1
        for _, kind, _ in self.clip_rows.get(account_id, []):
            clips[kind] = clips.get(kind, 0) + 1
        model = self.models.get(account_id)
        mine = [a for a in self.attempts
                if a["account_id"] == account_id and a["kind"] == "verify" and not a["for_command"]]
        return {
            "templates": templates, "clips": clips,
            "model": (model[0], model[1].stats, model[2]) if model else None,
            "attempts": (sum(a["accepted"] for a in mine), sum(not a["accepted"] for a in mine),
                         max((a["at"] for a in mine), default=None)),
        }

    def create(self, profile, vectors, clips, model):
        if profile.account_id in self.profiles:
            raise profile_exists()
        self.profiles[profile.account_id] = profile
        self.templates[profile.account_id] = [(self._next(), "enroll", to_bytes(v)) for v in vectors]
        self.clip_rows[profile.account_id] = [(self._next(), "bonafide", c) for c in clips]
        self.models[profile.account_id] = (1, model, datetime.now(timezone.utc))

    def delete(self, account_id):
        self.attempts = [a for a in self.attempts if a["account_id"] != account_id]
        found = self.profiles.pop(account_id, None) is not None
        for table in (self.templates, self.clip_rows, self.models):
            table.pop(account_id, None)
        return found

    def add_template(self, account_id, vector, source):
        if account_id not in self.profiles:
            return False
        rows = self.templates[account_id]
        rows.append((self._next(), source, to_bytes(vector)))
        while len(rows) > MAX_TEMPLATES:
            removable = sorted((r for r in rows if r[1] != "enroll"), key=lambda r: (r[1] != "auto", r[0]))
            rows.remove(removable[0])
        return True

    def add_clips(self, account_id, kind, clips):
        if account_id not in self.profiles:
            return
        rows = self.clip_rows[account_id]
        rows.extend((self._next(), kind, c) for c in clips)
        keep = MAX_BONAFIDE_CLIPS if kind == "bonafide" else MAX_SPOOF_CLIPS
        mine = [r for r in rows if r[1] == kind]
        for row in mine[: max(0, len(mine) - keep)]:
            rows.remove(row)

    def save_model(self, account_id, model):
        if account_id not in self.profiles:
            return None
        version = self.models[account_id][0] + 1 if account_id in self.models else 1
        self.models[account_id] = (version, model, datetime.now(timezone.utc))
        return version

    def set_thresholds(self, account_id, thresholds: Thresholds):
        old = self.profiles[account_id]
        self.profiles[account_id] = Profile(old.account_id, old.consent_at, old.noise_floor_rms, thresholds,
                                            datetime.now(timezone.utc), old.created_at)

    def record_attempt(self, account_id, kind, accepted, reason, scores, duration_ms, for_command=False):
        self.attempts.append({"account_id": account_id, "kind": kind, "accepted": accepted, "reason": reason,
                              "scores": scores, "duration_ms": duration_ms, "for_command": for_command,
                              "at": datetime.now(timezone.utc)})

    def purge_attempts(self, days):
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        before = len(self.attempts)
        self.attempts = [a for a in self.attempts if a["at"] >= cutoff]
        return before - len(self.attempts)
