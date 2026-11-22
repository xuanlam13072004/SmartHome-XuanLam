"""What voice-service does, independent of HTTP: enroll, verify, calibrate,
add samples, learn replays, delete. All methods are blocking (CPU and
database); app/main.py runs them in worker threads."""
from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Callable

import numpy as np

from . import antispoof as spoof
from .asr import Transcriber, clean_transcript
from .audio import PROFILE_RULE, SPOOF_RULE, VERIFY_RULE, Speech, analyze, decode, noise_floor
from .embedding import Embedder, embed_speech
from .errors import VoiceError, not_found, quality
from .scoring import (
    AUTO_UPDATE_ANTI_SPOOF, AUTO_UPDATE_SIMILARITY, AUTO_UPDATE_SNR_DB, DUPLICATE_SIMILARITY,
    ENROLL_MIN_CONSISTENCY, MAX_TEMPLATES, SAMPLE_MIN_SIMILARITY, Scores, Thresholds,
    as_norm, calibrate, centroid, cosine, decide, fuse,
)
from .store import Bundle, Profile, profile_exists

log = logging.getLogger("voice.service")

MIN_ENROLL, MAX_ENROLL = 3, 5
MIN_CALIBRATE, MAX_CALIBRATE = 3, 5
MAX_SPOOF_UPLOAD = 5


def _iso(value: datetime | None) -> str | None:
    return None if value is None else value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _read(data: bytes, rule, index: int | None = None, noise: float | None = None) -> Speech:
    try:
        return analyze(decode(data), rule, noise)
    except VoiceError as error:
        raise error.with_details(sample=index) if index is not None else error


class TrainingQueue:
    """Retrains anti-spoof models one at a time in the background. A request
    made while a profile is training queues exactly one more run for it."""

    def __init__(self, job: Callable[[str], None]):
        self._job = job
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="antispoof")
        self._lock = threading.Lock()
        self._queued: set[str] = set()
        self._running: set[str] = set()

    def schedule(self, account_id: str) -> None:
        with self._lock:
            if account_id in self._queued:
                return
            self._queued.add(account_id)
        self._executor.submit(self._run, account_id)

    def _run(self, account_id: str) -> None:
        with self._lock:
            self._queued.discard(account_id)
            self._running.add(account_id)
        try:
            self._job(account_id)
        except Exception:  # noqa: BLE001 - keep the worker alive
            log.exception("Anti-spoof training failed")
        finally:
            with self._lock:
                self._running.discard(account_id)

    def is_training(self, account_id: str) -> bool:
        with self._lock:
            return account_id in self._queued or account_id in self._running

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)


