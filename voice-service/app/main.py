"""HTTP API for the Gateway only (docker network, shared token). The app
never calls voice-service directly: the Gateway authenticates the user,
rate-limits, locks out after repeated failures and forwards the audio."""
from __future__ import annotations

import asyncio
import contextlib
import hmac
import logging
import uuid
from functools import partial
from typing import Callable

import anyio
from fastapi import Depends, FastAPI, File, Form, Header, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

from .errors import VoiceError
from .service import VoiceService

log = logging.getLogger("voice.api")


def build_service(settings) -> tuple[VoiceService, Callable[[], None]]:
    """The production wiring: PostgreSQL, ECAPA-TDNN, RawNet2 and the cohort file."""
    import torch

    from .asr import PhoWhisperTranscriber
    from .cohort import load_cohort
    from .embedding import EcapaEmbedder
    from .rawnet import RawNetBackend
    from .store import PostgresStore

    if settings.torch_threads:
        torch.set_num_threads(settings.torch_threads)
    store = PostgresStore(settings.database_url, max_size=settings.max_concurrency + 2)
    store.open()
    service = VoiceService(store, EcapaEmbedder(settings.model_dir), RawNetBackend(), load_cohort(settings.cohort_path),
                           transcriber=PhoWhisperTranscriber(settings.asr_model))
    return service, store.close


def create_app(settings=None, service: VoiceService | None = None, token: str | None = None,
               max_concurrency: int = 2, max_upload_bytes: int = 1_048_576,
               retention_days: int | None = 30) -> FastAPI:
    state: dict = {"service": service}
    if settings is not None:
        token, max_concurrency = settings.token, settings.max_concurrency
        max_upload_bytes, retention_days = settings.max_upload_bytes, settings.attempt_retention_days
    if not token:
        raise RuntimeError("A token is required")
    limiter = asyncio.Semaphore(max_concurrency)

    async def purge_loop() -> None:
        while True:
            try:
                removed = await anyio.to_thread.run_sync(state["service"].store.purge_attempts, retention_days)
                if removed:
                    log.info("Purged %d old voice attempts", removed)
            except Exception:  # noqa: BLE001
                log.exception("Purging voice attempts failed")
            await asyncio.sleep(3600)

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI):
        close = None
        if state["service"] is None:
            state["service"], close = await anyio.to_thread.run_sync(build_service, settings)
        task = asyncio.create_task(purge_loop()) if retention_days else None
        yield
        if task:
            task.cancel()
        if state["service"].queue:
            state["service"].queue.shutdown()
        if close:
            close()

    app = FastAPI(title="voice-service", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(VoiceError)
    async def voice_error(_: Request, error: VoiceError):
        return JSONResponse(status_code=error.status,
                            content={"error": {"code": error.code, "message": error.message, "details": error.details}})

    @app.exception_handler(RequestValidationError)
    async def bad_request(_: Request, error: RequestValidationError):
        return JSONResponse(status_code=400, content={"error": {
            "code": "VOICE_BAD_REQUEST", "message": "Yêu cầu không hợp lệ.", "details": {}}})

    async def authorized(x_voice_token: str = Header(default="")) -> None:
        if not hmac.compare_digest(x_voice_token.encode(), token.encode()):
            raise VoiceError(401, "VOICE_UNAUTHORIZED", "Unauthorized")

    async def run(method: str, *args):
        async with limiter:
            return await anyio.to_thread.run_sync(partial(getattr(state["service"], method), *args))

    async def read(upload: UploadFile) -> bytes:
        data = await upload.read(max_upload_bytes + 1)
        if len(data) > max_upload_bytes:
            raise VoiceError(413, "VOICE_FILE_TOO_LARGE", "File ghi âm quá lớn.")
        return data

    guarded = [Depends(authorized)]

    @app.get("/health")
    async def health():
        service = state["service"]
        return {"status": "ok", "cohort": 0 if service is None or service.cohort is None else len(service.cohort)}

    @app.get("/v1/profiles/{account_id}", dependencies=guarded)
    async def get_profile(account_id: uuid.UUID):
        return await run("summary", str(account_id))

    @app.put("/v1/profiles/{account_id}", dependencies=guarded)
    async def enroll(account_id: uuid.UUID, consent: bool = Form(...), ambient: UploadFile = File(...),
                     samples: list[UploadFile] = File(...)):
        return await run("enroll", str(account_id), await read(ambient), [await read(s) for s in samples], consent)

    @app.delete("/v1/profiles/{account_id}", dependencies=guarded, status_code=204)
    async def delete(account_id: uuid.UUID):
        await run("delete", str(account_id))
        return Response(status_code=204)

    @app.post("/v1/profiles/{account_id}/verify", dependencies=guarded)
    async def verify(account_id: uuid.UUID, audio: UploadFile = File(...)):
        return await run("verify", str(account_id), await read(audio))

    # A spoken command for the assistant: text + verification (when the account has a profile).
    @app.post("/v1/listen/{account_id}", dependencies=guarded)
    async def listen(account_id: uuid.UUID, audio: UploadFile = File(...)):
        return await run("listen", str(account_id), await read(audio))

    @app.post("/v1/profiles/{account_id}/calibrate", dependencies=guarded)
    async def calibrate(account_id: uuid.UUID, samples: list[UploadFile] = File(...)):
        return await run("calibrate", str(account_id), [await read(s) for s in samples])

    @app.post("/v1/profiles/{account_id}/samples", dependencies=guarded)
    async def add_sample(account_id: uuid.UUID, audio: UploadFile = File(...)):
        return await run("add_sample", str(account_id), await read(audio))

    @app.post("/v1/profiles/{account_id}/antispoof", dependencies=guarded)
    async def add_spoof(account_id: uuid.UUID, samples: list[UploadFile] = File(...)):
        return await run("add_spoof", str(account_id), [await read(s) for s in samples])

    return app


def production_app() -> FastAPI:
    from .config import load_settings

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    return create_app(settings=load_settings())
