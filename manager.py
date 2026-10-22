"""One object the tools, the safety hook and the commands share.

It picks the backend (Windows COM or SAP GUI for Java), owns the bridge, the
bound session, and implements the tools that are not plain bridge calls:
status, doctor, start, login.
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Union

from . import config as cfg
from . import credentials, launcher
from .bridge import CORE_DIR, JavaBridge, WindowsBridge, unwrap
from .errors import SapError

Bridge = Union[WindowsBridge, JavaBridge]


class Manager:
    def __init__(self, get_overrides: Callable[[], Dict[str, Any]] = dict) -> None:
        self._get_overrides = get_overrides
        self._bridge: Optional[Bridge] = None
        self._bridge_key: Optional[tuple] = None
        self._lock = threading.RLock()
        self.bound_session: Optional[str] = None

    # settings & backend -------------------------------------------------

    def settings(self) -> cfg.Settings:
        try:
            overrides = self._get_overrides() or {}
        except Exception:
            overrides = {}
        return cfg.resolve_settings(overrides)

    def backend(self, settings: Optional[cfg.Settings] = None) -> str:
        s = settings or self.settings()
        return launcher.default_backend() if s.backend == "auto" else s.backend

    def state_dir(self) -> Path:
        return cfg.bridge_home()

    def bridge(self, backend: Optional[str] = None) -> Bridge:
        s = self.settings()
        kind = backend or self.backend(s)
        with self._lock:
            if kind == "windows":
                cscript = launcher.find_cscript(s.cscriptPath)
                if not cscript:
                    raise SapError("CSCRIPT_NOT_FOUND", "cscript.exe not found -- the Windows backend needs Windows.",
                                   "On macOS/Linux use the Java backend (backend = java or auto).")
                key = ("windows", cscript)
            else:
                key = ("java", str(self.state_dir()))
            if self._bridge is None or self._bridge_key != key:
                if self._bridge is not None:
                    self._bridge.close()
                self._bridge = WindowsBridge(cscript, self.state_dir()) if kind == "windows" else JavaBridge(self.state_dir())
                self._bridge_key = key
            return self._bridge

    def close(self) -> None:
        with self._lock:
            if self._bridge is not None:
                self._bridge.close()
            self._bridge = None

    # requests -------------------------------------------------------------

    def call(self, op: str, args: Optional[Dict[str, Any]] = None, timeout: Optional[float] = None) -> Dict[str, Any]:
        s = self.settings()
        return unwrap(self.bridge().request(op, args or {}, timeout or s.requestTimeout))

    def with_session(self, args: Dict[str, Any]) -> Dict[str, Any]:
        if not args.get("session") and self.bound_session:
            args = dict(args, session=self.bound_session)
        return args

    def guard(self, tool: str, args: Dict[str, Any]) -> Dict[str, Any]:
        return self.call("guard", {"tool": tool, "args": self.with_session(args)}, timeout=20)

    # adapter tools ----------------------------------------------------------

    def start(self, backend: Optional[str] = None, wait: float = 60) -> str:
        s = self.settings()
        kind = backend if backend in ("windows", "java") else self.backend(s)
        if kind == "windows":
            b = self.bridge("windows")
            try:
                hello = unwrap(b.request("hello", {}, 20))
                if not hello.get("sapguiError"):
                    return f"SAP GUI is already running (SAP GUI {self._version(hello)}); {hello.get('connections', 0)} connection(s)."
            except SapError:
                pass
            path = launcher.start_saplogon(s.saplogonPath)
            deadline = time.monotonic() + wait
            last = ""
            while time.monotonic() < deadline:
                time.sleep(1.5)
                try:
                    hello = unwrap(b.request("hello", {}, 20))
                    if not hello.get("sapguiError"):
                        return (f"Started SAP Logon ({path}); scripting engine reachable (SAP GUI {self._version(hello)}). "
                                "Log on with sap_login or in SAP Logon, then use sap_sessions.")
                    last = (hello.get("sapguiError") or {}).get("message", "")
                except SapError as exc:
                    last = exc.message
            raise SapError("LAUNCH_TIMEOUT", f"SAP Logon started but scripting is not reachable: {last}",
                           "Enable scripting in SAP GUI Options > Accessibility & Scripting > Scripting, then run sap_doctor.")
        b = self.bridge("java")
        assert isinstance(b, JavaBridge)
        if b.reachable():
            return "SAP GUI for Java with the bridge is already running."
        running = launcher.javagui_processes()
        cmd = launcher.java_launch_command(s.javaLauncher, s.javaArgs)
        status = b.launch(cmd, s.javaBridgeMode, wait)
        note = ""
        if running:
            note = ("\nNote: another SAP GUI for Java was already running without the bridge; the agent can only see "
                    "the window it started. Log on in the new window or with sap_login.")
        return (f"Started SAP GUI for Java with the bridge ({status.get('engine', '')}, mode {status.get('mode')}, "
                f"file queue). Log on in its logon window or call sap_login." + note)

    @staticmethod
    def _version(hello: Dict[str, Any]) -> str:
        v = hello.get("sapgui") or {}
        return ".".join(x for x in (v.get("major"), v.get("minor")) if x) + (f" patch {v['patch']}" if v.get("patch") else "")

    def login(self, system: str, overrides: Dict[str, Any]) -> Dict[str, Any]:
        profile = cfg.get_system(system)
        password = credentials.resolve(profile.password, profile.user, CORE_DIR)
        args = {
            "connection": profile.connection,
            "connectionString": profile.connectionString,
            "client": overrides.get("client") or profile.client,
            "user": profile.user,
            "language": overrides.get("language") or profile.language,
            "multiLogon": overrides.get("multiLogon") or profile.multiLogon or "continue",
        }
        if password is not None:
            args["password"] = password
        args = {k: v for k, v in args.items() if v not in ("", None)}
        try:
            result = self.call("login", args, timeout=max(120.0, self.settings().requestTimeout))
        except SapError as exc:
            if password:
                exc.message = exc.message.replace(password, "***")
            raise
        session = (result.get("data") or {}).get("session")
        if session:
            self.bound_session = session
        text = str(result.get("text", ""))
        if password:
            text = text.replace(password, "***")
        result["text"] = text + (f"\nBound to {session}." if session else "")
        return result

    def status(self) -> str:
        s = self.settings()
        kind = self.backend(s)
        lines = [f"Backend: {kind} ({'SAP GUI for Windows via COM' if kind == 'windows' else 'SAP GUI for Java bridge'})",
                 f"Safety level: {s.safetyLevel}", f"Config: {cfg.config_path()}"]
        try:
            hello = self.call("hello", timeout=20)
            if hello.get("sapguiError"):
                err = hello["sapguiError"]
                lines.append(f"SAP GUI: not reachable -- [{err.get('code')}] {err.get('message')}")
                if err.get("hint"):
                    lines.append(f"Hint: {err['hint']}")
            else:
                lines.append(f"SAP GUI {self._version(hello)} via bridge {hello.get('bridge')} ({hello.get('engine')})")
                lines.append(self.call("sessions", {"action": "list"}, timeout=30).get("text", ""))
        except SapError as exc:
            lines.append("SAP GUI: " + exc.to_text())
        lines.append(f"Bound session: {self.bound_session or '(none -- the active session is used)'}")
        try:
            names = sorted(cfg.systems())
            lines.append("Systems: " + (", ".join(names) if names else "none configured (sap_setup_system)"))
        except SapError as exc:
            lines.append("Systems: " + exc.to_text())
        return "\n".join(lines)

    def doctor(self) -> str:
        """Check every link of the chain and say how to fix the first broken one."""
        s = self.settings()
        kind = self.backend(s)
        out: List[str] = []

        def ok(text: str) -> None:
            out.append(f"OK    {text}")

        def bad(text: str, fix: str = "") -> None:
            out.append(f"FAIL  {text}" + (f"\n      fix: {fix}" if fix else ""))

        def info(text: str) -> None:
            out.append(f"info  {text}")

        info(f"platform {sys.platform}, backend {kind} (setting: {s.backend}), safety {s.safetyLevel}")
        info(f"state dir {self.state_dir()}, config {cfg.config_path()}")
        try:
            for name, p in sorted(cfg.systems().items()):
                info(f"system {name}: sid {p.sid or '?'} client {p.client or '?'} user {p.user or '?'} "
                     f"password {credentials.describe(p.password)} safety {p.safety or '(global)'}")
        except SapError as exc:
            bad(exc.message, exc.hint or "")

        if kind == "windows":
            cscript = launcher.find_cscript(s.cscriptPath)
            if not cscript:
                bad("cscript.exe not found", "The Windows backend needs Windows; set backend to java elsewhere.")
                return "\n".join(out)
            ok(f"cscript: {cscript}")
            if launcher.IS_WINDOWS:
                (ok if launcher.saplogon_running() else bad)(
                    "SAP Logon (saplogon.exe) running" if launcher.saplogon_running() else "SAP Logon is not running",
                    "" if launcher.saplogon_running() else "Start it with sap_start or by hand.")
        else:
            cands = [s.javaLauncher] if s.javaLauncher else launcher.java_launcher_candidates()
            if cands:
                ok("SAP GUI for Java launcher: " + cands[0] + (f" (+{len(cands) - 1} more)" if len(cands) > 1 else ""))
            else:
                bad("SAP GUI for Java not found", "Install SAP GUI for Java or set the setting java_launcher.")
            procs = launcher.javagui_processes()
            if procs:
                info(f"{len(procs)} SAP GUI for Java process(es) running")
        try:
            b = self.bridge()
            hello = unwrap(b.request("hello", {}, 25))
            ok(f"bridge {hello.get('bridge')} answers ({hello.get('engine')})")
            if isinstance(b, JavaBridge):
                try:
                    binfo = unwrap(b.request("bridge.info", {}, 10))
                    info(f"bridge mode {binfo.get('mode')}, transport {binfo.get('transport')}, Java {binfo.get('java')}, "
                         f"{binfo.get('os')}, pid {binfo.get('pid')}")
                except SapError:
                    pass
            if hello.get("sapguiError"):
                err = hello["sapguiError"]
                bad(f"SAP GUI scripting engine: [{err.get('code')}] {err.get('message')}", err.get("hint") or
                    "Enable scripting: SAP GUI Options > Accessibility & Scripting > Scripting > Enable scripting.")
            else:
                ok(f"SAP GUI scripting engine reachable (SAP GUI {self._version(hello)})")
                data = self.call("sessions", {"action": "list"}, timeout=30).get("data") or []
                if not data:
                    info("no connection open -- log on with sap_login or in SAP GUI")
                for conn in data:
                    label = conn.get("description") or conn.get("id")
                    if conn.get("disabledByServer"):
                        bad(f"{label}: scripting disabled by the server",
                            "Basis: RZ11 sapgui/user_scripting = TRUE (and, if set, the S_SCR authorization).")
                    else:
                        ok(f"{label}: scripting allowed by the server")
                    for sess in conn.get("sessions") or []:
                        ro = " -- READ-ONLY scripting (sapgui/user_scripting_set_readonly)" if sess.get("scriptingModeReadOnly") else ""
                        info(f"session {sess.get('id')}: {sess.get('systemName')}/{sess.get('client')} {sess.get('user')} "
                             f"{sess.get('transaction') or ''}{ro}")
        except SapError as exc:
            hint = exc.hint or ""
            if kind == "java" and exc.code == "NOT_RUNNING":
                hint = "Start SAP GUI for Java through sap_start; a SAP GUI started from the Dock/menu has no bridge."
            bad(f"bridge: [{exc.code}] {exc.message}", hint)
            if kind == "java":
                log = self.state_dir() / "javagui.log"
                if log.exists():
                    tail = log.read_text(encoding="utf-8", errors="replace").splitlines()[-15:]
                    info("last lines of " + str(log) + ":\n        " + "\n        ".join(tail))
        return "\n".join(out)

