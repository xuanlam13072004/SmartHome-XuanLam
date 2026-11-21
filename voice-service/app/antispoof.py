"""Per-profile anti-spoof: tells the owner's live voice from a replay through a
speaker or a synthetic voice. Each profile trains its own small RawNet2-style
model (app/rawnet.py) on its own voice, simulated replays and the replays the
owner recorded. This module holds everything except the neural network, so
the same rules apply to the real model and to the test double."""
from __future__ import annotations

import io
import time
from dataclasses import dataclass
from typing import Protocol

import numpy as np

from .audio import SAMPLE_RATE

CLIP_LEN = 2 * SAMPLE_RATE
MAX_BONAFIDE_CLIPS = 10
MAX_SPOOF_CLIPS = 20
MIN_BONAFIDE_CLIPS = 2
SCORE_CROPS = 3
FLOOR_BAND = (0.30, 0.70)
# Below this separation the model cannot tell the classes apart.
WEAK_SEPARATION = 0.15


class Backend(Protocol):
    def train(self, x: np.ndarray, y: np.ndarray, seed: int) -> tuple[bytes, dict]:
        """Weights and training facts (epochs, loss) from clips (n, CLIP_LEN), labels 1=bonafide."""

    def predict(self, weights: bytes, x: np.ndarray, cache_key: object = None) -> np.ndarray:
        """Probability of bonafide per clip."""


# --- clips -------------------------------------------------------------------

def best_clip(span: np.ndarray) -> np.ndarray:
    """The loudest 2 s of speech (what is stored for training)."""
    if len(span) <= CLIP_LEN:
        return span.astype(np.float32)
    hop = SAMPLE_RATE // 4
    starts = range(0, len(span) - CLIP_LEN + 1, hop)
    best = max(starts, key=lambda s: float(np.sum(np.square(span[s: s + CLIP_LEN], dtype=np.float64))))
    return span[best: best + CLIP_LEN].astype(np.float32)


def crops(span: np.ndarray, count: int = SCORE_CROPS) -> list[np.ndarray]:
    """Up to `count` 2 s windows spread over the speech (what is scored)."""
    if len(span) <= CLIP_LEN:
        return [span.astype(np.float32)]
    starts = np.linspace(0, len(span) - CLIP_LEN, num=count).astype(int)
    return [span[s: s + CLIP_LEN].astype(np.float32) for s in sorted(set(starts.tolist()))]


def prepare(clip: np.ndarray) -> np.ndarray:
    x = np.asarray(clip, dtype=np.float32).reshape(-1)[:CLIP_LEN]
    if len(x) < CLIP_LEN:
        x = np.pad(x, (0, CLIP_LEN - len(x)))
    x = x - float(np.mean(x))
    return (x / (float(np.max(np.abs(x))) + 1e-8)).astype(np.float32)


def clip_to_bytes(clip: np.ndarray) -> bytes:
    return np.clip(np.asarray(clip, dtype=np.float32)[:CLIP_LEN], -1, 1).astype("<f2").tobytes()


def clip_from_bytes(data: bytes) -> np.ndarray:
    return np.frombuffer(data, dtype="<f2").astype(np.float32)


# --- simulated attacks and augmentation (from the original system) ------------

def simulate_replay(x: np.ndarray) -> np.ndarray:
    blurred = np.convolve(x, np.array([0.15, 0.7, 0.15], dtype=np.float32), mode="same")
    delayed = np.roll(blurred, 200) * 0.25
    hum = 0.005 * np.sin(np.linspace(0, 120 * np.pi, len(x), dtype=np.float32))
    return np.clip(0.9 * blurred + delayed + hum, -1, 1).astype(np.float32)


def simulate_phone_speaker(x: np.ndarray) -> np.ndarray:
    spectrum = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(len(x), d=1.0 / SAMPLE_RATE)
    spectrum[(freqs < 300.0) | (freqs > 3400.0)] *= 0.05
    y = np.fft.irfft(spectrum, n=len(x)).astype(np.float32)
    return np.clip(np.tanh(1.8 * y), -1, 1).astype(np.float32)


