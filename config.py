"""System profiles and plugin settings.

File: ``~/.sapgui-bridge/config.json`` (override with ``SAPGUI_CONFIG``). The
same file and format is used by pi-sapgui, so both agents share the systems::

    {
      "systems": {
        "DEV": {
          "description": "S/4 development",
          "sid": "DEV",
          "connection": "DEV - S/4HANA Development",
          "connectionString": "/H/saprouter/S/3299/H/dev.example.com/S/3200",
          "client": "100",
          "user": "PWEPPEL",
          "language": "DE",
          "password": "${keychain:sapgui/DEV}",
          "safety": "confirm",
          "multiLogon": "continue"
        }
      },
      "defaultSystem": "DEV",
      "settings": { "backend": "auto", "safetyLevel": "confirm" }
    }

Passwords are only ever stored as secret references (see secrets.py). The
file is written atomically with mode 0600; it is re-read when it changes, so
the CLI and the gateway (separate processes) stay in sync.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, Optional

from .errors import SapError

_lock = threading.RLock()
_cache: Dict[str, Any] = {"mtime": None, "path": None, "data": None}

SAFETY_LEVELS = ("open", "confirm", "confirm-all", "readonly")
MULTI_LOGON = ("continue", "terminateOthers", "cancel")
BACKENDS = ("auto", "windows", "java")

SETTING_DEFAULTS: Dict[str, Any] = {
    "backend": "auto",
    "safetyLevel": "confirm",
    "javaLauncher": "",
    "javaArgs": "",
    "javaBridgeMode": "loop",
    "cscriptPath": "",
    "saplogonPath": "",
    "requestTimeout": 60,
}


def bridge_home() -> Path:
    override = os.environ.get("SAPGUI_BRIDGE_HOME", "").strip()
    return Path(override).expanduser() if override else Path.home() / ".sapgui-bridge"


def config_path() -> Path:
    override = os.environ.get("SAPGUI_CONFIG", "").strip()
    return Path(override).expanduser() if override else bridge_home() / "config.json"


def ensure_private_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass
    return path


@dataclass(frozen=True)
class SystemProfile:
    name: str
    description: str = ""
    sid: str = ""
    connection: str = ""
    connectionString: str = ""
    client: str = ""
    user: str = ""
    language: str = ""
    password: str = ""
    safety: str = ""
    multiLogon: str = ""

    @staticmethod
    def from_dict(name: str, raw: Dict[str, Any]) -> "SystemProfile":
        def s(key: str) -> str:
            value = raw.get(key)
            return "" if value is None else str(value).strip()

        return SystemProfile(
            name=name,
            description=s("description"),
            sid=s("sid").upper(),
            connection=s("connection"),
            connectionString=s("connectionString"),
            client=s("client"),
            user=s("user"),
            language=s("language"),
            password=s("password"),
            safety=s("safety").lower(),
            multiLogon=s("multiLogon"),
        )

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data.pop("name")
        return {k: v for k, v in data.items() if v not in ("", None)}


def _read_file() -> Dict[str, Any]:
    path = config_path()
    with _lock:
        try:
            mtime = path.stat().st_mtime_ns
        except FileNotFoundError:
            _cache.update(mtime=None, path=str(path), data={})
            return {}
        if _cache["data"] is not None and _cache["mtime"] == mtime and _cache["path"] == str(path):
            return _cache["data"]
        try:
            data = json.loads(path.read_text(encoding="utf-8") or "{}")
        except (OSError, ValueError) as exc:
            raise SapError("CONFIG_INVALID", f"Cannot read {path}: {exc}", "Fix or delete the file.") from None
        if not isinstance(data, dict):
            raise SapError("CONFIG_INVALID", f"{path} must contain a JSON object.")
        _cache.update(mtime=mtime, path=str(path), data=data)
        return data


def _write_file(data: Dict[str, Any]) -> None:
    path = config_path()
    with _lock:
        ensure_private_dir(path.parent)
        fd, tmp = tempfile.mkstemp(prefix=".config-", dir=str(path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2, ensure_ascii=False)
                fh.write("\n")
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        _cache.update(mtime=None, data=None)


def systems() -> Dict[str, SystemProfile]:
    raw = _read_file().get("systems") or {}
    if not isinstance(raw, dict):
        raise SapError("CONFIG_INVALID", f"'systems' in {config_path()} must be an object.")
    return {name: SystemProfile.from_dict(name, value or {}) for name, value in raw.items() if isinstance(value, dict)}


def default_system() -> Optional[str]:
    value = _read_file().get("defaultSystem")
    return str(value) if value else None


def get_system(name: Optional[str]) -> SystemProfile:
    all_systems = systems()
    key = name or default_system()
    if not key:
        raise SapError("NO_SYSTEM", "No system given and no defaultSystem configured.",
                       "List the profiles with sap_systems or add one with sap_setup_system.")
    if key in all_systems:
        return all_systems[key]
    for candidate in all_systems.values():  # case-insensitive name or SID
        if candidate.name.lower() == key.lower() or (candidate.sid and candidate.sid == key.upper()):
            return candidate
    raise SapError("NO_SYSTEM", f'No system profile "{key}".',
                   "Known: " + (", ".join(sorted(all_systems)) or "none") + ". Add one with sap_setup_system.")


def system_for_sid(sid: str, client: str = "") -> Optional[SystemProfile]:
    """The profile whose SID (and client, if several share the SID) matches a session."""
    if not sid:
        return None
    matches = [p for p in systems().values() if p.sid and p.sid == sid.upper()]
    if client:
        exact = [p for p in matches if p.client == client]
        if exact:
            return exact[0]
    return matches[0] if matches else None


_SECRET_KINDS = ("env", "keychain", "secret-tool", "wincred", "cmd")
_SECRET_REF = re.compile(r"^\$\{([a-z][a-z-]*):.+\}$", re.DOTALL)


def save_system(profile: SystemProfile, make_default: bool = False) -> None:
    profile = SystemProfile.from_dict(profile.name, profile.to_dict())  # normalise (SID upper-case, trimmed)
    if not re.match(r"^[A-Za-z0-9_.\-]{1,40}$", profile.name):
        raise SapError("BAD_REQUEST", "Profile names may use letters, digits, '.', '_' and '-' (max 40).")
    ref = _SECRET_REF.match(profile.password) if profile.password else None
    if profile.password and (not ref or ref.group(1) not in _SECRET_KINDS):
        raise SapError(
            "PLAINTEXT_PASSWORD",
            "Refusing to store a clear-text password.",
            "Pass a reference instead: ${env:VAR}, ${keychain:service/account} (macOS), "
            "${secret-tool:attr value ...} (Linux), ${wincred:target} (Windows) or ${cmd:command}.",
        )
    if profile.safety and profile.safety not in SAFETY_LEVELS:
        raise SapError("BAD_REQUEST", f"safety must be one of {', '.join(SAFETY_LEVELS)}.")
    if profile.multiLogon and profile.multiLogon not in MULTI_LOGON:
        raise SapError("BAD_REQUEST", f"multiLogon must be one of {', '.join(MULTI_LOGON)}.")
    if not profile.connection and not profile.connectionString:
        raise SapError("BAD_REQUEST", "A system needs connection (SAP Logon entry) or connectionString.")
    with _lock:
        data = dict(_read_file())
        all_systems = dict(data.get("systems") or {})
        all_systems[profile.name] = profile.to_dict()
        data["systems"] = all_systems
        if make_default or not data.get("defaultSystem"):
            data["defaultSystem"] = profile.name
        _write_file(data)


def remove_system(name: str) -> bool:
    with _lock:
        data = dict(_read_file())
        all_systems = dict(data.get("systems") or {})
        if name not in all_systems:
            return False
        del all_systems[name]
        data["systems"] = all_systems
        if data.get("defaultSystem") == name:
            data["defaultSystem"] = next(iter(all_systems), None)
        _write_file(data)
        return True


def file_settings() -> Dict[str, Any]:
    raw = _read_file().get("settings") or {}
    return raw if isinstance(raw, dict) else {}


@dataclass
class Settings:
    backend: str = "auto"
    safetyLevel: str = "confirm"
    javaLauncher: str = ""
    javaArgs: str = ""
    javaBridgeMode: str = "loop"
    cscriptPath: str = ""
    saplogonPath: str = ""
    requestTimeout: float = 60.0
    extra: Dict[str, Any] = field(default_factory=dict)


def normalize_level(value: Any) -> str:
    level = str(value or "confirm").strip().lower().replace("_", "-")
    # Unknown values fail closed to the stricter behaviour that still lets people work.
    return level if level in SAFETY_LEVELS else "confirm"


def resolve_settings(overrides: Optional[Dict[str, Any]] = None) -> Settings:
    """Defaults < config file 'settings' < environment < agent settings (overrides)."""
    merged: Dict[str, Any] = dict(SETTING_DEFAULTS)
    merged.update({k: v for k, v in file_settings().items() if k in SETTING_DEFAULTS})
    env_map = {
        "SAPGUI_BACKEND": "backend",
        "SAPGUI_SAFETY_LEVEL": "safetyLevel",
        "SAPGUI_JAVA_LAUNCHER": "javaLauncher",
        "SAPGUI_JAVA_ARGS": "javaArgs",
        "SAPGUI_JAVA_BRIDGE_MODE": "javaBridgeMode",
        "SAPGUI_CSCRIPT": "cscriptPath",
        "SAPGUI_SAPLOGON": "saplogonPath",
        "SAPGUI_TIMEOUT": "requestTimeout",
    }
    for env, key in env_map.items():
        if os.environ.get(env, "").strip():
            merged[key] = os.environ[env].strip()
    for key, value in (overrides or {}).items():
        if key in SETTING_DEFAULTS and value not in (None, ""):
            merged[key] = value
    backend = str(merged["backend"]).lower()
    mode = str(merged["javaBridgeMode"]).lower()
    try:
        timeout = float(merged["requestTimeout"])
    except (TypeError, ValueError):
        timeout = 60.0
    return Settings(
        backend=backend if backend in BACKENDS else "auto",
        safetyLevel=normalize_level(merged["safetyLevel"]),
        javaLauncher=str(merged["javaLauncher"] or ""),
        javaArgs=str(merged["javaArgs"] or ""),
        javaBridgeMode=mode if mode in ("loop", "thread", "detach") else "loop",
        cscriptPath=str(merged["cscriptPath"] or ""),
        saplogonPath=str(merged["saplogonPath"] or ""),
        requestTimeout=max(5.0, min(timeout, 600.0)),
    )


def _reset_for_tests() -> None:
    with _lock:
        _cache.update(mtime=None, path=None, data=None)
