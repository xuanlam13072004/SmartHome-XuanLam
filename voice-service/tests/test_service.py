import numpy as np
import pytest

from app import antispoof as sp
from app.errors import VoiceError
from app.scoring import MAX_TEMPLATES, NORM_BAND, SPEAKER_BAND
from app.service import VoiceService
from tests.fakes import MemoryStore, PitchEmbedder, ambient, cohort, voice, wav

ACCOUNT = "7f0c2a52-0000-4000-8000-000000000001"


def make(with_cohort=False):
    return VoiceService(MemoryStore(), PitchEmbedder(), sp.FeatureLogisticBackend(),
                        cohort() if with_cohort else None, background_training=False)


def enroll(service, f0=120, seeds=(1, 2, 3), account=ACCOUNT):
    return service.enroll(account, wav(ambient()), [wav(voice(f0, seed=s)) for s in seeds], consent=True)


def error(fn):
    with pytest.raises(VoiceError) as info:
        fn()
    return info.value


def test_enroll_builds_profile_gallery_and_anti_spoof_model():
    service = make()
    summary = enroll(service)
    assert summary["templates"] == {"enroll": 3, "sample": 0, "auto": 0, "max": MAX_TEMPLATES}
    assert summary["anti_spoof"]["version"] == 1 and summary["anti_spoof"]["bonafide_clips"] == 3
    assert summary["thresholds"]["mode"] == "cosine"
    assert summary["thresholds"]["anti_spoof"] is not None
    assert -61 < summary["noise_floor_db"] < -59
    assert summary["calibrated_at"] is None


def test_enroll_rules():
    service = make()
    assert error(lambda: service.enroll(ACCOUNT, b"", [], consent=False)).code == "VOICE_CONSENT_REQUIRED"
    assert error(lambda: service.enroll(ACCOUNT, b"", [b""] * 2, consent=True)).code == "VOICE_SAMPLE_COUNT"
    noisy_room = error(lambda: service.enroll(ACCOUNT, wav(voice(120)), [wav(voice(120))] * 3, consent=True))
    assert noisy_room.code == "VOICE_AMBIENT_NOISY" and noisy_room.details["sample"] == "ambient"
    short = error(lambda: service.enroll(ACCOUNT, wav(ambient()), [wav(voice(120)), wav(voice(120, seconds=1)),
                                                                   wav(voice(120))], consent=True))
    assert short.code == "VOICE_TOO_SHORT" and short.details["sample"] == 1
    # Someone else read the third sentence.
    mixed = error(lambda: service.enroll(ACCOUNT, wav(ambient()), [wav(voice(120, seed=1)), wav(voice(121, seed=2)),
                                                                   wav(voice(200, seed=3))], consent=True))
    assert mixed.code == "VOICE_INCONSISTENT" and mixed.details["sample"] == 2
    assert not service.store.exists(ACCOUNT)
    enroll(service)
    assert error(lambda: enroll(service)).code == "VOICE_PROFILE_EXISTS"


def test_verify_accepts_the_owner_and_rejects_others():
    service = make()
    enroll(service)
    owner = service.verify(ACCOUNT, wav(voice(121, seed=10)))
    assert owner["accepted"] and owner["reason"] is None
    assert owner["scores"]["similarity"] > 0.9 and owner["thresholds"]["mode"] == "cosine"
    stranger = service.verify(ACCOUNT, wav(voice(180, seed=11)))
    assert stranger == {**stranger, "accepted": False, "reason": "not_matched"}
    replay = service.verify(ACCOUNT, wav(sp.simulate_phone_speaker(voice(121, seed=12)) * 0.5))
    assert replay["accepted"] is False and replay["reason"] == "spoof_suspected"
    attempts = service.store.attempts
    assert [a["accepted"] for a in attempts] == [True, False, False]
    assert service.summary(ACCOUNT)["attempts_30d"]["accepted"] == 1


def test_unusable_recordings_are_not_attempts():
    service = make()
    enroll(service)
    assert error(lambda: service.verify(ACCOUNT, wav(ambient()))).code == "VOICE_NO_SPEECH"
    assert service.store.attempts == []
    assert error(lambda: make().verify(ACCOUNT, wav(voice(120)))).code == "VOICE_PROFILE_NOT_FOUND"


