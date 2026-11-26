# voice-service: CPU only. PyTorch comes from its CPU wheel index; the
# ECAPA-TDNN (speaker) and PhoWhisper-small (speech to text, ~1 GB) models are
# downloaded once at build time, so the running service needs no internet.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models/hf

WORKDIR /app

RUN pip install torch==2.2.0 torchaudio==2.2.0 --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt requirements-dev.txt ./
RUN pip install -r requirements.txt -r requirements-dev.txt

RUN python -c "from speechbrain.inference.speaker import EncoderClassifier; \
EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb', savedir='/models/ecapa')"
RUN python -c "from transformers import pipeline; pipeline('automatic-speech-recognition', model='vinai/PhoWhisper-small')"

COPY app ./app
COPY tools ./tools
COPY tests ./tests

# Fail the build now, not at the first request, if a model cannot load offline.
RUN HF_HUB_OFFLINE=1 python -c "import numpy as np; from app.embedding import EcapaEmbedder; \
from app.asr import PhoWhisperTranscriber; noise = np.random.default_rng(0).normal(0, 0.05, 32000).astype('float32'); \
v = EcapaEmbedder('/models/ecapa').embed_batch([noise]); assert v.shape == (1, 192), v.shape; \
assert isinstance(PhoWhisperTranscriber('vinai/PhoWhisper-small').transcribe(noise), str)"

# Debian already has a system group named "voice" (audio modems), so the
# service runs as its own "voicesvc" (uid/gid 10001, same as before).
RUN groupadd --system --gid 10001 voicesvc \
    && useradd --system --uid 10001 --gid voicesvc voicesvc \
    && mkdir -p /data && chown -R voicesvc:voicesvc /data /models
USER voicesvc

ENV HF_HUB_OFFLINE=1 \
    VOICE_MODEL_DIR=/models/ecapa \
    VOICE_COHORT_PATH=/data/cohort.npy

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"
CMD ["uvicorn", "app.main:production_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
