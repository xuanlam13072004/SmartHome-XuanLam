from __future__ import annotations

from typing import Any


class VoiceError(Exception):
    """An error the Gateway passes on to the app: HTTP status, stable code, Vietnamese message."""

    def __init__(self, status: int, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}

    def with_details(self, **details: Any) -> "VoiceError":
        self.details.update(details)
        return self


def invalid_audio(message: str = "Không đọc được file ghi âm (cần WAV).") -> VoiceError:
    return VoiceError(400, "VOICE_INVALID_AUDIO", message)


def quality(code: str, message: str) -> VoiceError:
    """A recording that cannot be judged (too short, noisy...). Never counts as a failed attempt."""
    return VoiceError(422, code, message)


def not_found() -> VoiceError:
    return VoiceError(404, "VOICE_PROFILE_NOT_FOUND", "Bạn chưa đăng ký giọng nói.")
