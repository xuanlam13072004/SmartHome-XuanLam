"""The real network; skipped where PyTorch is not installed (runs in the image)."""
import numpy as np
import pytest

torch = pytest.importorskip("torch")

from app import antispoof as sp  # noqa: E402
from app.audio import PROFILE_RULE, analyze  # noqa: E402
from app.rawnet import RawNetBackend  # noqa: E402
from tests.fakes import voice  # noqa: E402


def test_trains_stores_half_precision_and_predicts():
    backend = RawNetBackend(epochs=3)
    clips = [sp.best_clip(analyze(voice(120, seed=s), PROFILE_RULE).span) for s in (1, 2, 3)]
    model = sp.train_profile(backend, clips, [])
    assert len(model.weights) < 1_000_000  # float16
    assert model.stats["backend"] == "rawnet2"
    x = np.stack([sp.prepare(c) for c in clips])
    first = backend.predict(model.weights, x, cache_key=("a", 1))
    assert first.shape == (3,) and np.all((first >= 0) & (first <= 1))
    assert np.allclose(first, backend.predict(model.weights, x, cache_key=("a", 1)))
