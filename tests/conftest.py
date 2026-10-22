"""Test fixtures.

The plugin is imported the way Hermes imports a directory plugin: as a
package whose ``__init__.py`` lives in the repository root, under a
namespaced module name.

No test talks to a real SAP system, but every test that calls a tool goes
through the real transport and the real bridge JavaScript:

* Windows backend: ``cscript.exe`` is replaced by ``core/test/fake-wsh.mjs``,
  which runs the bundle in an imitation of Windows Script Host with the SAP
  GUI mock behind ``GetObject("SAPGUI")`` (needs ``node``).
* Java backend: the SAP GUI for Java launcher is replaced by
  ``core/test/fake-javagui.sh``, which runs the bundle in Rhino -- the engine
  SAP GUI for Java embeds -- with the mock as ``application`` (needs ``java``
  and ``RHINO_JAR``).
"""

from __future__ import annotations

import importlib
import importlib.machinery
import importlib.util
import json
import os
import shutil
import stat
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = "hermes_plugins_test.sapgui"
CORE_TEST = ROOT / "core" / "test"
RHINO_JAR = os.environ.get("RHINO_JAR", "/root/tools/rhino.jar")


def _load_plugin():
    if PACKAGE in sys.modules:
        return sys.modules[PACKAGE]
    parent = "hermes_plugins_test"
    if parent not in sys.modules:
        namespace = importlib.util.module_from_spec(importlib.machinery.ModuleSpec(parent, None, is_package=True))
        namespace.__path__ = []  # type: ignore[attr-defined]
        sys.modules[parent] = namespace
    spec = importlib.util.spec_from_file_location(PACKAGE, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[PACKAGE] = module
    spec.loader.exec_module(module)
    return module


plugin = _load_plugin()


def sub(name: str):
    return importlib.import_module(f"{PACKAGE}.{name}")


HAVE_NODE = shutil.which("node") is not None
HAVE_JAVA = shutil.which("java") is not None and Path(RHINO_JAR).exists()
needs_node = pytest.mark.skipif(not HAVE_NODE, reason="node is needed for the WSH imitation")
needs_java = pytest.mark.skipif(not HAVE_JAVA, reason="java and RHINO_JAR are needed for the Java bridge")


class FakeCtx:
    """Records what the plugin registers, like Hermes' plugin context."""

    def __init__(self, settings: Dict[str, Any] | None = None) -> None:
        self.tools: Dict[str, dict] = {}
        self.hooks: Dict[str, Any] = {}
        self.commands: Dict[str, dict] = {}
        self.skills: Dict[str, dict] = {}
        self.sections: Dict[str, Any] = {}
        self.settings = settings or {}
        self.injected: List[str] = []

    def register_tool(self, name, toolset, schema, handler, description=""):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, "description": description}

    def register_hook(self, name, fn):
        self.hooks[name] = fn

    def register_command(self, name, handler, description="", args_hint=""):
        self.commands[name] = {"handler": handler, "description": description, "args_hint": args_hint}

    def register_skill(self, name, path, description=""):
        self.skills[name] = {"path": Path(path), "description": description}

    def register_system_prompt_section(self, name, fn):
        self.sections[name] = fn

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def inject_message(self, prompt, session_key=None):
        self.injected.append(prompt)
        return True

    def call(self, tool: str, args: Dict[str, Any] | None = None) -> Any:
        out = self.tools[tool]["handler"](args or {})
        return out if isinstance(out, dict) else json.loads(out)


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    """Every test gets its own state dir and config file, and no stray env settings."""
    for var in list(os.environ):
        if var.startswith("SAPGUI_") or var.startswith("FAKE_"):
            monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("SAPGUI_BRIDGE_HOME", str(tmp_path / "bridge-home"))
    monkeypatch.setenv("SAPGUI_CONFIG", str(tmp_path / "config.json"))
    sub("config")._reset_for_tests()
    yield tmp_path
    sub("config")._reset_for_tests()


def _wrapper(tmp_path: Path, name: str, body: str) -> str:
    path = tmp_path / name
    path.write_text("#!/bin/sh\n" + body + "\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return str(path)


@pytest.fixture
def windows(tmp_path, monkeypatch):
    """A registered plugin on the Windows backend, cscript replaced by the WSH imitation."""
    cscript = _wrapper(tmp_path, "cscript", f'exec node "{CORE_TEST / "fake-wsh.mjs"}" "$@"')

    def make(settings: Dict[str, Any] | None = None, sap: Dict[str, Any] | None = None) -> FakeCtx:
        if sap is not None:
            monkeypatch.setenv("FAKE_SAP_OPTIONS", json.dumps(sap))
        ctx = FakeCtx({"backend": "windows", "cscript_path": cscript, **(settings or {})})
        plugin.register(ctx)
        return ctx

    return make


@pytest.fixture
def java(tmp_path, monkeypatch):
    """A registered plugin on the Java backend, SAP GUI for Java replaced by Rhino + mock."""
    monkeypatch.setenv("RHINO_JAR", RHINO_JAR)
    launcher = str(CORE_TEST / "fake-javagui.sh")
    made: List[FakeCtx] = []

    def make(settings: Dict[str, Any] | None = None, sap: Dict[str, Any] | None = None) -> FakeCtx:
        if sap is not None:
            monkeypatch.setenv("FAKE_SAP_OPTIONS", json.dumps(sap))
        ctx = FakeCtx({"backend": "java", "java_launcher": launcher, **(settings or {})})
        plugin.register(ctx)
        made.append(ctx)
        return ctx

    yield make
    # stop the bridge a test started (it lives in this test's state dir)
    bridge = sub("bridge")
    b = bridge.JavaBridge()
    try:
        b.request("bridge.shutdown", {}, 5)
    except Exception:
        pass
    b.close()
