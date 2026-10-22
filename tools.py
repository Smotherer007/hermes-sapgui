"""Tool registry built from core/tools.json (shared with pi-sapgui).

Hermes hands a handler the raw arguments the model produced and expects a
JSON string back -- also on failure; a handler must never raise. Models send
numbers as strings and lists as JSON strings now and then, so arguments are
coerced against the schema before they reach the bridge.
"""

from __future__ import annotations

import base64
import functools
import json
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import config as cfg
from . import credentials
from .bridge import CORE_DIR
from .errors import SapError, ToolInputError
from .manager import Manager

TOOLSET = "sapgui"
MAX_TEXT = 40_000
MAX_IMAGE_BYTES = 4 * 1024 * 1024


def load_spec() -> Dict[str, Any]:
    return json.loads((CORE_DIR / "tools.json").read_text(encoding="utf-8"))


SPEC = load_spec()
TOOL_SPECS: List[Dict[str, Any]] = SPEC["tools"]
TOOL_NAMES = tuple(t["name"] for t in TOOL_SPECS)
SPEC_BY_NAME = {t["name"]: t for t in TOOL_SPECS}
#: Tools that can change something in SAP. The safety hook classifies these.
GATED_TOOLS = frozenset(t["name"] for t in TOOL_SPECS if not t.get("readOnly") and not t.get("adapter"))


def _resolve_refs(node: Any) -> Any:
    if isinstance(node, dict):
        if "$ref" in node:
            return dict(SPEC["common"][node["$ref"]])
        return {k: _resolve_refs(v) for k, v in node.items()}
    if isinstance(node, list):
        return [_resolve_refs(v) for v in node]
    return node


def hermes_schema(spec: Dict[str, Any]) -> Dict[str, Any]:
    props = _resolve_refs(spec.get("parameters") or {})
    return {
        "name": spec["name"],
        "description": spec["description"],
        "parameters": {"type": "object", "properties": props, "required": list(spec.get("required") or [])},
    }


# --- argument coercion ------------------------------------------------------


def _coerce(value: Any, schema: Dict[str, Any], key: str) -> Any:
    kind = schema.get("type")
    if value is None:
        return None
    if kind == "number":
        if isinstance(value, bool):
            raise ToolInputError(f"{key} must be a number.")
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise ToolInputError(f"{key} must be a number.") from None
        return int(number) if number == int(number) else number
    if kind == "boolean":
        if isinstance(value, bool):
            return value
        text = str(value).strip().lower()
        if text in ("true", "yes", "1", "on", "x"):
            return True
        if text in ("false", "no", "0", "off", ""):
            return False
        raise ToolInputError(f"{key} must be true or false.")
    if kind == "string":
        if isinstance(value, (dict, list)):
            raise ToolInputError(f"{key} must be a string.")
        if isinstance(value, bool):
            return "true" if value else "false"
        return str(value)
    if kind == "array":
        if isinstance(value, str):
            text = value.strip()
            if text.startswith("["):
                try:
                    value = json.loads(text)
                except ValueError:
                    raise ToolInputError(f"{key} must be a JSON array.") from None
            elif schema.get("items", {}).get("type") == "object":
                raise ToolInputError(f"{key} must be an array of objects.")
            else:
                return value  # "Edit > Select All", "MATNR,MAKTX": the bridge splits these
        if not isinstance(value, list):
            raise ToolInputError(f"{key} must be an array.")
        items = schema.get("items") or {}
        return [_coerce(v, items, f"{key}[{i}]") for i, v in enumerate(value)]
    if kind == "object":
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                raise ToolInputError(f"{key} must be an object.") from None
        if not isinstance(value, dict):
            raise ToolInputError(f"{key} must be an object.")
        props = schema.get("properties") or {}
        out = {}
        for k, v in value.items():
            out[k] = _coerce(v, props[k], f"{key}.{k}") if k in props else v
        for req in schema.get("required") or []:
            if req not in out:
                raise ToolInputError(f"{key}.{req} is required.")
        return out
    return value


def coerce_args(spec: Dict[str, Any], args: Optional[dict]) -> Dict[str, Any]:
    args = args if isinstance(args, dict) else {}
    props = _resolve_refs(spec.get("parameters") or {})
    out: Dict[str, Any] = {}
    for key, value in args.items():
        if key not in props or value is None or value == "":
            continue
        if "enum" in props[key] and str(value) not in props[key]["enum"]:
            # accept case differences (doubleclick vs doubleClick)
            match = [e for e in props[key]["enum"] if e.lower() == str(value).lower()]
            if not match:
                raise ToolInputError(f"{key} must be one of: {', '.join(props[key]['enum'])}.")
            value = match[0]
        out[key] = _coerce(value, props[key], key)
    for req in spec.get("required") or []:
        if req not in out:
            raise ToolInputError(f"{req} is required.")
    return out


# --- results ------------------------------------------------------------------


def _clip(text: str) -> str:
    if len(text) <= MAX_TEXT:
        return text
    return text[:MAX_TEXT] + f"\n... (truncated {len(text) - MAX_TEXT} characters; narrow down with filter, maxRows or columns)"


def ok(text: str, **meta: Any) -> str:
    return json.dumps({"result": _clip(text), **{k: v for k, v in meta.items() if v is not None}}, ensure_ascii=False, default=str)


def err(exc: Exception) -> str:
    if isinstance(exc, SapError):
        body: Dict[str, Any] = {"error": exc.message, "code": exc.code}
        if exc.hint:
            body["hint"] = exc.hint
        return json.dumps(body, ensure_ascii=False)
    return json.dumps({"error": str(exc) or type(exc).__name__, "code": "INTERNAL"}, ensure_ascii=False)


