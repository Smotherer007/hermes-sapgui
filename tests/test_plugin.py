"""Registration, manifest, skills, argument coercion and config."""

from __future__ import annotations

import json
import os
import re
import stat

import pytest
import yaml

from conftest import ROOT, FakeCtx, plugin, sub

SPEC = json.loads((ROOT / "core" / "tools.json").read_text(encoding="utf-8"))
NAMES = [t["name"] for t in SPEC["tools"]]


class TestRegistration:
    def test_registers_every_tool_of_the_shared_spec(self):
        ctx = FakeCtx()
        plugin.register(ctx)
        assert list(ctx.tools) == NAMES
        assert {t["toolset"] for t in ctx.tools.values()} == {"sapgui"}

    def test_manifest_lists_exactly_the_registered_tools(self):
        manifest = yaml.safe_load((ROOT / "plugin.yaml").read_text())
        assert manifest["provides_tools"] == NAMES
        assert manifest["provides_hooks"] == ["pre_tool_call"]
        assert manifest["name"] == "sapgui"
        assert set(manifest["config_schema"]) == set(plugin._SETTING_KEYS)

    def test_schemas_are_plain_json_schema(self):
        ctx = FakeCtx()
        plugin.register(ctx)
        for name, tool in ctx.tools.items():
            schema = tool["schema"]
            assert schema["name"] == name
            assert schema["parameters"]["type"] == "object"
            text = json.dumps(schema)
            assert "$ref" not in text, name
            assert '"type": [' not in text, f"{name}: union types break some providers"
            for req in schema["parameters"]["required"]:
                assert req in schema["parameters"]["properties"]

    def test_hooks_commands_skills_and_prompt_section(self):
        ctx = FakeCtx()
        plugin.register(ctx)
        assert "pre_tool_call" in ctx.hooks
        assert set(ctx.commands) == {"sap", "sap-doctor", "sap-start"}
        assert set(ctx.skills) == {"sapgui", "sapgui-troubleshooting"}
        section = ctx.sections["sapgui.overview"]({})
        assert "sapgui:sapgui" in section

    def test_sap_command_injects_the_task(self):
        ctx = FakeCtx()
        plugin.register(ctx)
        assert ctx.commands["sap"]["handler"]("").startswith("Usage")
        assert "Working on it" in ctx.commands["sap"]["handler"]("show material 4711")
        assert "show material 4711" in ctx.injected[0]

    def test_works_without_the_optional_prompt_section_api(self):
        class Old(FakeCtx):
            register_system_prompt_section = None

        ctx = Old()
        plugin.register(ctx)
        assert ctx.tools


class TestSkills:
    @pytest.mark.parametrize("skill", ["sapgui", "sapgui-troubleshooting"])
    def test_frontmatter(self, skill):
        text = (ROOT / "skills" / skill / "SKILL.md").read_text()
        assert text.startswith("---\n")
        meta = yaml.safe_load(text[4:text.index("\n---", 4)])
        assert meta["name"] == skill
        assert len(meta["description"]) > 40

    def test_skills_only_reference_tools_that_exist(self):
        for path in (ROOT / "skills").glob("*/SKILL.md"):
            for name in set(re.findall(r"\bsap_[a-z_]+", path.read_text())):
                assert name in NAMES, f"{path.parent.name} mentions unknown tool {name}"


class TestCoercion:
    def coerce(self, tool, args):
        tools = sub("tools")
        return tools.coerce_args(next(t for t in SPEC["tools"] if t["name"] == tool), args)

    def test_numbers_booleans_enums(self):
        out = self.coerce("sap_table", {"maxRows": "50", "startRow": 2.0, "scroll": "true", "kind": "LIST"})
        assert out == {"maxRows": 50, "startRow": 2, "scroll": True, "kind": "list"}

    def test_arrays_from_json_strings_and_objects(self):
        out = self.coerce("sap_set", {"fields": '[{"id": "usr/txtA", "value": 5}]', "enter": "yes"})
        assert out == {"fields": [{"id": "usr/txtA", "value": "5"}], "enter": True}
        assert self.coerce("sap_menu", {"path": "Edit > Select All"}) == {"path": "Edit > Select All"}

    def test_errors(self):
        errors = sub("errors")
        with pytest.raises(errors.ToolInputError, match="fields is required"):
            self.coerce("sap_set", {})
        with pytest.raises(errors.ToolInputError, match="maxRows must be a number"):
            self.coerce("sap_table", {"maxRows": "many"})
        with pytest.raises(errors.ToolInputError, match="action must be one of"):
            self.coerce("sap_popup", {"action": "maybe"})
        with pytest.raises(errors.ToolInputError, match=r"fields\[0\].value is required"):
            self.coerce("sap_set", {"fields": [{"id": "x"}]})

    def test_unknown_and_empty_arguments_are_dropped(self):
        assert self.coerce("sap_screen", {"filter": "", "bogus": 1, "window": None}) == {}


