# voice-service: CPU only. PyTorch comes from its CPU wheel index and the
# ECAPA-TDNN model is downloaded once at build time, so the running service
# needs no internet access.
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

COPY app ./app
COPY tools ./tools
COPY tests ./tests

# Fail the build now, not at the first request, if the model cannot load offline.
RUN HF_HUB_OFFLINE=1 python -c "import numpy as np; from app.embedding import EcapaEmbedder; \
v = EcapaEmbedder('/models/ecapa').embed_batch([np.random.default_rng(0).normal(0, 0.05, 32000).astype('float32')]); \
assert v.shape == (1, 192), v.shape"

RUN useradd --system --uid 10001 voice && mkdir -p /data && chown -R voice /data /models
USER voice

ENV HF_HUB_OFFLINE=1 \
    VOICE_MODEL_DIR=/models/ecapa \
    VOICE_COHORT_PATH=/data/cohort.npy

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"
CMD ["uvicorn", "app.main:production_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