def test_confident_matches_refresh_the_gallery_but_never_duplicate():
    service = make()
    enroll(service)
    first = service.verify(ACCOUNT, wav(voice(121, seed=20)))
    assert first["accepted"] and first["gallery_updated"]
    again = service.verify(ACCOUNT, wav(voice(121, seed=21)))
    assert again["accepted"] and not again["gallery_updated"]  # same voice already in the gallery
    assert service.summary(ACCOUNT)["templates"]["auto"] == 1


def test_gallery_keeps_enrollment_templates_when_full():
    service = make()
    enroll(service)
    for i in range(MAX_TEMPLATES + 5):
        service.store.add_template(ACCOUNT, PitchEmbedder.vector_at(110 + i * 0.5), "auto" if i % 2 else "sample")
    templates = service.summary(ACCOUNT)["templates"]
    assert templates["enroll"] + templates["sample"] + templates["auto"] == MAX_TEMPLATES
    assert templates["enroll"] == 3 and templates["auto"] < templates["sample"]


def test_as_norm_is_used_when_a_cohort_is_loaded():
    service = make(with_cohort=True)
    enroll(service)
    result = service.verify(ACCOUNT, wav(voice(121, seed=30)))
    assert result["thresholds"]["mode"] == "as_norm"
    assert result["accepted"] and result["scores"]["normalized"] > 3
    assert service.verify(ACCOUNT, wav(voice(160, seed=31)))["reason"] == "not_matched"


def test_calibration_sets_thresholds_inside_safe_bands():
    service = make(with_cohort=True)
    enroll(service)
    result = service.calibrate(ACCOUNT, [wav(voice(120 + i, seed=40 + i)) for i in range(3)])
    thresholds = result["summary"]["thresholds"]
    assert SPEAKER_BAND[0] <= thresholds["speaker"] <= SPEAKER_BAND[1]
    assert NORM_BAND[0] <= thresholds["norm"] <= NORM_BAND[1]
    assert result["summary"]["calibrated_at"] is not None
    assert len(result["trials"]) == 3 and all(t["accepted"] for t in result["trials"])
    assert [a["kind"] for a in service.store.attempts] == ["calibrate"] * 3
    other = error(lambda: service.calibrate(ACCOUNT, [wav(voice(120, seed=50)), wav(voice(220, seed=51)),
                                                       wav(voice(120, seed=52))]))
    assert other.code == "VOICE_MISMATCH" and other.details["sample"] == 1


def test_samples_extend_gallery_and_retrain_anti_spoof():
    service = make()
    enroll(service)
    summary = service.add_sample(ACCOUNT, wav(voice(126, seed=60)))
    assert summary["templates"]["sample"] == 1
    assert summary["anti_spoof"]["bonafide_clips"] == 4 and summary["anti_spoof"]["version"] == 2
    assert error(lambda: service.add_sample(ACCOUNT, wav(voice(126, seed=61)))).code == "VOICE_DUPLICATE"
    assert error(lambda: service.add_sample(ACCOUNT, wav(voice(250, seed=62)))).code == "VOICE_MISMATCH"


def test_recorded_replays_train_the_anti_spoof_model():
    service = make()
    enroll(service)
    replays = [wav(sp.simulate_replay(voice(120, seed=70 + i)) * 0.8) for i in range(2)]
    summary = service.add_spoof(ACCOUNT, replays)
    assert summary["anti_spoof"]["spoof_clips"] == 2 and summary["anti_spoof"]["version"] == 2
    assert error(lambda: service.add_spoof(ACCOUNT, [])).code == "VOICE_SAMPLE_COUNT"


def test_delete_removes_everything():
    service = make()
    enroll(service)
    service.verify(ACCOUNT, wav(voice(121, seed=80)))
    service.delete(ACCOUNT)
    assert service.store.attempts == [] and not service.store.exists(ACCOUNT)
    assert error(lambda: service.delete(ACCOUNT)).code == "VOICE_PROFILE_NOT_FOUND"


def test_background_queue_runs_one_training_per_profile():
    import threading

    started, release, runs = threading.Event(), threading.Event(), []

    def job(account):
        runs.append(account)
        started.set()
        release.wait(5)

    from app.service import TrainingQueue
    queue = TrainingQueue(job)
    queue.schedule("a")
    assert started.wait(5) and queue.is_training("a")
    queue.schedule("a")
    queue.schedule("a")  # coalesced with the queued run
    release.set()
    queue._executor.shutdown(wait=True)
    assert runs == ["a", "a"] and not queue.is_training("a")
