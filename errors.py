"""Error type shared by every layer.

``code`` is stable and documented (see README); the model and the safety hook
act on it. ``hint`` tells the model what to do next.
"""

from __future__ import annotations

from typing import Optional


class SapError(Exception):
    def __init__(self, code: str, message: str, hint: Optional[str] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint

    def to_text(self) -> str:
        text = f"[{self.code}] {self.message}"
        if self.hint:
            text += f"\nHint: {self.hint}"
        return text


class ToolInputError(SapError):
    def __init__(self, message: str):
        super().__init__("BAD_REQUEST", message)