class VoiceService:
    def __init__(self, store, embedder: Embedder, backend: spoof.Backend, cohort: np.ndarray | None,
                 background_training: bool = True, transcriber: Transcriber | None = None):
        self.store = store
        self.embedder = embedder
        self.backend = backend
        self.cohort = cohort
        self.transcriber = transcriber
        self.queue = TrainingQueue(self.retrain) if background_training else None

    # --- helpers -------------------------------------------------------------

    def _bundle(self, account_id: str, with_model: bool = True) -> Bundle:
        bundle = self.store.load(account_id, with_model=with_model)
        if bundle is None:
            raise not_found()
        return bundle

    def _schedule(self, account_id: str) -> None:
        if self.queue is None:
            self.retrain(account_id)
        else:
            self.queue.schedule(account_id)

    def _score(self, bundle: Bundle, speech: Speech) -> tuple[np.ndarray, Scores]:
        if bundle.model is None:
            raise VoiceError(409, "VOICE_PROFILE_NOT_READY", "Hồ sơ giọng nói đang được chuẩn bị, hãy thử lại sau.")
        probe = embed_speech(self.embedder, speech.voiced)
        enrolled = centroid(np.stack([t.vector for t in bundle.templates]))
        similarity = cosine(probe, enrolled)
        normalized = as_norm(similarity, enrolled, probe, self.cohort)
        anti = spoof.score_span(self.backend, bundle.model, speech.span,
                                cache_key=(bundle.profile.account_id, bundle.model_version))
        return probe, Scores(similarity=similarity, normalized=normalized, anti_spoof=anti,
                             fusion=fuse(similarity, anti, speech.snr_db), snr_db=speech.snr_db)

    def _thresholds(self, bundle: Bundle) -> dict:
        t = bundle.profile.thresholds
        return {
            "mode": "as_norm" if self.cohort is not None else "cosine",
            "speaker": round(t.speaker, 4),
            "norm": round(t.norm, 3),
            "fusion": round(t.fusion, 4),
            "anti_spoof": None if bundle.model is None else bundle.model.stats.get("floor"),
        }

    # --- profile ---------------------------------------------------------------

    def summary(self, account_id: str) -> dict:
        bundle = self._bundle(account_id)
        counts = self.store.counts(account_id)
        model = counts["model"]
        stats = model[1] if model else {}
        accepted, rejected, last_at = counts["attempts"]
        profile = bundle.profile
        return {
            "enrolled": True,
            "consent_at": _iso(profile.consent_at),
            "created_at": _iso(profile.created_at),
            "calibrated_at": _iso(profile.calibrated_at),
            "noise_floor_db": round(20 * float(np.log10(profile.noise_floor_rms)), 1),
            "thresholds": self._thresholds(bundle),
            "templates": {
                "enroll": counts["templates"].get("enroll", 0),
                "sample": counts["templates"].get("sample", 0),
                "auto": counts["templates"].get("auto", 0),
                "max": MAX_TEMPLATES,
            },
            "anti_spoof": {
                "version": model[0] if model else 0,
                "trained_at": _iso(model[2]) if model else None,
                "training": bool(self.queue and self.queue.is_training(account_id)),
                "bonafide_clips": counts["clips"].get("bonafide", 0),
                "spoof_clips": counts["clips"].get("spoof", 0),
                "max_spoof_clips": spoof.MAX_SPOOF_CLIPS,
                "separation": stats.get("separation"),
                "weak": bool(stats.get("weak", False)),
            },
            "attempts_30d": {"accepted": accepted, "rejected": rejected, "last_at": _iso(last_at)},
        }

    def enroll(self, account_id: str, ambient: bytes, samples: list[bytes], consent: bool) -> dict:
        if not consent:
            raise VoiceError(400, "VOICE_CONSENT_REQUIRED", "Cần đồng ý cho lưu đặc trưng giọng nói trước khi đăng ký.")
        if not MIN_ENROLL <= len(samples) <= MAX_ENROLL:
            raise VoiceError(400, "VOICE_SAMPLE_COUNT", f"Cần {MIN_ENROLL} đến {MAX_ENROLL} câu ghi âm.")
        if self.store.exists(account_id):
            raise profile_exists()
        try:
            noise = noise_floor(decode(ambient))
        except VoiceError as error:
            raise error.with_details(sample="ambient")
        speeches = [_read(data, PROFILE_RULE, i, noise) for i, data in enumerate(samples)]
        vectors = [embed_speech(self.embedder, s.voiced) for s in speeches]
        for i, vector in enumerate(vectors):
            others = centroid(np.stack([v for j, v in enumerate(vectors) if j != i]))
            if cosine(vector, others) < ENROLL_MIN_CONSISTENCY:
                raise quality("VOICE_INCONSISTENT",
                              f"Câu thứ {i + 1} nghe không giống các câu còn lại, hãy ghi âm lại câu đó.").with_details(sample=i)
        clips = [spoof.best_clip(s.span) for s in speeches]
        model = spoof.train_profile(self.backend, clips, [])
        profile = Profile(account_id=account_id, consent_at=datetime.now(timezone.utc), noise_floor_rms=noise,
                          thresholds=Thresholds(), calibrated_at=None, created_at=datetime.now(timezone.utc))
        self.store.create(profile, vectors, [spoof.clip_to_bytes(c) for c in clips], model)
        log.info("Voice profile enrolled")
        return self.summary(account_id)

    def delete(self, account_id: str) -> None:
        if not self.store.delete(account_id):
            raise not_found()

    # --- verification ----------------------------------------------------------

    def verify(self, account_id: str, audio: bytes) -> dict:
        return self._verify(self._bundle(account_id), _read(audio, VERIFY_RULE), for_command=False)

    def listen(self, account_id: str, audio: bytes) -> dict:
        """A spoken command: its text, and whether it is the owner's live voice
        (null without a voice profile). The Gateway decides whether the
        command needs that verification."""
        if self.transcriber is None:
            raise VoiceError(503, "VOICE_ASR_UNAVAILABLE", "Chưa nhận dạng được lời nói, hãy thử lại sau.")
        speech = _read(audio, VERIFY_RULE)
        transcript = clean_transcript(self.transcriber.transcribe(speech.span))
        if not transcript:
            raise quality("VOICE_NOT_UNDERSTOOD", "Không nghe rõ lời nói, hãy nói lại.")
        bundle = self.store.load(account_id)
        verification = None
        if bundle is not None and bundle.model is not None:
            verification = self._verify(bundle, speech, for_command=True)
        return {"transcript": transcript, "speech_ms": speech.speech_ms, "snr_db": round(speech.snr_db, 1),
                "verification": verification}

    def _verify(self, bundle: Bundle, speech: Speech, for_command: bool) -> dict:
        account_id = bundle.profile.account_id
        probe, scores = self._score(bundle, speech)
        thresholds = self._thresholds(bundle)
        accepted, reason = decide(scores, bundle.profile.thresholds, thresholds["anti_spoof"])
        self.store.record_attempt(account_id, "verify", accepted, reason, scores, speech.speech_ms, for_command)
        updated = False
        if (accepted and scores.similarity > AUTO_UPDATE_SIMILARITY and scores.anti_spoof > AUTO_UPDATE_ANTI_SPOOF
                and scores.snr_db >= AUTO_UPDATE_SNR_DB
                and max(cosine(probe, t.vector) for t in bundle.templates) < DUPLICATE_SIMILARITY):
            # Voices drift (a cold, a new phone): very confident matches keep the profile current.
            updated = self.store.add_template(account_id, probe, "auto")
        return {"accepted": accepted, "reason": reason, "scores": scores.as_dict(),
                "thresholds": thresholds, "gallery_updated": updated}

    def calibrate(self, account_id: str, samples: list[bytes]) -> dict:
        if not MIN_CALIBRATE <= len(samples) <= MAX_CALIBRATE:
            raise VoiceError(400, "VOICE_SAMPLE_COUNT", f"Cần {MIN_CALIBRATE} đến {MAX_CALIBRATE} câu ghi âm.")
        bundle = self._bundle(account_id)
        trials: list[tuple[Scores, int]] = []
        for i, data in enumerate(samples):
            speech = _read(data, PROFILE_RULE, i)
            _, scores = self._score(bundle, speech)
            if scores.similarity < SAMPLE_MIN_SIMILARITY:
                raise VoiceError(422, "VOICE_MISMATCH", f"Câu thứ {i + 1} không giống giọng đã đăng ký.",
                                 {"sample": i})
            trials.append((scores, speech.speech_ms))
        new = calibrate([t[0] for t in trials], bundle.profile.thresholds)
        self.store.set_thresholds(account_id, new)
        floor = bundle.model.stats.get("floor") if bundle.model else 1.0
        results = []
        for scores, ms in trials:
            accepted, reason = decide(scores, new, floor)
            self.store.record_attempt(account_id, "calibrate", accepted, reason, scores, ms)
            results.append({**scores.as_dict(), "accepted": accepted, "reason": reason})
        return {"summary": self.summary(account_id), "trials": results}

    # --- learning ----------------------------------------------------------------

    def add_sample(self, account_id: str, audio: bytes) -> dict:
        bundle = self._bundle(account_id, with_model=False)
        speech = _read(audio, PROFILE_RULE)
        probe = embed_speech(self.embedder, speech.voiced)
        if cosine(probe, centroid(np.stack([t.vector for t in bundle.templates]))) < SAMPLE_MIN_SIMILARITY:
            raise VoiceError(422, "VOICE_MISMATCH", "Mẫu này không giống giọng đã đăng ký.")
        if max(cosine(probe, t.vector) for t in bundle.templates) >= DUPLICATE_SIMILARITY:
            raise VoiceError(422, "VOICE_DUPLICATE", "Mẫu này trùng với một mẫu đã có.")
        self.store.add_template(account_id, probe, "sample")
        self.store.add_clips(account_id, "bonafide", [spoof.clip_to_bytes(spoof.best_clip(speech.span))])
        self._schedule(account_id)
        return self.summary(account_id)

    def add_spoof(self, account_id: str, samples: list[bytes]) -> dict:
        """Replays of the owner's voice (another phone's speaker, a recording):
        the anti-spoof model learns to reject exactly these."""
        if not 1 <= len(samples) <= MAX_SPOOF_UPLOAD:
            raise VoiceError(400, "VOICE_SAMPLE_COUNT", f"Gửi từ 1 đến {MAX_SPOOF_UPLOAD} bản phát lại.")
        self._bundle(account_id, with_model=False)
        clips = [spoof.clip_to_bytes(spoof.best_clip(_read(data, SPOOF_RULE, i).span)) for i, data in enumerate(samples)]
        self.store.add_clips(account_id, "spoof", clips)
        self._schedule(account_id)
        return self.summary(account_id)

    def retrain(self, account_id: str) -> None:
        bonafide, spoofs = self.store.clips(account_id)
        if len(bonafide) < spoof.MIN_BONAFIDE_CLIPS:
            return
        model = spoof.train_profile(self.backend, [spoof.clip_from_bytes(c) for c in bonafide],
                                    [spoof.clip_from_bytes(c) for c in spoofs])
        version = self.store.save_model(account_id, model)
        log.info("Anti-spoof model retrained (version %s, separation %.3f)", version, model.stats["separation"])
