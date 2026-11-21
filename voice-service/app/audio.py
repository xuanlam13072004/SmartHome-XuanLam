"""Decoding and judging recordings. Every recording goes through the same steps
(the app records them the same way: 16 kHz mono WAV), so enrollment and
verification compare like with like."""
from __future__ import annotations

import io
from dataclasses import dataclass
from math import gcd

import numpy as np

from .errors import invalid_audio, quality

SAMPLE_RATE = 16000
MAX_SECONDS = 15.0
FRAME = 400  # 25 ms
HOP = 160  # 10 ms
PAD = 1600  # 100 ms kept around speech


@dataclass(frozen=True)
class QualityRule:
    min_speech_ms: int
    min_snr_db: float
    max_clipped: float


# Enrollment-grade recordings become part of the profile; verification only
# has to be clear enough to judge; recorded replays are naturally degraded.
PROFILE_RULE = QualityRule(min_speech_ms=1500, min_snr_db=12.0, max_clipped=0.01)
VERIFY_RULE = QualityRule(min_speech_ms=800, min_snr_db=8.0, max_clipped=0.01)
SPOOF_RULE = QualityRule(min_speech_ms=1000, min_snr_db=3.0, max_clipped=0.05)


@dataclass(frozen=True)
class Speech:
    voiced: np.ndarray  # speech frames only, loudness-normalized (speaker embedding)
    span: np.ndarray  # first to last speech frame, untouched (anti-spoof)
    speech_ms: int
    snr_db: float
    noise_rms: float
    clipped: float


def decode(data: bytes) -> np.ndarray:
    """WAV (any rate, any channels) -> float32 mono 16 kHz."""
    import soundfile as sf
    from scipy.signal import resample_poly

    try:
        audio, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    except Exception as exc:  # noqa: BLE001 - any decoder failure is a bad upload
        raise invalid_audio() from exc
    if audio.size == 0 or rate < 8000:
        raise invalid_audio()
    mono = audio.mean(axis=1)
    if len(mono) / rate > MAX_SECONDS:
        raise quality("VOICE_TOO_LONG", f"Bản ghi dài quá {int(MAX_SECONDS)} giây.")
    if rate != SAMPLE_RATE:
        g = gcd(SAMPLE_RATE, int(rate))
        mono = resample_poly(mono, SAMPLE_RATE // g, int(rate) // g).astype(np.float32)
    return np.clip(mono, -1.0, 1.0).astype(np.float32)


def frame_rms(x: np.ndarray) -> np.ndarray:
    if len(x) < FRAME:
        return np.array([float(np.sqrt(np.mean(np.square(x), dtype=np.float64) + 1e-12))], dtype=np.float32)
    count = 1 + (len(x) - FRAME) // HOP
    idx = np.arange(FRAME)[None, :] + HOP * np.arange(count)[:, None]
    return np.sqrt(np.mean(np.square(x[idx], dtype=np.float64), axis=1) + 1e-12).astype(np.float32)


def noise_floor(ambient: np.ndarray) -> float:
    """Background level of a silent recording; refuses one with speech or loud noise in it."""
    if len(ambient) < SAMPLE_RATE:
        raise quality("VOICE_AMBIENT_TOO_SHORT", "Cần giữ im lặng ít nhất 1 giây.")
    rms = frame_rms(ambient - float(np.mean(ambient)))
    level = float(np.percentile(rms, 50))
    # Steady noise has a flat level; speech or a bang shows up as loud frames.
    if level > 0.02 or float(np.percentile(rms, 95)) > max(2 * level, 0.004):
        raise quality("VOICE_AMBIENT_NOISY", "Xung quanh đang ồn hoặc có tiếng nói, hãy tìm chỗ yên tĩnh hơn.")
    return max(level, 1e-4)


def analyze(x: np.ndarray, rule: QualityRule, noise_rms: float | None = None) -> Speech:
    """Finds the speech in a recording and checks it is good enough for `rule`.
    Without `noise_rms` the background is measured from the recording's quietest frames."""
    clipped = float(np.mean(np.abs(x) >= 0.999))
    x = (x - float(np.mean(x))).astype(np.float32)
    rms = frame_rms(x)
    noise = max(float(noise_rms) if noise_rms else float(np.percentile(rms, 10)), 1e-4)
    loud = float(np.percentile(rms, 90))
    # Loud frames against the background; independent of where speech is detected.
    snr_db = float(min(60.0, 20 * np.log10(max(loud, 1e-9) / noise)))
    voiced = rms >= max(2 * noise, 0.002)
    if not np.any(voiced) or loud < 2 * noise:
        raise quality("VOICE_NO_SPEECH", "Không nghe thấy giọng nói, hãy nói to và rõ hơn.")

    speech_ms = int(np.count_nonzero(voiced) * HOP * 1000 / SAMPLE_RATE)
    speech_rms = float(np.sqrt(np.mean(np.square(rms[voiced], dtype=np.float64))))
    if clipped > rule.max_clipped:
        raise quality("VOICE_CLIPPED", "Âm thanh bị rè vì nói quá sát micro, hãy cầm xa hơn một chút.")
    if speech_rms < 0.005:
        raise quality("VOICE_TOO_QUIET", "Giọng nói quá nhỏ, hãy nói to hơn.")
    if snr_db < rule.min_snr_db:
        raise quality("VOICE_TOO_NOISY", "Xung quanh quá ồn, hãy tìm chỗ yên tĩnh hơn.")
    if speech_ms < rule.min_speech_ms:
        raise quality("VOICE_TOO_SHORT", "Câu nói quá ngắn, hãy đọc hết câu.")

    keep = np.zeros(len(x), dtype=bool)
    starts = np.flatnonzero(voiced) * HOP
    for start in starts:
        keep[max(0, start - PAD): min(len(x), start + FRAME + PAD)] = True
    first, last = int(starts[0]), int(starts[-1])
    span = x[max(0, first - PAD): min(len(x), last + FRAME + PAD)].copy()
    speech = x[keep]
    gain = 0.05 / (float(np.sqrt(np.mean(np.square(speech), dtype=np.float64))) + 1e-9)
    voiced_audio = np.clip(speech * min(gain, 30.0), -1.0, 1.0).astype(np.float32)
    return Speech(voiced=voiced_audio, span=span, speech_ms=speech_ms, snr_db=snr_db, noise_rms=noise, clipped=clipped)
