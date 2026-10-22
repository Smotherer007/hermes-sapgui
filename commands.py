"""Slash commands.

* ``/sap <task>``   -- hands the task to the agent with the SAP working rules.
* ``/sap-doctor``   -- runs the diagnosis right away, without the model.
* ``/sap-start``    -- starts SAP GUI (SAP Logon on Windows, SAP GUI for Java elsewhere).

``ctx.inject_message`` always works in the CLI; in the gateway Hermes only
allows it when ``plugins.entries.sapgui.allow_gateway_injection: true``.
Without that, /sap answers with the prompt so the user can send it.
"""

from __future__ import annotations

import os
from typing import Any, Callable

from .errors import SapError


def task_prompt(task: str) -> str:
    return " ".join([
        f"In SAP: {task}",
        "Load the skill sapgui:sapgui first if you have not yet.",
        "Start with sap_status; if no session is open, log on with sap_login (or ask me to log on) and bind the session.",
        "Read the screen with sap_screen before every action and use the ids it shows.",
        "Check the status bar and popups after each step.",
        "Do not save, post or delete anything unless the task clearly asks for it.",
        "When you are done, tell me what you did and what SAP reported.",
    ])


def _session_key() -> str:
    # Without a key the live gateway picks the chat this command came from.
    return os.environ.get("HERMES_SESSION_KEY", "")


def make_sap_command(ctx: Any) -> Callable[[str], str]:
    def sap(raw_args: str = "") -> str:
        task = (raw_args or "").strip()
        if not task:
            return "Usage: /sap <what to do in SAP>, e.g. /sap show the stock of material 4711 in plant 1000"
        prompt = task_prompt(task)
        try:
            key = _session_key() or None
            if ctx.inject_message(prompt, session_key=key):
                return f"Working on it in SAP: {task}"
        except Exception:
            pass
        return ("I could not start this automatically here (the gateway needs "
                "plugins.entries.sapgui.allow_gateway_injection: true). Send this as a message instead:\n\n" + prompt)

    return sap


def make_doctor_command(manager) -> Callable[[str], str]:
    def doctor(_raw: str = "") -> str:
        try:
            return manager.doctor()
        except SapError as exc:
            return exc.to_text()

    return doctor


def make_start_command(manager) -> Callable[[str], str]:
    def start(raw: str = "") -> str:
        backend = (raw or "").strip().lower() or None
        try:
            return manager.start(backend if backend in ("windows", "java") else None)
        except SapError as exc:
            return exc.to_text()

    return start
