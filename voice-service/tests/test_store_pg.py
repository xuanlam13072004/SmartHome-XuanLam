"""PostgresStore against a real database with migration 208 applied.
Runs only when VOICE_TEST_DATABASE_URL is set (it creates its own account)."""
import os
import uuid
from datetime import datetime, timezone

import numpy as np
import pytest

from app import antispoof as sp
from app.scoring import MAX_TEMPLATES, Scores, Thresholds
from app.store import PostgresStore, Profile
from app.errors import VoiceError
from tests.fakes import PitchEmbedder

URL = os.environ.get("VOICE_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="VOICE_TEST_DATABASE_URL not set")


@pytest.fixture()
def store():
    s = PostgresStore(URL, max_size=2)
    s.open()
    yield s
    s.close()


@pytest.fixture()
def account(store):
    email = f"voice-{uuid.uuid4().hex[:8]}@test.vn"
    with store.pool.connection() as conn:
        row = conn.execute("INSERT INTO accounts (email, password_hash, full_name) VALUES (%s, 'h', 'V') RETURNING id",
                           (email,)).fetchone()
    yield str(row[0])
    with store.pool.connection() as conn:
        conn.execute("DELETE FROM accounts WHERE id = %s", (row[0],))


def model(tag="a"):
    return sp.TrainedModel(weights=b"w" * 1000, stats={"floor": 0.5, "tag": tag})


def test_profile_round_trip_and_limits(store, account):
    now = datetime.now(timezone.utc)
    profile = Profile(account, now, 0.001, Thresholds(), None, now)
    vectors = [PitchEmbedder.vector_at(f) for f in (120, 121, 122)]
    store.create(profile, vectors, [b"\x00\x01" * 100] * 3, model())
    with pytest.raises(VoiceError) as info:
        store.create(profile, vectors, [], model())
    assert info.value.code == "VOICE_PROFILE_EXISTS"

    bundle = store.load(account)
    assert len(bundle.templates) == 3 and bundle.model_version == 1 and bundle.model.stats["tag"] == "a"
    assert np.allclose(bundle.templates[0].vector, vectors[0], atol=1e-6)

    for i in range(MAX_TEMPLATES + 4):
        assert store.add_template(account, PitchEmbedder.vector_at(100 + i), "auto" if i % 3 else "sample")
    counts = store.counts(account)["templates"]
    assert sum(counts.values()) == MAX_TEMPLATES and counts["enroll"] == 3

    store.add_clips(account, "spoof", [b"\x00\x02" * 10] * (sp.MAX_SPOOF_CLIPS + 3))
    bona, spoofs = store.clips(account)
    assert len(bona) == 3 and len(spoofs) == sp.MAX_SPOOF_CLIPS

    assert store.save_model(account, model("b")) == 2
    store.set_thresholds(account, Thresholds(speaker=0.7, norm=3.5, fusion=0.66))
    bundle = store.load(account)
    assert bundle.model_version == 2 and bundle.profile.thresholds.norm == pytest.approx(3.5)
    assert bundle.profile.calibrated_at is not None

    store.record_attempt(account, "verify", True, None, Scores(0.9, 4.2, 0.8, 0.86, 30.0), 2100)
    store.record_attempt(account, "verify", False, "not_matched", Scores(0.3, None, 0.8, 0.5, 30.0), 1800)
    store.record_attempt(account, "verify", False, "not_matched", Scores(0.3, None, 0.8, 0.5, 30.0), 1800,
                         for_command=True)
    accepted, rejected, last = store.counts(account)["attempts"]
    assert (accepted, rejected) == (1, 1) and last is not None  # spoken commands are counted apart
    assert store.purge_attempts(30) == 0

    assert store.delete(account) is True
    assert store.load(account) is None and store.save_model(account, model()) is None
    assert store.counts(account)["attempts"][:2] == (0, 0)
    assert not store.add_template(account, vectors[0], "auto")
