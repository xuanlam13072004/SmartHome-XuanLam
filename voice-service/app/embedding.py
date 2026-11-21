"""Speaker embeddings: ECAPA-TDNN (SpeechBrain, VoxCeleb), 192 numbers per voice."""
from __future__ import annotations

import threading
from typing import Protocol

import numpy as np

from .audio import SAMPLE_RATE

DIM = 192
WINDOW = 2 * SAMPLE_RATE
WINDOW_HOP = SAMPLE_RATE
MAX_WINDOWS = 4


class Embedder(Protocol):
    def embed_batch(self, waves: list[np.ndarray]) -> np.ndarray:
        """(n, 192) unit vectors, one per 16 kHz waveform."""


def unit(vector: np.ndarray) -> np.ndarray:
    v = np.asarray(vector, dtype=np.float32).reshape(-1)
    return (v / (float(np.linalg.norm(v)) + 1e-9)).astype(np.float32)


def embed_speech(embedder: Embedder, voiced: np.ndarray) -> np.ndarray:
    """Multi-view embedding: the whole utterance plus 2 s windows of it, averaged.
    Robust to a cough or a stumble in one part of the sentence."""
    views = [voiced]
    if len(voiced) >= 3 * SAMPLE_RATE:
        for start in range(0, len(voiced) - WINDOW + 1, WINDOW_HOP):
            views.append(voiced[start: start + WINDOW])
            if len(views) > MAX_WINDOWS:
                break
    vectors = np.asarray(embedder.embed_batch(views), dtype=np.float32)
    return unit(vectors.mean(axis=0))


def to_bytes(vector: np.ndarray) -> bytes:
    return unit(vector).astype("<f4").tobytes()


def from_bytes(data: bytes) -> np.ndarray:
    return np.frombuffer(data, dtype="<f4").astype(np.float32)


class EcapaEmbedder:
    """Loads the model downloaded into the image at build time (Dockerfile)."""

    def __init__(self, model_dir: str):
        import torch
        from speechbrain.inference.speaker import EncoderClassifier

        self._torch = torch
        self._model = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir=model_dir,
            run_opts={"device": "cpu"},
        )
        self._model.eval()
        self._lock = threading.Lock()

    def embed_batch(self, waves: list[np.ndarray]) -> np.ndarray:
        torch = self._torch
        longest = max(len(w) for w in waves)
        batch = np.zeros((len(waves), longest), dtype=np.float32)
        for i, wave in enumerate(waves):
            batch[i, : len(wave)] = wave
        lengths = torch.tensor([len(w) / longest for w in waves], dtype=torch.float32)
        # SpeechBrain modules keep per-call state in places; one batch at a time.
        with self._lock, torch.no_grad():
            out = self._model.encode_batch(torch.from_numpy(batch), lengths)
        vectors = out.reshape(len(waves), -1).cpu().numpy().astype(np.float32)
        return vectors / (np.linalg.norm(vectors, axis=1, keepdims=True) + 1e-9)
