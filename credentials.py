"""Resolve password references. Values never appear in errors or logs.

Supported references:

* ``${env:NAME}``                      environment variable
* ``${keychain:service/account}``      macOS Keychain (``security find-generic-password``);
                                       ``${keychain:service}`` uses the profile's user as account
* ``${secret-tool:attr value ...}``    Linux Secret Service (GNOME Keyring, KWallet)
* ``${wincred:target}``                Windows Credential Manager, generic credential
* ``${cmd:command line}``              any command that prints the secret (1Password ``op read``,
                                       ``pass show``, Bitwarden, ...)
"""

from __future__ import annotations

import base64
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

from .errors import SapError

KINDS = ("env", "keychain", "secret-tool", "wincred", "cmd")
_REF = re.compile(r"^\$\{(?P<kind>[a-z][a-z-]*):(?P<body>.+)\}$", re.DOTALL)
_TIMEOUT = 20


def describe(ref: str) -> str:
    """How a reference resolves, for display (never the value)."""
    if not ref:
        return "none (single sign-on)"
    match = _REF.match(ref)
    if not match or match.group("kind") not in KINDS:
        return "INVALID (clear text?)"
    return f"{match.group('kind')}: {match.group('body')}" if match.group("kind") != "cmd" else "command"


def _run(cmd: list, what: str) -> str:
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=_TIMEOUT, check=False)
    except FileNotFoundError:
        raise SapError("SECRET_UNAVAILABLE", f"{what}: {cmd[0]} is not installed.") from None
    except subprocess.TimeoutExpired:
        raise SapError("SECRET_UNAVAILABLE", f"{what}: no answer within {_TIMEOUT}s (waiting for an unlock prompt?).") from None
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        raise SapError("SECRET_UNAVAILABLE", f"{what} failed (exit {proc.returncode})" + (f": {err[-1]}" if err else ""))
    return proc.stdout.decode("utf-8", "replace")


def resolve(ref: str, user: str = "", core_dir: Optional[Path] = None) -> Optional[str]:
    """The secret, or None when no reference is configured (single sign-on)."""
    if not ref:
        return None
    match = _REF.match(ref.strip())
    if not match or match.group("kind") not in KINDS:
        raise SapError("PLAINTEXT_PASSWORD", "The profile's password is not a secret reference.",
                       "Store it as ${env:...}, ${keychain:...}, ${secret-tool:...}, ${wincred:...} or ${cmd:...}.")
    kind, body = match.group("kind"), match.group("body").strip()

    if kind == "env":
        value = os.environ.get(body)
        if value is None:
            raise SapError("SECRET_UNAVAILABLE", f"Environment variable {body} is not set.")
        return value

    if kind == "keychain":
        if sys.platform != "darwin":
            raise SapError("SECRET_UNAVAILABLE", "${keychain:...} works on macOS only.")
        service, _, account = body.partition("/")
        account = account or user
        cmd = ["security", "find-generic-password", "-s", service]
        if account:
            cmd += ["-a", account]
        cmd.append("-w")
        return _run(cmd, f"Keychain item {service}" + (f"/{account}" if account else "")).rstrip("\n")

    if kind == "secret-tool":
        if not shutil.which("secret-tool"):
            raise SapError("SECRET_UNAVAILABLE", "secret-tool is not installed (package libsecret-tools).")
        return _run(["secret-tool", "lookup", *shlex.split(body)], "secret-tool lookup").rstrip("\n")

    if kind == "wincred":
        if os.name != "nt":
            raise SapError("SECRET_UNAVAILABLE", "${wincred:...} works on Windows only.")
        script = (core_dir or Path(__file__).resolve().parent / "core") / "scripts" / "wincred.ps1"
        out = _run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                    "-File", str(script), "-Target", body], f"Credential Manager entry {body}")
        try:
            return base64.b64decode(out.strip()).decode("utf-8")
        except ValueError:
            raise SapError("SECRET_UNAVAILABLE", "Credential Manager returned an unexpected answer.") from None

    # cmd
    args = shlex.split(body, posix=os.name != "nt")
    return _run(args, "Password command").rstrip("\r\n")