def simulate_tts_like(x: np.ndarray) -> np.ndarray:
    q = np.round(x * 64.0) / 64.0
    env = np.convolve(np.abs(q), np.ones(80, dtype=np.float32) / 80.0, mode="same")
    return np.clip(q * (0.7 + 0.3 * env), -1, 1).astype(np.float32)


SIMULATIONS = (simulate_replay, simulate_phone_speaker, simulate_tts_like)


def augment(x: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """A plausible other take of the same clip: shifted, with faint room noise."""
    y = np.roll(x, int(rng.integers(-SAMPLE_RATE // 5, SAMPLE_RATE // 5)))
    level = float(np.sqrt(np.mean(np.square(y), dtype=np.float64))) * 10 ** (-float(rng.uniform(30, 40)) / 20)
    return (y + rng.normal(0, level, len(y))).astype(np.float32)


# --- hand-made artifact features (complement the network) ---------------------

def artifact_features(clip: np.ndarray) -> np.ndarray:
    x = prepare(clip)
    n_fft, hop = 512, 160
    window = np.hanning(n_fft)
    count = 1 + (len(x) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(count)[:, None]
    mag = np.abs(np.fft.rfft(x[idx] * window, axis=1)) + 1e-8
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / SAMPLE_RATE)

    def band(low: float, high: float) -> float:
        sel = (freqs >= low) & (freqs < high)
        return float(np.mean(mag[:, sel]))

    low, mid, high = band(80, 1000), band(1000, 3500), band(3500, 7600)
    total = low + mid + high + 1e-8
    frame_energy = np.mean(mag, axis=1)
    return np.array([
        high / total,
        mid / total,
        float(np.exp(np.mean(np.log(mag))) / np.mean(mag)),  # spectral flatness
        float(np.mean(np.abs(np.diff(x)))),
        float(np.mean(np.abs(np.diff(np.sign(x))) > 0)),  # zero-crossing rate
        float(np.std(frame_energy) / (np.mean(frame_energy) + 1e-8)),
    ], dtype=np.float32)


# --- training ----------------------------------------------------------------

def _datasets(bonafide: list[np.ndarray], spoof: list[np.ndarray], rng: np.random.Generator, train: bool):
    """Bonafide clips (plus another take each when training), simulated attacks
    of them, and the owner's recorded replays, newest first and balanced."""
    takes = bonafide + [augment(c, rng) for c in bonafide] if train else [augment(c, rng) for c in bonafide]
    real = spoof[-max(8, 2 * len(bonafide)):]
    attacks = [simulate(c if train else augment(c, rng)) for c in bonafide for simulate in SIMULATIONS]
    attacks += real if train else [augment(c, rng) for c in real]
    if train:
        attacks += [augment(c, rng) for c in real]
    return [prepare(c) for c in takes], [prepare(c) for c in attacks]


def _margin(prob: np.ndarray | float, stats: dict) -> np.ndarray:
    separation = max(1e-3, stats["prob_bonafide"] - stats["prob_spoof"])
    return np.clip((np.asarray(prob) - stats["prob_spoof"]) / separation, 0.0, 1.0)


def _artifact_score(features: np.ndarray, stats: dict) -> np.ndarray:
    def closeness(prefix: str) -> np.ndarray:
        mean = np.asarray(stats[f"{prefix}_feature_mean"], dtype=np.float32)
        std = np.asarray(stats[f"{prefix}_feature_std"], dtype=np.float32)
        z = np.mean(np.abs((features - mean) / std), axis=-1)
        return 1.0 / (1.0 + np.exp(-np.clip(2.2 - z, -50.0, 50.0)))

    return np.clip(0.65 * closeness("bonafide") + 0.35 * (1.0 - closeness("spoof")), 0.0, 1.0)


def combine(probs: np.ndarray, features: np.ndarray, stats: dict) -> np.ndarray:
    """0..1 per clip: the network's margin between the two classes, with the
    hand-made features as a second opinion."""
    return 0.75 * _margin(probs, stats) + 0.25 * _artifact_score(features, stats)


@dataclass(frozen=True)
class TrainedModel:
    weights: bytes
    stats: dict


def train_profile(backend: Backend, bonafide: list[np.ndarray], spoof: list[np.ndarray], seed: int = 13) -> TrainedModel:
    if len(bonafide) < MIN_BONAFIDE_CLIPS:
        raise ValueError("At least two bonafide clips are needed.")
    rng = np.random.default_rng(seed)
    bona_train, spoof_train = _datasets(bonafide, spoof, rng, train=True)
    x = np.stack(bona_train + spoof_train)
    y = np.concatenate([np.ones(len(bona_train)), np.zeros(len(spoof_train))]).astype(np.float32)
    weights, facts = backend.train(x, y, seed)

    bona_features = np.stack([artifact_features(c) for c in bona_train])
    spoof_features = np.stack([artifact_features(c) for c in spoof_train])
    # Score statistics come from takes the model was not trained on.
    bona_check, spoof_check = _datasets(bonafide, spoof, np.random.default_rng(seed + 1), train=False)
    prob_b = backend.predict(weights, np.stack(bona_check))
    prob_s = backend.predict(weights, np.stack(spoof_check))
    stats = {
        "prob_bonafide": float(np.mean(prob_b)),
        "prob_spoof": float(np.mean(prob_s)),
        "bonafide_feature_mean": bona_features.mean(axis=0).tolist(),
        "bonafide_feature_std": (bona_features.std(axis=0) + 1e-6).tolist(),
        "spoof_feature_mean": spoof_features.mean(axis=0).tolist(),
        "spoof_feature_std": (spoof_features.std(axis=0) + 1e-6).tolist(),
    }
    score_b = combine(prob_b, np.stack([artifact_features(c) for c in bona_check]), stats)
    score_s = combine(prob_s, np.stack([artifact_features(c) for c in spoof_check]), stats)
    mean_b, mean_s = float(np.mean(score_b)), float(np.mean(score_s))
    separation = mean_b - mean_s
    floor = FLOOR_BAND[0] if separation < WEAK_SEPARATION else float(
        np.clip(mean_s + 0.5 * separation, FLOOR_BAND[0], FLOOR_BAND[1]))
    stats.update({
        "score_bonafide": round(mean_b, 4),
        "score_spoof": round(mean_s, 4),
        "separation": round(separation, 4),
        "floor": round(floor, 4),
        "weak": separation < WEAK_SEPARATION,
        "bonafide_clips": len(bonafide),
        "spoof_clips": len(spoof),
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        **facts,
    })
    return TrainedModel(weights=weights, stats=stats)


def score_span(backend: Backend, model: TrainedModel, span: np.ndarray, cache_key: object = None) -> float:
    clips = [prepare(c) for c in crops(span)]
    probs = backend.predict(model.weights, np.stack(clips), cache_key)
    features = np.stack([artifact_features(c) for c in clips])
    return float(np.mean(combine(probs, features, model.stats)))


# --- a backend without PyTorch (tests, evaluation dry runs) -------------------

class FeatureLogisticBackend:
    """Logistic regression on the artifact features. Weak, but trains in
    milliseconds with numpy only; used by the tests in place of RawNet2."""

    def train(self, x: np.ndarray, y: np.ndarray, seed: int) -> tuple[bytes, dict]:
        f = np.stack([artifact_features(c) for c in x])
        mean, std = f.mean(axis=0), f.std(axis=0) + 1e-6
        z = (f - mean) / std
        w, b = np.zeros(z.shape[1]), 0.0
        pos = max(1.0, float(np.sum(y == 0)) / max(1.0, float(np.sum(y == 1))))
        sample_w = np.where(y == 1, pos, 1.0)
        for _ in range(400):
            p = 1 / (1 + np.exp(-(z @ w + b)))
            grad = (p - y) * sample_w
            w -= 0.1 * (z.T @ grad) / len(y)
            b -= 0.1 * float(np.mean(grad))
        buffer = io.BytesIO()
        np.savez(buffer, w=w, b=b, mean=mean, std=std)
        return buffer.getvalue(), {"backend": "feature-logistic", "epochs": 400}

    def predict(self, weights: bytes, x: np.ndarray, cache_key: object = None) -> np.ndarray:
        data = np.load(io.BytesIO(weights))
        f = np.stack([artifact_features(c) for c in x])
        z = (f - data["mean"]) / data["std"]
        return 1 / (1 + np.exp(-(z @ data["w"] + float(data["b"]))))
