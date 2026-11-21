import numpy as np
import pytest

from app.audio import PROFILE_RULE, SPOOF_RULE, VERIFY_RULE, analyze, decode, noise_floor
from app.errors import VoiceError
from tests.fakes import ambient, voice, wav


def code(fn):
    with pytest.raises(VoiceError) as info:
        fn()
    return info.value.code


def test_decode_resamples_stereo_to_16k_mono():
    x = voice(150, seconds=1.0)
    stereo = np.stack([x, x], axis=1)
    import io
    import soundfile as sf
    from scipy.signal import resample_poly
    buffer = io.BytesIO()
    sf.write(buffer, resample_poly(stereo, 441, 160, axis=0), 44100, format="WAV", subtype="PCM_16")
    out = decode(buffer.getvalue())
    assert abs(len(out) - len(x)) < 50
    assert out.dtype == np.float32


def test_decode_rejects_garbage_and_long_recordings():
    assert code(lambda: decode(b"not a wav")) == "VOICE_INVALID_AUDIO"
    assert code(lambda: decode(wav(np.zeros(16000 * 16, dtype=np.float32)))) == "VOICE_TOO_LONG"


def test_analyze_finds_the_speech():
    speech = analyze(voice(120, seconds=2.0, silence=0.5), PROFILE_RULE)
    assert 1800 <= speech.speech_ms <= 2200
    assert speech.snr_db > 25
    assert len(speech.span) < 2.6 * 16000  # most of the silence is cut
    rms = float(np.sqrt(np.mean(np.square(speech.voiced))))
    assert abs(rms - 0.05) < 0.01  # loudness-normalized for the embedder


def test_analyze_rejects_unusable_recordings():
    assert code(lambda: analyze(ambient(), VERIFY_RULE)) == "VOICE_NO_SPEECH"
    assert code(lambda: analyze(voice(120, seconds=0.5), VERIFY_RULE)) == "VOICE_TOO_SHORT"
    assert code(lambda: analyze(voice(120, noise=0.02), PROFILE_RULE)) == "VOICE_TOO_NOISY"
    assert code(lambda: analyze(np.clip(voice(120) * 20, -1, 1), PROFILE_RULE)) == "VOICE_CLIPPED"
    assert code(lambda: analyze(voice(120, level=0.01, noise=0.0001), VERIFY_RULE)) == "VOICE_TOO_QUIET"


def test_rules_differ_by_purpose():
    noisy = voice(120, noise=0.02)
    assert code(lambda: analyze(noisy, PROFILE_RULE)) == "VOICE_TOO_NOISY"
    analyze(noisy, VERIFY_RULE)
    analyze(noisy, SPOOF_RULE)  # replays may be noisier


def test_noise_floor_from_silence():
    assert abs(noise_floor(ambient(noise=0.002)) - 0.002) < 0.0005
    assert code(lambda: noise_floor(voice(120, seconds=1.5))) == "VOICE_AMBIENT_NOISY"
    assert code(lambda: noise_floor(ambient(seconds=0.5))) == "VOICE_AMBIENT_TOO_SHORT"
