"""The AS-norm cohort: embeddings of many strangers' voices (tools/build_cohort.py)."""
from __future__ import annotations

import logging
import os

import numpy as np

from .embedding import DIM
from .scoring import MIN_COHORT

log = logging.getLogger("voice.cohort")


def load_cohort(path: str) -> np.ndarray | None:
    if not path or not os.path.exists(path):
        log.info("No cohort at %s: speaker check uses raw cosine similarity", path)
        return None
    cohort = np.load(path).astype(np.float32)
    if cohort.ndim != 2 or cohort.shape[1] != DIM:
        raise RuntimeError(f"Cohort {path} must have shape (N, {DIM}), got {cohort.shape}")
    if len(cohort) < MIN_COHORT:
        log.warning("Cohort %s has %d voices (< %d): ignored", path, len(cohort), MIN_COHORT)
        return None
    cohort /= np.linalg.norm(cohort, axis=1, keepdims=True) + 1e-9
    log.info("Loaded AS-norm cohort: %d voices", len(cohort))
    return cohort