class TestConfig:
    def test_save_load_remove_and_permissions(self, isolated):
        cfg = sub("config")
        cfg.save_system(cfg.SystemProfile(name="DEV", sid="dev", connection="DEV - Dev", client="100", user="ME",
                                          password="${env:SAP_PW}", safety="confirm"))
        path = cfg.config_path()
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
        data = json.loads(path.read_text())
        assert data["defaultSystem"] == "DEV"
        assert data["systems"]["DEV"]["sid"] == "DEV"
        assert cfg.get_system(None).name == "DEV"
        assert cfg.get_system("dev").name == "DEV"
        assert cfg.system_for_sid("DEV").name == "DEV"
        assert cfg.remove_system("DEV") is True
        assert cfg.remove_system("DEV") is False

    def test_refuses_clear_text_passwords_and_bad_values(self):
        cfg = sub("config")
        errors = sub("errors")
        with pytest.raises(errors.SapError) as exc:
            cfg.save_system(cfg.SystemProfile(name="P", connection="x", password="hunter2"))
        assert exc.value.code == "PLAINTEXT_PASSWORD"
        assert "hunter2" not in exc.value.message
        with pytest.raises(errors.SapError, match="safety must be"):
            cfg.save_system(cfg.SystemProfile(name="P", connection="x", safety="yolo"))
        with pytest.raises(errors.SapError, match="needs connection"):
            cfg.save_system(cfg.SystemProfile(name="P"))

    def test_settings_precedence(self, isolated, monkeypatch):
        cfg = sub("config")
        cfg.config_path().parent.mkdir(parents=True, exist_ok=True)
        cfg.config_path().write_text(json.dumps({"settings": {"safetyLevel": "readonly", "backend": "java", "requestTimeout": 30}}))
        assert cfg.resolve_settings().safetyLevel == "readonly"
        monkeypatch.setenv("SAPGUI_SAFETY_LEVEL", "confirm-all")
        assert cfg.resolve_settings().safetyLevel == "confirm-all"
        assert cfg.resolve_settings({"safetyLevel": "open"}).safetyLevel == "open"
        assert cfg.resolve_settings({"safetyLevel": "nonsense"}).safetyLevel == "confirm"
        assert cfg.resolve_settings().requestTimeout == 30

    def test_secret_references(self, monkeypatch):
        cred = sub("credentials")
        errors = sub("errors")
        monkeypatch.setenv("SAP_TEST_PW", "s3cret")
        assert cred.resolve("${env:SAP_TEST_PW}") == "s3cret"
        assert cred.resolve("${cmd:printf 'from command\\n'}") == "from command"
        assert cred.resolve("") is None
        with pytest.raises(errors.SapError) as exc:
            cred.resolve("${env:NOPE_NOT_SET}")
        assert exc.value.code == "SECRET_UNAVAILABLE"
        with pytest.raises(errors.SapError):
            cred.resolve("${cmd:false}")
        assert cred.describe("${env:X}") == "env: X"
        assert cred.describe("${cmd:op read secret}") == "command"
        assert "INVALID" in cred.describe("plain")


def test_core_is_unchanged_from_the_shared_version():
    """core/ must be byte-identical in hermes-sapgui and pi-sapgui; CHECKSUMS pins it."""
    import hashlib

    sums = {}
    for line in (ROOT / "core" / "CHECKSUMS").read_text().splitlines():
        digest, name = line.split(maxsplit=1)
        sums[name] = digest
    for name, digest in sums.items():
        actual = hashlib.sha256((ROOT / "core" / name).read_bytes()).hexdigest()
        assert actual == digest, f"core/{name} differs from the shared version -- edit it in both repositories"
    tracked = {str(p.relative_to(ROOT / "core")) for p in (ROOT / "core").rglob("*") if p.is_file() and p.name != "CHECKSUMS"}
    assert tracked == set(sums), "core/ has files that CHECKSUMS does not list (run scripts/sync-core.py)"
