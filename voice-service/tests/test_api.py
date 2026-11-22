from fastapi.testclient import TestClient

from app import antispoof as sp
from app.main import create_app
from app.service import VoiceService
from tests.fakes import FakeTranscriber, MemoryStore, PitchEmbedder, ambient, voice, wav

TOKEN = "t" * 32
ACCOUNT = "7f0c2a52-0000-4000-8000-000000000002"
H = {"x-voice-token": TOKEN}


def client(max_upload=1_048_576):
    service = VoiceService(MemoryStore(), PitchEmbedder(), sp.FeatureLogisticBackend(), None, background_training=False,
                           transcriber=FakeTranscriber("đóng cửa chính"))
    return TestClient(create_app(service=service, token=TOKEN, max_upload_bytes=max_upload, retention_days=None))


def enroll_files():
    return [("ambient", ("ambient.wav", wav(ambient()), "audio/wav"))] + [
        ("samples", (f"s{i}.wav", wav(voice(120, seed=i)), "audio/wav")) for i in range(3)]


def test_requires_the_gateway_token():
    with client() as c:
        assert c.get("/health").json()["status"] == "ok"
        response = c.get(f"/v1/profiles/{ACCOUNT}")
        assert response.status_code == 401 and response.json()["error"]["code"] == "VOICE_UNAUTHORIZED"
        assert c.get(f"/v1/profiles/{ACCOUNT}", headers={"x-voice-token": "wrong"}).status_code == 401


def test_profile_lifecycle_over_http():
    with client() as c:
        assert c.get(f"/v1/profiles/{ACCOUNT}", headers=H).json()["error"]["code"] == "VOICE_PROFILE_NOT_FOUND"
        enrolled = c.put(f"/v1/profiles/{ACCOUNT}", headers=H, data={"consent": "true"}, files=enroll_files())
        assert enrolled.status_code == 200, enrolled.text
        assert enrolled.json()["templates"]["enroll"] == 3

        result = c.post(f"/v1/profiles/{ACCOUNT}/verify", headers=H,
                        files={"audio": ("a.wav", wav(voice(121, seed=9)), "audio/wav")})
        assert result.status_code == 200 and result.json()["accepted"] is True

        noisy = c.post(f"/v1/profiles/{ACCOUNT}/verify", headers=H,
                       files={"audio": ("a.wav", wav(ambient()), "audio/wav")})
        assert noisy.status_code == 422 and noisy.json()["error"]["code"] == "VOICE_NO_SPEECH"

        sample = c.post(f"/v1/profiles/{ACCOUNT}/samples", headers=H,
                        files={"audio": ("a.wav", wav(voice(127, seed=10)), "audio/wav")})
        assert sample.status_code == 200 and sample.json()["templates"]["sample"] == 1

        spoof = c.post(f"/v1/profiles/{ACCOUNT}/antispoof", headers=H,
                       files=[("samples", ("r.wav", wav(sp.simulate_replay(voice(120, seed=11))), "audio/wav"))])
        assert spoof.status_code == 200 and spoof.json()["anti_spoof"]["spoof_clips"] == 1

        calibrated = c.post(f"/v1/profiles/{ACCOUNT}/calibrate", headers=H, files=[
            ("samples", (f"c{i}.wav", wav(voice(120 + i, seed=20 + i)), "audio/wav")) for i in range(3)])
        assert calibrated.status_code == 200 and calibrated.json()["summary"]["calibrated_at"]

        heard = c.post(f"/v1/listen/{ACCOUNT}", headers=H, files={"audio": ("a.wav", wav(voice(120, seed=30)), "audio/wav")})
        assert heard.status_code == 200 and heard.json()["transcript"] == "đóng cửa chính"
        assert heard.json()["verification"]["accepted"] is True

        assert c.delete(f"/v1/profiles/{ACCOUNT}", headers=H).status_code == 204
        assert c.delete(f"/v1/profiles/{ACCOUNT}", headers=H).status_code == 404


def test_rejects_bad_requests():
    with client(max_upload=70_000) as c:
        missing_consent = c.put(f"/v1/profiles/{ACCOUNT}", headers=H, files=enroll_files())
        assert missing_consent.status_code == 400
        assert missing_consent.json()["error"]["code"] == "VOICE_BAD_REQUEST"
        assert c.get("/v1/profiles/not-a-uuid", headers=H).status_code == 400
        big = c.post(f"/v1/profiles/{ACCOUNT}/verify", headers=H,
                     files={"audio": ("a.wav", wav(voice(120, seconds=4)), "audio/wav")})
        assert big.status_code == 413 and big.json()["error"]["code"] == "VOICE_FILE_TOO_LARGE"
    with client() as c:
        declined = c.put(f"/v1/profiles/{ACCOUNT}", headers=H, data={"consent": "false"}, files=enroll_files())
        assert declined.json()["error"]["code"] == "VOICE_CONSENT_REQUIRED"