def _safe(fn: Callable[[dict], Any]) -> Callable[..., Any]:
    @functools.wraps(fn)
    def wrapper(args: Optional[dict] = None, **_kwargs: Any) -> Any:
        try:
            return fn(args if isinstance(args, dict) else {})
        except Exception as exc:  # the contract: never raise into the agent loop
            return err(exc)

    return wrapper


_META_KEYS = ("nextStartRow", "dataEndsAt", "session", "stoppedAt")


def _meta(result: Dict[str, Any]) -> Dict[str, Any]:
    data = result.get("data")
    if not isinstance(data, dict):
        return {}
    return {k: data[k] for k in _META_KEYS if k in data}


# --- handlers -----------------------------------------------------------------


def build_handlers(manager: Manager) -> Dict[str, Callable[..., Any]]:
    specs = {t["name"]: t for t in TOOL_SPECS}
    handlers: Dict[str, Callable[..., Any]] = {}

    def bridge_tool(name: str) -> Callable[..., Any]:
        spec = specs[name]

        @_safe
        def handle(raw: dict) -> str:
            args = manager.with_session(coerce_args(spec, raw))
            result = manager.call(spec["op"], args)
            return ok(str(result.get("text", "")), **_meta(result))

        return handle

    for name, spec in specs.items():
        if spec.get("op") and not spec.get("adapter"):
            handlers[name] = bridge_tool(name)

    @_safe
    def sap_status(_raw: dict) -> str:
        return ok(manager.status())

    @_safe
    def sap_doctor(_raw: dict) -> str:
        return ok(manager.doctor())

    @_safe
    def sap_start(raw: dict) -> str:
        args = coerce_args(specs["sap_start"], raw)
        return ok(manager.start(args.get("backend"), float(args.get("waitSeconds") or 60)))

    @_safe
    def sap_systems(_raw: dict) -> str:
        systems = cfg.systems()
        if not systems:
            return ok(f"No SAP systems configured ({cfg.config_path()}). Add one with sap_setup_system.")
        default = cfg.default_system()
        lines = []
        for name, p in sorted(systems.items()):
            target = p.connection or p.connectionString
            lines.append(
                f"{name}{' (default)' if name == default else ''}: {p.description or ''}\n"
                f"  sid {p.sid or '?'}, client {p.client or '?'}, user {p.user or '?'}, language {p.language or '-'}, "
                f"via {target}\n  password: {credentials.describe(p.password)}; safety: {p.safety or 'global'}"
            )
        return ok("\n".join(lines))

    @_safe
    def sap_setup_system(raw: dict) -> str:
        args = coerce_args(specs["sap_setup_system"], raw)
        name = args["name"].strip()
        if args.get("remove"):
            return ok(f"Removed system {name}." if cfg.remove_system(name) else f"There is no system {name}.")
        current = cfg.systems().get(name)
        base = current.to_dict() if current else {}
        for key in ("description", "sid", "connection", "connectionString", "client", "user", "language", "password", "safety", "multiLogon"):
            if key in args:
                base[key] = args[key]
        profile = cfg.SystemProfile.from_dict(name, base)
        cfg.save_system(profile)
        return ok(f"Saved system {name} in {cfg.config_path()}. Log on with sap_login system={name}.")

    @_safe
    def sap_login(raw: dict) -> str:
        args = coerce_args(specs["sap_login"], raw)
        result = manager.login(args["system"], args)
        return ok(str(result.get("text", "")), **_meta(result))

    @_safe
    def sap_sessions(raw: dict) -> str:
        args = coerce_args(specs["sap_sessions"], raw)
        action = args.get("action", "list")
        if action != "bind":
            args = manager.with_session(args) if action in ("create", "close", "logoff") else args
        result = manager.call("sessions", args)
        data = result.get("data")
        if action == "bind" and isinstance(data, dict):
            manager.bound_session = data.get("id")
        if action in ("close", "logoff") and manager.bound_session and args.get("session") == manager.bound_session:
            manager.bound_session = None
        return ok(str(result.get("text", "")))

    @_safe
    def sap_screenshot(raw: dict) -> Any:
        args = manager.with_session(coerce_args(specs["sap_screenshot"], raw))
        shots = cfg.ensure_private_dir(manager.state_dir() / "screenshots")
        path = shots / time.strftime("sap-%Y%m%d-%H%M%S.png")
        result = manager.call("screenshot", dict(args, path=str(path)))
        written = Path(str((result.get("data") or {}).get("path") or path))
        text = str(result.get("text", ""))
        if written.exists() and 0 < written.stat().st_size <= MAX_IMAGE_BYTES:
            data_url = "data:image/png;base64," + base64.b64encode(written.read_bytes()).decode("ascii")
            summary = json.dumps({"result": text, "path": str(written)}, ensure_ascii=False)
            return {
                "_multimodal": True,
                "text_summary": summary,
                "meta": {"screenshot_path": str(written)},
                "content": [{"type": "text", "text": text}, {"type": "image_url", "image_url": {"url": data_url}}],
            }
        return ok(text, path=str(written))

    handlers.update(
        sap_status=sap_status, sap_doctor=sap_doctor, sap_start=sap_start, sap_systems=sap_systems,
        sap_setup_system=sap_setup_system, sap_login=sap_login, sap_sessions=sap_sessions, sap_screenshot=sap_screenshot,
    )
    missing = set(TOOL_NAMES) - set(handlers)
    assert not missing, f"no handler for {missing}"
    return handlers
