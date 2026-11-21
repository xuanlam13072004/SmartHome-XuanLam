import numpy as np

from app import antispoof as sp
from app.audio import PROFILE_RULE, VERIFY_RULE, analyze
from tests.fakes import voice


def spans(f0=120, seeds=(1, 2, 3)):
    return [analyze(voice(f0, seed=s), PROFILE_RULE).span for s in seeds]


def test_clips_round_trip_as_float16():
    clip = sp.best_clip(spans()[0])
    data = sp.clip_to_bytes(clip)
    assert len(data) <= 64000
    assert np.max(np.abs(sp.clip_from_bytes(data) - clip)) < 1e-3


def test_best_clip_and_crops():
    x = np.concatenate([np.zeros(16000), voice(120, seconds=2.0, silence=0), np.zeros(32000)]).astype(np.float32)
    clip = sp.best_clip(x)
    assert len(clip) == sp.CLIP_LEN and np.sum(clip ** 2) > 0.9 * np.sum(x ** 2)
    assert len(sp.crops(x)) == 3
    assert len(sp.crops(x[:20000])) == 1
    assert sp.prepare(x[:100]).shape == (sp.CLIP_LEN,)


def test_training_keeps_recorded_replays_balanced():
    rng = np.random.default_rng(0)
    bona = [sp.best_clip(s) for s in spans()]
    spoof = [sp.simulate_phone_speaker(b) for b in bona] * 10
    takes, attacks = sp._datasets(bona, spoof, rng, train=True)
    assert len(takes) == 6
    assert len(attacks) == 9 + 2 * 8  # simulated + newest real (x2 with a second take)


def test_profile_model_rejects_replays_of_a_new_sentence():
    backend = sp.FeatureLogisticBackend()
    model = sp.train_profile(backend, [sp.best_clip(s) for s in spans()], [])
    stats = model.stats
    assert sp.FLOOR_BAND[0] <= stats["floor"] <= sp.FLOOR_BAND[1]
    assert not stats["weak"] and stats["separation"] > 0.3
    live = analyze(voice(121, seed=7), VERIFY_RULE).span
    live_score = sp.score_span(backend, model, live)
    assert live_score >= stats["floor"]
    for simulate in (sp.simulate_replay, sp.simulate_phone_speaker):
        assert sp.score_span(backend, model, simulate(live)) < stats["floor"]


def test_training_needs_two_bonafide_clips():
    import pytest
    with pytest.raises(ValueError):
        sp.train_profile(sp.FeatureLogisticBackend(), [sp.best_clip(spans()[0])], [])
