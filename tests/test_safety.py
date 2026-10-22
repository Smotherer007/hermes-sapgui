"""The pre_tool_call hook maps the bridge's verdict onto the safety level."""

from __future__ import annotations

import pytest

from conftest import needs_node, sub


def hook(ctx):
    return ctx.hooks["pre_tool_call"]


class TestDecide:
    @pytest.mark.parametrize("level,category,expected", [
        ("open", "commit", "allow"),
        ("confirm", "read", "allow"),
        ("confirm", "navigate", "allow"),
        ("confirm", "input", "allow"),
        ("confirm", "commit", "approve"),
        ("confirm-all", "navigate", "approve"),
        ("confirm-all", "input", "approve"),
        ("confirm-all", "read", "allow"),
        ("readonly", "commit", "block"),
        ("readonly", "input", "allow"),
        ("readonly", "navigate", "allow"),
    ])
    def test_matrix(self, level, category, expected):
        assert sub("safety").decide(level, category) == expected

    def test_stricter(self):
        s = sub("safety")
        assert s.stricter("open", "readonly") == "readonly"
        assert s.stricter("confirm-all", "confirm") == "confirm-all"
        assert s.stricter("confirm", "") == "confirm"


@needs_node
class TestHook:
    def test_reads_are_never_gated(self, windows):
        ctx = windows({"safety_level": "readonly"})
        assert hook(ctx)("sap_screen", {}) is None
        assert hook(ctx)("sap_table", {}) is None
        assert hook(ctx)("sap_status", {}) is None

    def test_confirm_escalates_a_save_to_the_approval_gate(self, windows):
        ctx = windows()
        ctx.call("sap_transaction", {"tcode": "MM02"})
        verdict = hook(ctx)("sap_press", {"id": "tbar[0]/btn[11]"})
        assert verdict["action"] == "approve"
        assert verdict["message"] == "SAP DEV: Press \"Save (Ctrl+S)\" (wnd[0]/tbar[0]/btn[11]) in DEV/100 (MM02) -- presses the Save button"
        assert verdict["rule_key"] == "sapgui:sap_press:DEV"
        assert hook(ctx)("sap_key", {"key": "Ctrl+S"})["action"] == "approve"
        assert hook(ctx)("sap_press", {"label": "Details"}) is None
        assert hook(ctx)("sap_set", {"fields": [{"id": "usr/txtMAKT-MAKTX", "value": "x"}]}) is None
        assert hook(ctx)("sap_script", {"code": "1"})["action"] == "approve"

    def test_readonly_blocks_saves_but_allows_queries(self, windows):
        ctx = windows({"safety_level": "readonly"})
        ctx.call("sap_transaction", {"tcode": "MM02"})
        verdict = hook(ctx)("sap_menu", {"path": ["Edit", "Save"]})
        assert verdict["action"] == "block"
        assert "readonly" in verdict["message"]
        assert hook(ctx)("sap_transaction", {"tcode": "SE16N"}) is None
        assert hook(ctx)("sap_set", {"fields": [{"id": "usr/x", "value": 1}]}) is None
        assert hook(ctx)("sap_transaction", {"command": "/nend"})["action"] == "block"

    def test_confirm_all_asks_for_everything_but_reads(self, windows):
        ctx = windows({"safety_level": "confirm-all"})
        assert hook(ctx)("sap_transaction", {"tcode": "MM03"})["action"] == "approve"
        assert hook(ctx)("sap_set", {"fields": [{"id": "usr/x", "value": 1}]})["action"] == "approve"
        assert hook(ctx)("sap_screen", {}) is None

    def test_open_lets_everything_through(self, windows):
        ctx = windows({"safety_level": "open"})
        ctx.call("sap_transaction", {"tcode": "MM02"})
        assert hook(ctx)("sap_press", {"id": "tbar[0]/btn[11]"}) is None

    def test_a_production_profile_is_stricter_than_the_global_level(self, windows):
        ctx = windows({"safety_level": "open"})
        ctx.call("sap_setup_system", {"name": "PRD-ALIAS", "sid": "DEV", "connection": "x", "safety": "readonly"})
        ctx.call("sap_transaction", {"tcode": "MM02"})
        verdict = hook(ctx)("sap_press", {"id": "tbar[0]/btn[11]"})
        assert verdict["action"] == "block"
        assert "readonly for DEV" in verdict["message"]

    def test_unreadable_screen_fails_closed(self, windows, monkeypatch):
        monkeypatch.setenv("FAKE_SAP_DOWN", "1")
        ctx = windows()
        assert hook(ctx)("sap_press", {"id": "tbar[0]/btn[0]"})["action"] == "approve"
        ctx2 = windows({"safety_level": "readonly"})
        assert hook(ctx2)("sap_key", {"key": "Enter"})["action"] == "block"

    def test_level_is_read_at_call_time(self, windows):
        ctx = windows()
        ctx.call("sap_transaction", {"tcode": "MM02"})
        assert hook(ctx)("sap_key", {"key": "F11"})["action"] == "approve"
        ctx.settings["safety_level"] = "open"
        assert hook(ctx)("sap_key", {"key": "F11"}) is None


@needs_node
def test_arguments_are_classified_the_way_the_handler_sees_them(windows):
    ctx = windows()
    # fields arrive as a JSON string; the OK-code field must still be recognised
    verdict = hook(ctx)("sap_set", {"fields": '[{"id": "wnd[0]/tbar[0]/okcd", "value": "=SAVE"}]'})
    assert verdict["action"] == "approve"
