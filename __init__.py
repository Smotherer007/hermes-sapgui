"""Hermes SAP GUI plugin.

Lets Hermes drive SAP GUI for Windows (COM scripting, through cscript.exe)
and SAP GUI for Java on macOS and Linux (through a bridge script that runs
inside SAP GUI for Java). Port-for-port the same tools, parameters, config
file and skills as the pi extension pi-sapgui; the bridge in core/ is shared
byte for byte.

Layout:
  core/          shared with pi-sapgui: bridge JavaScript, tools.json, scripts
  config.py      system profiles + settings (~/.sapgui-bridge/config.json)
  credentials.py password references (env, Keychain, Secret Service, Credential Manager, command)
  launcher.py    find and start SAP Logon / SAP GUI for Java
  bridge.py      transports: cscript child process (Windows), loopback socket (Java)
  manager.py     backend choice, bound session, status/doctor/start/login
  tools.py       tool registry from core/tools.json, argument coercion, results
  safety.py      safety levels via the pre_tool_call hook
  commands.py    /sap, /sap-doctor, /sap-start
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, Mapping

from . import config as cfg
from .commands import make_doctor_command, make_sap_command, make_start_command
from .manager import Manager
from .safety import make_pre_tool_call_hook
from .tools import TOOL_SPECS, TOOLSET, build_handlers, hermes_schema

logger = logging.getLogger(__name__)

_PLUGIN_DIR = Path(__file__).resolve().parent

SKILLS = {
    "sapgui": "Drive SAP GUI reliably: read the screen first, use element ids, check status bar and popups, "
              "never save without being asked.",
    "sapgui-troubleshooting": "Get SAP GUI scripting working: enable scripting, start SAP GUI for Java with the bridge, "
                              "fix SAPGUI_UNAVAILABLE, SCRIPTING_DISABLED and timeouts.",
}

#: Hermes setting key -> setting name in the shared config file.
_SETTING_KEYS = {
    "safety_level": "safetyLevel",
    "backend": "backend",
    "java_launcher": "javaLauncher",
    "java_args": "javaArgs",
    "java_bridge_mode": "javaBridgeMode",
    "cscript_path": "cscriptPath",
    "saplogon_path": "saplogonPath",
    "request_timeout": "requestTimeout",
}


def _frontmatter_description(path: Path) -> str:
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    if not content.startswith("---\n"):
        return ""
    end = content.find("\n---", 4)
    for line in content[4:end].splitlines():
        if line.startswith("description:"):
            return line[len("description:"):].strip().strip("\"'")
    return ""


def _prompt_section(manager: Manager):
    def section(_session: Mapping[str, Any]) -> str:
        lines = [
            "SAP GUI tools (sap_*) are available. Before driving SAP, load the skill sapgui:sapgui with skill_view; "
            "when a sap_* tool reports SAPGUI_UNAVAILABLE, NOT_RUNNING or SCRIPTING_DISABLED, load sapgui:sapgui-troubleshooting.",
        ]
        try:
            lines.append(f"SAP backend: {manager.backend()}; safety level: {manager.settings().safetyLevel}.")
            names = sorted(cfg.systems())
            if names:
                lines.append("Configured SAP systems (sap_login system=...): " + ", ".join(names))
        except Exception:
            pass
        return "\n".join(lines)

    return section


def register(ctx) -> None:
    """Called once by the Hermes plugin loader."""

    def overrides() -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for hermes_key, key in _SETTING_KEYS.items():
            try:
                value = ctx.get_config(hermes_key, default=None)
            except Exception:
                value = None
            if value not in (None, ""):
                out[key] = value
        return out

    manager = Manager(overrides)
    handlers = build_handlers(manager)

    for spec in TOOL_SPECS:
        schema = hermes_schema(spec)
        ctx.register_tool(
            name=spec["name"],
            toolset=TOOLSET,
            schema=schema,
            handler=handlers[spec["name"]],
            description=schema["description"],
        )

    for name, short in SKILLS.items():
        skill_md = _PLUGIN_DIR / "skills" / name / "SKILL.md"
        if skill_md.exists():
            ctx.register_skill(name, skill_md, description=_frontmatter_description(skill_md) or short)

    ctx.register_hook("pre_tool_call", make_pre_tool_call_hook(manager, lambda: manager.settings().safetyLevel))

    ctx.register_command("sap", handler=make_sap_command(ctx), description="Do something in SAP GUI", args_hint="<task>")
    ctx.register_command("sap-doctor", handler=make_doctor_command(manager),
                         description="Diagnose the SAP GUI connection and say how to fix it")
    ctx.register_command("sap-start", handler=make_start_command(manager),
                         description="Start SAP GUI so the agent can drive it", args_hint="[windows|java]")

    register_section = getattr(ctx, "register_system_prompt_section", None)
    if callable(register_section):
        try:
            register_section("sapgui.overview", _prompt_section(manager))
        except Exception:  # older Hermes: the skills are still reachable via skills_list
            logger.debug("sapgui: could not register the system prompt section", exc_info=True)
