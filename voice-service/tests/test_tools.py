import numpy as np

from app import antispoof as sp
from tests.fakes import PitchEmbedder, cohort, voice, wav
from tools.build_cohort import build
from tools.evaluate import as_markdown, eer, evaluate


def test_eer():
    assert eer([0.9, 0.8, 0.7], [0.1, 0.2, 0.3])[0] == 0.0
    assert eer([0.9, 0.2], [0.8, 0.1])[0] == 0.5
    assert eer([], [0.1]) is None


def write(path, x):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(wav(x))


def test_evaluate_on_synthetic_people(tmp_path):
    pitches = {"an": 110, "binh": 150, "chi": 210}
    for name, f0 in pitches.items():
        for i in range(5):
            write(tmp_path / "speakers" / name / f"{i}.wav", voice(f0 * (1 + 0.005 * i), seed=i + int(f0)))
        write(tmp_path / "spoof" / name / "r.wav", sp.simulate_phone_speaker(voice(f0, seed=99)))
    report = evaluate(PitchEmbedder(), sp.FeatureLogisticBackend(), tmp_path, enroll=3, cohort=cohort())
    assert report["people"] == 3
    assert report["trials"] == {"genuine": 6, "impostor": 12, "spoof": 3, "skipped_files": 0}
    assert report["speaker"]["cosine_eer"][0] == 0.0 and report["speaker"]["as_norm_eer"][0] == 0.0
    assert report["system"]["false_accept_rate"] == 0.0
    assert report["system"]["spoof_accept_rate"] is not None and report["anti_spoof"]["eer"] is not None
    assert "EER AS-norm" in as_markdown(report)


def test_build_cohort(tmp_path):
    for s in range(4):
        for i in range(3):
            write(tmp_path / f"spk{s}" / f"{i}.wav", voice(100 + 30 * s, seed=i))
    write(tmp_path / "spk0" / "silent.wav", np.zeros(16000, dtype=np.float32))
    vectors, info = build(PitchEmbedder(), tmp_path, per_speaker=2, limit=100)
    assert vectors.shape == (8, 192) and info == {"speakers": 4, "embeddings": 8, "skipped": 0}
