"""Find and start SAP GUI.

Windows (COM backend): SAP Logon (saplogon.exe) must run; the bridge talks to
it through cscript.exe. SAP GUI for Java: the bridge runs *inside* SAP GUI for
Java, so we start SAP GUI for Java ourselves with the bridge as startup script
(``-f <bundle>``). Paths can always be set explicitly in the settings.
"""

from __future__ import annotations

import glob
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import List, Optional

from .errors import SapError

IS_WINDOWS = os.name == "nt"
IS_MAC = sys.platform == "darwin"


def default_backend() -> str:
    return "windows" if IS_WINDOWS else "java"


def find_cscript(configured: str = "") -> Optional[str]:
    if configured:
        return configured
    if not IS_WINDOWS:
        return None
    root = os.environ.get("SystemRoot", r"C:\Windows")
    for candidate in (os.path.join(root, "System32", "cscript.exe"), os.path.join(root, "Sysnative", "cscript.exe")):
        if os.path.exists(candidate):
            return candidate
    return shutil.which("cscript")


def saplogon_candidates() -> List[str]:
    if not IS_WINDOWS:
        return []
    bases = [os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), os.environ.get("ProgramFiles", r"C:\Program Files")]
    out = []
    for base in bases:
        for rel in (r"SAP\FrontEnd\SAPgui\saplogon.exe", r"SAP\FrontEnd\SAPGUI\saplogon.exe"):
            path = os.path.join(base, rel)
            if os.path.exists(path) and path not in out:
                out.append(path)
    return out


def saplogon_running() -> bool:
    if not IS_WINDOWS:
        return False
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq saplogon.exe", "/NH"], capture_output=True, timeout=10).stdout
        return b"saplogon.exe" in out.lower()
    except (OSError, subprocess.SubprocessError):
        return False


def start_saplogon(configured: str = "") -> str:
    path = configured or next(iter(saplogon_candidates()), "")
    if not path:
        raise SapError("LAUNCHER_NOT_FOUND", "saplogon.exe not found.",
                       "Set the setting saplogon_path to the full path of saplogon.exe.")
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    subprocess.Popen([path], creationflags=flags, close_fds=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return path


def java_launcher_candidates() -> List[str]:
    """Executables that start SAP GUI for Java, most likely first."""
    patterns: List[str] = []
    home = str(Path.home())
    if IS_MAC:
        for root in ("/Applications", f"{home}/Applications"):
            patterns += [
                f"{root}/SAP Clients/SAPGUI*/SAPGUI*.app/Contents/MacOS/SAPGUI",
                f"{root}/SAP Clients/SAPGUI*.app/Contents/MacOS/SAPGUI",
                f"{root}/SAPGUI*.app/Contents/MacOS/SAPGUI",
                f"{root}/SAP*/SAPGUI*.app/Contents/MacOS/SAPGUI*",
            ]
    elif IS_WINDOWS:
        for base in (os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")):
            patterns += [os.path.join(base, "SAP", "JavaGUI*", "bin", "guilogon.bat"),
                         os.path.join(base, "SAPClients", "SAPGUI*", "bin", "guilogon.bat")]
    else:
        for root in ("/opt/SAPClients", f"{home}/SAPClients", "/usr/local/SAPClients", "/opt/sap", "/opt/SAP"):
            patterns += [f"{root}/SAPGUI*/bin/guilogon", f"{root}/*/bin/guilogon"]
    found: List[str] = []
    for pattern in patterns:
        for path in sorted(glob.glob(pattern), reverse=True):  # newest release first
            if os.path.isfile(path) and path not in found:
                found.append(path)
    return found


def java_launch_command(configured: str = "", extra_args: str = "") -> List[str]:
    if configured:
        cmd = shlex.split(configured, posix=not IS_WINDOWS)
    else:
        candidates = java_launcher_candidates()
        if not candidates:
            raise SapError(
                "LAUNCHER_NOT_FOUND",
                "SAP GUI for Java was not found in the usual install locations.",
                "Set the setting java_launcher, e.g. '/Applications/SAP Clients/SAPGUI/SAPGUI.app/Contents/MacOS/SAPGUI' "
                "(macOS), '/opt/SAPClients/SAPGUI/bin/guilogon' (Linux) or 'java -cp <path>/GuiStartS.jar com.sap.platin.Gui'.",
            )
        cmd = [candidates[0]]
    if extra_args:
        cmd += shlex.split(extra_args, posix=not IS_WINDOWS)
    return cmd


def spawn_detached(cmd: List[str], log_path: Path, env: Optional[dict] = None) -> subprocess.Popen:
    """Start a GUI process that outlives the agent; its stdout/stderr go to log_path."""
    log = open(log_path, "ab", buffering=0)
    kwargs = dict(stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, close_fds=True, env=env)
    if IS_WINDOWS:
        kwargs["creationflags"] = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        kwargs["start_new_session"] = True
    try:
        return subprocess.Popen(cmd, **kwargs)  # type: ignore[arg-type]
    except FileNotFoundError:
        raise SapError("LAUNCHER_NOT_FOUND", f"Cannot run {cmd[0]}.", "Check the java_launcher setting.") from None
    finally:
        log.close()


def javagui_processes() -> List[str]:
    """Command lines of running SAP GUI for Java processes (best effort, macOS/Linux)."""
    if IS_WINDOWS:
        return []
    try:
        out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, timeout=10).stdout.decode("utf-8", "replace")
    except (OSError, subprocess.SubprocessError):
        return []
    return [line.strip() for line in out.splitlines() if "com.sap.platin" in line or "/SAPGUI.app/" in line or "guilogon" in line]
