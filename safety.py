"""Safety levels, enforced through Hermes' ``pre_tool_call`` hook.

``plugins.entries.sapgui.settings.safety_level`` (or the Desktop settings form):

* ``open``        -- everything runs directly.
* ``confirm``     -- (default) anything that saves, posts, releases or deletes, raw OK-codes,
                     closing sessions and sap_script go through Hermes' approval gate.
* ``confirm-all`` -- every call that is not a pure read goes through the approval gate.
* ``readonly``    -- saving actions and sap_script are blocked; reading, navigating and
                     filling selection screens still work.

A system profile can set its own ``safety`` (e.g. ``readonly`` for production); the stricter
of the global and the system level applies, matched by the SID of the session the call acts on.

What a call would do is decided by the bridge op ``guard``, which inspects the
live screen (button texts and icons, popup texts, toolbar entries) without
changing anything. If it cannot decide, the call is treated as a save.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Optional

from . import config as cfg
from .errors import SapError
from .tools import GATED_TOOLS, SPEC_BY_NAME, coerce_args

ORDER = {"open": 0, "confirm": 1, "confirm-all": 2, "readonly": 3}


def stricter(a: str, b: str) -> str:
    a = cfg.normalize_level(a)
    b = cfg.normalize_level(b) if b else a
    return a if ORDER[a] >= ORDER[b] else b


def decide(level: str, category: str) -> str:
    """'allow', 'approve' or 'block' for a call of this category at this level."""
    if category == "read" or level == "open":
        return "allow"
    if level == "readonly":
        return "block" if category == "commit" else "allow"
    if level == "confirm-all":
        return "approve"
    return "approve" if category == "commit" else "allow"  # confirm


def classify(manager, tool_name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    if tool_name == "sap_login":
        try:
            profile = cfg.get_system(str(args.get("system") or ""))
            sid, level = profile.sid, profile.safety
        except SapError:
            sid, level = "", ""
        return {"category": "navigate", "reason": "logs on", "description": f"Log on to {args.get('system')}",
                "system": {"sid": sid}, "profileLevel": level}
    try:
        return manager.guard(tool_name, args)
    except SapError as exc:
        return {"category": "commit", "reason": f"could not inspect the screen ({exc.code})",
                "description": f"{tool_name} (screen not readable: {exc.message})", "system": None}


def effective_level(global_level: str, verdict: Dict[str, Any]) -> str:
    level = cfg.normalize_level(global_level)
    profile_level = verdict.get("profileLevel")
    system = verdict.get("system") or {}
    if not profile_level and system.get("sid"):
        try:
            profile = cfg.system_for_sid(system.get("sid", ""), system.get("client", ""))
        except SapError:
            profile = None
        profile_level = profile.safety if profile else ""
    return stricter(level, profile_level) if profile_level else level


def make_pre_tool_call_hook(manager, get_level: Callable[[], Any]) -> Callable[..., Optional[dict]]:
    def pre_tool_call(tool_name: str = "", args: Optional[dict] = None, **_kwargs: Any) -> Optional[dict]:
        if tool_name not in GATED_TOOLS:
            return None
        args = args if isinstance(args, dict) else {}
        try:  # classify what the handler will actually run (e.g. fields sent as a JSON string)
            args = coerce_args(SPEC_BY_NAME[tool_name], args)
        except Exception:
            pass  # the handler reports bad arguments itself
        level = cfg.normalize_level(get_level())
        try:
            any_system_level = any(p.safety for p in cfg.systems().values())
        except SapError:
            any_system_level = False
        if level == "open" and not any_system_level:
            return None
        verdict = classify(manager, tool_name, args)
        level = effective_level(level, verdict)
        decision = decide(level, str(verdict.get("category") or "commit"))
        if decision == "allow":
            return None
        sid = (verdict.get("system") or {}).get("sid") or "SAP"
        if decision == "block":
            return {
                "action": "block",
                "message": f"Blocked ({level} for {sid}): {verdict.get('description') or tool_name}. "
                           "The SAP plugin does not allow saving actions here (plugins.entries.sapgui.settings.safety_level "
                           "or the system profile's safety).",
            }
        return {
            "action": "approve",
            "message": f"SAP {sid}: {verdict.get('description') or tool_name}",
            "rule_key": f"sapgui:{tool_name}:{sid}",
        }

    return pre_tool_call
