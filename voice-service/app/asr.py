"""Speech to text: PhoWhisper-small (VinAI, Whisper fine-tuned on Vietnamese),
run with transformers + PyTorch as in the original system."""
from __future__ import annotations

import re
import threading
import unicodedata
from typing import Protocol

import numpy as np

from .audio import SAMPLE_RATE


class Transcriber(Protocol):
    def transcribe(self, audio: np.ndarray) -> str:
        """Vietnamese text of 16 kHz mono speech."""


# Whisper models trained on subtitles sometimes "hear" these in noise.
_HALLUCINATIONS = re.compile(
    r"subscribe|đăng ký kênh|ghiền mì gõ|cảm ơn các bạn đã (theo dõi|xem)|hẹn gặp lại các bạn trong",
    re.IGNORECASE,
)


def clean_transcript(text: str) -> str:
    """Normalized text, or '' when it is empty or a known hallucination."""
    text = re.sub(r"\s+", " ", unicodedata.normalize("NFC", text or "")).strip()
    if not re.search(r"\w", text) or _HALLUCINATIONS.search(text):
        return ""
    return text[:500]


class PhoWhisperTranscriber:
    def __init__(self, model_id: str):
        import torch
        from transformers import pipeline

        self._pipe = pipeline("automatic-speech-recognition", model=model_id, device="cpu", torch_dtype=torch.float32)
        generation = self._pipe.model.generation_config
        # Old checkpoints carry fixed decoder ids that conflict with `language=`.
        if getattr(generation, "forced_decoder_ids", None) is not None:
            generation.forced_decoder_ids = None
        self._legacy_ids = self._pipe.tokenizer.get_decoder_prompt_ids(language="vi", task="transcribe")
        # The pipeline keeps per-call state: one transcription at a time.
        self._lock = threading.Lock()

    def transcribe(self, audio: np.ndarray) -> str:
        sample = {"raw": np.asarray(audio, dtype=np.float32), "sampling_rate": SAMPLE_RATE}
        with self._lock:
            try:
                result = self._pipe(sample, generate_kwargs={"language": "vi", "task": "transcribe"})
            except (ValueError, TypeError):
                # Checkpoints without language tokens in their generation config.
                self._pipe.model.generation_config.forced_decoder_ids = self._legacy_ids
                result = self._pipe(sample)
        return str(result.get("text", ""))
