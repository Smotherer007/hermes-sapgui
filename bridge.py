"""Transport to the bridge that runs inside SAP GUI.

* ``WindowsBridge`` -- a ``cscript.exe`` child process running ``ops.js`` +
  ``host-windows.js``; JSON lines over stdin/stdout. Stateless, so a hung COM
  call is handled by killing and restarting the process.
* ``JavaBridge`` -- SAP GUI for Java started with ``ops.js`` + ``host-java.js``
  as its startup script; one file per request and answer in
  ``~/.sapgui-bridge/java-queue`` (SAP GUI for Java's script sandbox allows
  files but no sockets). The JVM outlives the agent; any later agent process
  (pi or Hermes) keeps using the same queue.

Every request is serialised with a lock: SAP GUI is one user interface.
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import secrets as pysecrets
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import launcher
from .config import bridge_home, ensure_private_dir
from .errors import SapError

PLUGIN_DIR = Path(__file__).resolve().parent
CORE_DIR = PLUGIN_DIR / "core"
PROTOCOL = 1


def _ascii_json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=True, separators=(",", ":"))


def build_bundle(kind: str, state_dir: Path, config: Optional[Dict[str, Any]] = None) -> Path:
    """ops.js + the host file (+ a config line) as one script, written only when it changed."""
    parts: List[str] = []
    if config is not None:
        parts.append("var __SAPGUI_BRIDGE_CONFIG = " + _ascii_json(config) + ";")
    parts.append((CORE_DIR / "js" / "ops.js").read_text(encoding="ascii"))
    parts.append((CORE_DIR / "js" / f"host-{kind}.js").read_text(encoding="ascii"))
    text = "\n;\n".join(parts) + "\n"
    ensure_private_dir(state_dir)
    if config is None:
        digest = hashlib.sha256(text.encode("ascii")).hexdigest()[:12]
        path = state_dir / f"bridge-{kind}-{digest}.js"
    else:
        path = state_dir / f"bridge-{kind}.js"
    if not path.exists() or path.read_text(encoding="ascii") != text:
        tmp = path.with_suffix(".tmp")
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="ascii", newline="\n") as fh:
            fh.write(text)
        os.replace(tmp, path)
    return path


def _raise_bridge_error(msg: Dict[str, Any]) -> None:
    err = msg.get("error") or {}
    raise SapError(str(err.get("code") or "BRIDGE_ERROR"), str(err.get("message") or "unknown bridge error"), err.get("hint"))


class _LineReader:
    """Reads lines from a pipe on a thread, so reads can time out."""

    def __init__(self, stream) -> None:
        self.lines: "queue.Queue[Optional[str]]" = queue.Queue()
        self._thread = threading.Thread(target=self._run, args=(stream,), daemon=True)
        self._thread.start()

    def _run(self, stream) -> None:
        try:
            for raw in iter(stream.readline, b""):
                self.lines.put(raw.decode("ascii", "replace").rstrip("\r\n"))
        except (OSError, ValueError):
            pass
        self.lines.put(None)

    def get(self, timeout: float) -> Optional[str]:
        try:
            return self.lines.get(timeout=max(0.01, timeout))
        except queue.Empty:
            raise TimeoutError from None


class WindowsBridge:
    kind = "windows"

    def __init__(self, cscript: str, state_dir: Path, extra_env: Optional[Dict[str, str]] = None) -> None:
        self.cscript = cscript
        self.state_dir = state_dir
        self.extra_env = extra_env
        self.proc: Optional[subprocess.Popen] = None
        self.reader: Optional[_LineReader] = None
        self.next_id = 0
        self.lock = threading.RLock()
        self.ready: Dict[str, Any] = {}

    def _alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def _start(self) -> None:
        bundle = build_bundle("windows", self.state_dir)
        cmd = [self.cscript, "//nologo", "//E:JScript", str(bundle)]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        env = dict(os.environ, **self.extra_env) if self.extra_env else None
        try:
            self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         creationflags=flags, env=env)
        except FileNotFoundError:
            raise SapError("CSCRIPT_NOT_FOUND", f"Cannot run {self.cscript}.", "Set the setting cscript_path.") from None
        self.reader = _LineReader(self.proc.stdout)
        try:
            first = self.reader.get(20)
        except TimeoutError:
            self.close()
            raise SapError("BRIDGE_TIMEOUT", "cscript did not start the bridge within 20 seconds.") from None
        msg = None
        try:
            msg = json.loads(first) if first else None
        except ValueError:
            msg = None
        if not msg or not msg.get("ready"):
            text = (first or "") + " " + " ".join(self._drain_stderr())
            self.close()
            if "disabled" in text.lower() and "script host" in text.lower():
                raise SapError("WSH_DISABLED", "Windows Script Host is disabled on this machine.",
                               "Ask IT to allow cscript.exe (registry HKCU/HKLM Software\\Microsoft\\Windows Script Host\\Settings Enabled=1).")
            raise SapError("BRIDGE_START_FAILED", "cscript did not start the bridge: " + text.strip()[:500])
        if msg.get("protocol") != PROTOCOL:
            self.close()
            raise SapError("BRIDGE_VERSION", f"Bridge protocol {msg.get('protocol')} does not match {PROTOCOL}.")
        self.ready = msg

    def _drain_stderr(self) -> List[str]:
        try:
            if self.proc and self.proc.stderr:
                return [self.proc.stderr.read().decode("utf-8", "replace")[:500]]
        except (OSError, ValueError):
            pass
        return []

    def request(self, op: str, args: Dict[str, Any], timeout: float) -> Dict[str, Any]:
        with self.lock:
            if not self._alive():
                self._start()
            self.next_id += 1
            rid = self.next_id
            line = _ascii_json({"id": rid, "op": op, "args": args}) + "\n"
            try:
                assert self.proc and self.proc.stdin
                self.proc.stdin.write(line.encode("ascii"))
                self.proc.stdin.flush()
            except (OSError, ValueError):
                self.close()
                raise SapError("BRIDGE_DIED", "The bridge process ended unexpectedly.", "Call the tool again; it restarts.") from None
            deadline = time.monotonic() + timeout
            while True:
                try:
                    assert self.reader
                    out = self.reader.get(deadline - time.monotonic())
                except TimeoutError:
                    self.close()
                    raise SapError("TIMEOUT", f"SAP GUI did not answer within {int(timeout)} seconds ({op}).",
                                   "SAP may be waiting for a dialog or a long-running report. Look at the SAP window, "
                                   "then read the screen with sap_screen.") from None
                if out is None:
                    self.close()
                    raise SapError("BRIDGE_DIED", "The bridge process ended unexpectedly.", "Call the tool again; it restarts.")
                try:
                    msg = json.loads(out)
                except ValueError:
                    continue  # stray output (e.g. a WSH warning)
                if msg.get("id") == rid:
                    return msg

    def close(self) -> None:
        proc, self.proc = self.proc, None
        if proc and proc.poll() is None:
            try:
                if launcher.IS_WINDOWS:
                    subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True, timeout=10)
                else:
                    proc.kill()
                proc.wait(timeout=5)
            except (OSError, subprocess.SubprocessError):
                pass


#: A heartbeat older than this means the bridge may be gone (then the pid decides).
HEARTBEAT_STALE_SECONDS = 10.0


def _pid_alive(pid: Any) -> Optional[bool]:
    try:
        n = int(pid)
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None
    if launcher.IS_WINDOWS:
        try:
            out = subprocess.run(["tasklist", "/FI", f"PID eq {n}", "/NH"], capture_output=True, timeout=10).stdout
            return str(n).encode() in out
        except (OSError, subprocess.SubprocessError):
            return None
    try:
        os.kill(n, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return None


class JavaBridge:
    """File-queue transport to the bridge inside SAP GUI for Java.

    SAP GUI for Java runs startup scripts in its "SAPGUI:UserScript" sandbox:
    file access is allowed, sockets are not. So every request is one file in
    ``<state>/java-queue/in`` and every answer one file in ``.../out``; the
    bridge reports liveness with a heartbeat in ``java-status.json``.
    """

    kind = "java"

    def __init__(self, state_dir: Optional[Path] = None) -> None:
        self.state_dir = state_dir or bridge_home()
        self.client = f"{os.getpid()}-{pysecrets.token_hex(3)}"
        self.next_id = 0
        self.lock = threading.RLock()
        self.ready: Dict[str, Any] = {}

    @property
    def launch_file(self) -> Path:
        return self.state_dir / "java-bridge.json"

    @property
    def status_file(self) -> Path:
        return self.state_dir / "java-status.json"

    @property
    def queue_dir(self) -> Path:
        return self.state_dir / "java-queue"

    @property
    def log_file(self) -> Path:
        return self.state_dir / "javagui.log"

    def _read_json(self, path: Path) -> Optional[Dict[str, Any]]:
        for _ in range(3):
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                return None
            except (ValueError, OSError):
                time.sleep(0.05)  # being replaced right now
        return None

    def _live_status(self) -> Dict[str, Any]:
        status = self._read_json(self.status_file)
        if not status or status.get("transport") != "file":
            raise SapError("NOT_RUNNING", "SAP GUI for Java is not running with the bridge.",
                           "Start it with sap_start (SAP GUI for Java must be started by the agent, not by hand).")
        if status.get("protocol") != PROTOCOL:
            raise SapError("BRIDGE_VERSION", f"Bridge protocol {status.get('protocol')} does not match {PROTOCOL}.",
                           "Quit SAP GUI for Java and start it again with sap_start (it then loads the new bridge).")
        age = time.time() - float(status.get("heartbeat") or 0) / 1000.0
        if age > HEARTBEAT_STALE_SECONDS and _pid_alive(status.get("pid")) is not True:
            raise SapError("NOT_RUNNING", f"SAP GUI for Java with the bridge stopped (last sign of life {int(age)} s ago).",
                           "Start it again with sap_start.")
        self.ready = status
        return status

    def reachable(self) -> bool:
        try:
            self._live_status()
            return True
        except SapError:
            return False

    def request(self, op: str, args: Dict[str, Any], timeout: float) -> Dict[str, Any]:
        with self.lock:
            self._live_status()
            self.next_id += 1
            rid = self.next_id
            name = f"{time.time_ns() // 1_000_000:015d}-{self.client}-{rid:06d}"
            inbox, outbox = self.queue_dir / "in", self.queue_dir / "out"
            ensure_private_dir(inbox)
            ensure_private_dir(outbox)
            tmp, req, res = inbox / f"{name}.tmp", inbox / f"{name}.req", outbox / f"{name}.res"
            fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="ascii", newline="\n") as fh:
                fh.write(_ascii_json({"id": rid, "op": op, "args": args}) + "\n")
            os.replace(tmp, req)
            deadline = time.monotonic() + timeout
            next_check = time.monotonic() + 1.0
            pause = 0.005
            while True:
                if res.exists():
                    text = res.read_text(encoding="ascii", errors="replace")
                    try:
                        res.unlink()
                    except OSError:
                        pass
                    try:
                        msg = json.loads(text)
                    except ValueError:
                        raise SapError("BRIDGE_ERROR", "The bridge wrote an unreadable answer.") from None
                    return msg
                now = time.monotonic()
                if now >= deadline:
                    self._withdraw(req)
                    raise SapError("TIMEOUT", f"SAP GUI for Java did not answer within {int(timeout)} seconds ({op}).",
                                   "SAP may be waiting for a dialog or a long-running report. Look at the SAP window, "
                                   "then read the screen with sap_screen.")
                if now >= next_check:
                    next_check = now + 1.0
                    try:
                        self._live_status()
                    except SapError:
                        self._withdraw(req)
                        raise
                time.sleep(pause)
                pause = min(pause * 1.5, 0.05)

    @staticmethod
    def _withdraw(req: Path) -> None:
        try:
            req.unlink()  # not picked up yet: it must not run later
        except OSError:
            pass

    def launch(self, command: List[str], mode: str, wait: float) -> Dict[str, Any]:
        """Start SAP GUI for Java with the bridge; returns the status the bridge wrote."""
        with self.lock:
            ensure_private_dir(self.state_dir)
            for path in (self.status_file, self.launch_file):
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
            ensure_private_dir(self.queue_dir)
            instance = pysecrets.token_hex(8)
            bundle = build_bundle("java", self.state_dir, {"queueDir": str(self.queue_dir), "statusFile": str(self.status_file),
                                                           "mode": mode, "instance": instance})
            fd = os.open(str(self.launch_file), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump({"instance": instance, "command": command, "startedAt": time.time(), "mode": mode}, fh)
            proc = launcher.spawn_detached(command + ["-f", str(bundle)], self.log_file)
            deadline = time.monotonic() + wait
            while time.monotonic() < deadline:
                status = self._read_json(self.status_file)
                if status and status.get("instance") == instance:
                    self.ready = status
                    return status
                if proc.poll() is not None:
                    raise SapError("LAUNCH_FAILED", f"SAP GUI for Java exited right away (code {proc.returncode}).",
                                   f"See the log: {self.log_file}")
                time.sleep(0.25)
            raise SapError(
                "LAUNCH_TIMEOUT",
                f"SAP GUI for Java started but the bridge did not report within {int(wait)} seconds.",
                "Enable scripting in SAP GUI for Java (Preferences > Accessibility & Scripting > Scripting) and check "
                f"{self.log_file}. If SAP GUI shows a dialog about the script, allow it.",
            )

    def close(self) -> None:
        """Nothing to close: every request is its own pair of files."""


def unwrap(msg: Dict[str, Any]) -> Dict[str, Any]:
    if not msg.get("ok"):
        _raise_bridge_error(msg)
    result = msg.get("result")
    return result if isinstance(result, dict) else {"text": "" if result is None else str(result)}
