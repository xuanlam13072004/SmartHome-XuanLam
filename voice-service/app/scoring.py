"""Turning scores into a decision. Three checks must all pass:
1. speaker: the voice matches the profile (AS-norm score when a cohort is
   loaded, raw cosine otherwise);
2. anti-spoof: not a recording played back or a synthetic voice (hard floor);
3. fusion: the weighted sum of both is confidently high."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .embedding import unit

DEFAULT_SPEAKER = 0.68
DEFAULT_NORM = 3.0
DEFAULT_FUSION = 0.64
# With AS-norm the raw similarity must still be plausible for the same person.
NORM_COSINE_FLOOR = 0.45
COHORT_TOP_K = 200
MIN_COHORT = 50

# Calibration moves thresholds only inside these safe bands.
SPEAKER_BAND = (0.60, 0.80)
NORM_BAND = (2.5, 8.0)
FUSION_BAND = (0.55, 0.85)

AUTO_UPDATE_SIMILARITY = 0.85
AUTO_UPDATE_ANTI_SPOOF = 0.80
AUTO_UPDATE_SNR_DB = 12.0
# A sample added by the owner must at least resemble the profile.
SAMPLE_MIN_SIMILARITY = 0.50
DUPLICATE_SIMILARITY = 0.995
# Enrollment sentences must resemble each other (same person, clean audio).
ENROLL_MIN_CONSISTENCY = 0.55
MAX_TEMPLATES = 30


@dataclass(frozen=True)
class Thresholds:
    speaker: float = DEFAULT_SPEAKER
    norm: float = DEFAULT_NORM
    fusion: float = DEFAULT_FUSION


@dataclass(frozen=True)
class Scores:
    similarity: float
    normalized: float | None
    anti_spoof: float
    fusion: float
    snr_db: float

    def as_dict(self) -> dict:
        return {
            "similarity": round(self.similarity, 4),
            "normalized": None if self.normalized is None else round(self.normalized, 3),
            "anti_spoof": round(self.anti_spoof, 4),
            "fusion": round(self.fusion, 4),
            "snr_db": round(self.snr_db, 1),
        }


def centroid(templates: np.ndarray) -> np.ndarray:
    return unit(np.asarray(templates, dtype=np.float32).mean(axis=0))


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(unit(a), unit(b)))


def as_norm(score: float, enrolled: np.ndarray, probe: np.ndarray, cohort: np.ndarray | None) -> float | None:
    """Adaptive symmetric score normalization: how far the score stands out from
    the scores of the most similar strangers (cohort), seen from both sides."""
    if cohort is None or len(cohort) < MIN_COHORT:
        return None
    k = min(COHORT_TOP_K, len(cohort))

    def stats(vector: np.ndarray) -> tuple[float, float]:
        top = np.partition(cohort @ unit(vector), -k)[-k:]
        return float(top.mean()), float(top.std() + 1e-6)

    mean_e, std_e = stats(enrolled)
    mean_p, std_p = stats(probe)
    return 0.5 * ((score - mean_e) / std_e + (score - mean_p) / std_p)


def fuse(similarity: float, anti_spoof: float, snr_db: float) -> float:
    # In a clean recording the voice match is the stronger evidence.
    weight = 0.65 if snr_db >= 14.0 else 0.55
    return weight * similarity + (1.0 - weight) * anti_spoof


def decide(scores: Scores, thresholds: Thresholds, anti_spoof_floor: float) -> tuple[bool, str | None]:
    if scores.anti_spoof < anti_spoof_floor:
        return False, "spoof_suspected"
    if scores.normalized is not None:
        speaker_ok = scores.normalized >= thresholds.norm and scores.similarity >= NORM_COSINE_FLOOR
    else:
        speaker_ok = scores.similarity >= thresholds.speaker
    if not speaker_ok:
        return False, "not_matched"
    if scores.fusion < thresholds.fusion:
        return False, "low_confidence"
    return True, None


def _band(value: float, band: tuple[float, float]) -> float:
    return float(np.clip(value, band[0], band[1]))


def calibrate(trials: list[Scores], current: Thresholds) -> Thresholds:
    """Thresholds from the owner's own extra recordings: mean minus two standard
    deviations, kept inside the safe bands so the profile never becomes lax."""
    sims = np.array([t.similarity for t in trials])
    fusions = np.array([t.fusion for t in trials])
    norms = np.array([t.normalized for t in trials if t.normalized is not None])
    return Thresholds(
        speaker=_band(sims.mean() - 2 * sims.std(), SPEAKER_BAND),
        norm=_band(norms.mean() - 2 * norms.std(), NORM_BAND) if len(norms) == len(trials) else current.norm,
        fusion=_band(fusions.mean() - 2 * fusions.std(), FUSION_BAND),
    )
