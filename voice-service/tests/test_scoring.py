import numpy as np

from app.scoring import (
    FUSION_BAND, NORM_BAND, SPEAKER_BAND, Scores, Thresholds, as_norm, calibrate, decide, fuse,
)
from tests.fakes import PitchEmbedder, cohort


def scores(similarity=0.8, normalized=None, anti=0.9, fusion=0.8, snr=20.0):
    return Scores(similarity, normalized, anti, fusion, snr)


def test_decide_checks_spoof_then_speaker_then_fusion():
    t = Thresholds()
    assert decide(scores(), t, 0.5) == (True, None)
    assert decide(scores(similarity=0.3, anti=0.2), t, 0.5) == (False, "spoof_suspected")
    assert decide(scores(similarity=0.6), t, 0.5) == (False, "not_matched")
    assert decide(scores(fusion=0.6), t, 0.5) == (False, "low_confidence")


def test_decide_uses_as_norm_when_present():
    t = Thresholds()
    assert decide(scores(similarity=0.6, normalized=5.0), t, 0.5)[0]  # below raw threshold, but stands out
    assert decide(scores(similarity=0.9, normalized=1.0), t, 0.5) == (False, "not_matched")
    assert decide(scores(similarity=0.4, normalized=9.0), t, 0.5) == (False, "not_matched")  # cosine floor


def test_as_norm_separates_owner_from_strangers():
    group = cohort()
    owner = PitchEmbedder.vector_at(120)
    same, other = PitchEmbedder.vector_at(122), PitchEmbedder.vector_at(240)
    assert as_norm(0.9, owner, same, None) is None
    assert as_norm(0.9, owner, same, group[:10]) is None
    target = as_norm(float(owner @ same), owner, same, group)
    impostor = as_norm(float(owner @ other), owner, other, group)
    assert target > 3.0 > impostor


def test_fusion_trusts_the_voice_more_in_clean_audio():
    assert fuse(1.0, 0.0, 20.0) == 0.65
    assert fuse(1.0, 0.0, 10.0) == 0.55


def test_calibration_stays_inside_safe_bands():
    loose = [scores(similarity=s, normalized=n, fusion=f) for s, n, f in [(0.5, 1.0, 0.5), (0.9, 9.0, 0.9), (0.7, 4, 0.7)]]
    t = calibrate(loose, Thresholds())
    assert SPEAKER_BAND[0] <= t.speaker <= SPEAKER_BAND[1]
    assert NORM_BAND[0] <= t.norm <= NORM_BAND[1]
    assert FUSION_BAND[0] <= t.fusion <= FUSION_BAND[1]
    tight = [scores(similarity=0.83 + d, fusion=0.84 + d) for d in (0.0, 0.01, 0.02)]
    t = calibrate(tight, Thresholds(norm=3.3))
    assert np.isclose(t.speaker, 0.80) and t.norm == 3.3  # no AS-norm scores: kept
    assert 0.8 < t.fusion <= 0.85
