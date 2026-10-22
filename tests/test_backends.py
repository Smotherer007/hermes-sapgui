"""End-to-end through the real transports and the real bridge JavaScript."""

from __future__ import annotations

import base64
import json

import pytest

from conftest import needs_java, needs_node, sub


@needs_node
class TestWindowsBackend:
    def test_status_shows_backend_version_and_sessions(self, windows):
        ctx = windows()
        text = ctx.call("sap_status")["result"]
        assert "Backend: windows" in text
        assert "SAP GUI 8.10 patch 2" in text
        assert "/app/con[0]/ses[0]  DEV/100 TESTER" in text

    def test_transaction_screen_set_enter(self, windows):
        ctx = windows()
        assert "entered /nMM03" in ctx.call("sap_transaction", {"tcode": "mm03"})["result"]
        screen = ctx.call("sap_screen")["result"]
        assert '[input] wnd[0]/usr/ctxtRMMG1-MATNR  Material = ""  (F4, required)' in screen
        done = ctx.call("sap_set", {"fields": [{"label": "Material", "value": "4711"}], "enter": True})["result"]
        assert "MM02" in done
        umlaut = ctx.call("sap_set", {"fields": [{"id": "usr/txtMAKT-MAKTX", "value": "Blech äöü €"}]})["result"]
        assert 'set wnd[0]/usr/txtMAKT-MAKTX = "Blech äöü €"' in umlaut

    def test_errors_carry_code_and_hint(self, windows):
        ctx = windows()
        out = ctx.call("sap_press", {"id": "usr/btnNOPE"})
        assert out["code"] == "NOT_FOUND"
        assert "sap_screen" in out["hint"]
        bad = ctx.call("sap_table", {"maxRows": "lots"})
        assert bad["code"] == "BAD_REQUEST"

    def test_table_paging_metadata(self, windows):
        ctx = windows()
        ctx.call("sap_transaction", {"tcode": "SE16N"})
        out = ctx.call("sap_table", {"maxRows": 30})
        assert out["nextStartRow"] == 30
        assert "29 | MAT-0029" in out["result"]

    def test_bind_session_is_used_by_later_calls(self, windows):
        ctx = windows()
        created = ctx.call("sap_sessions", {"action": "create"})["result"]
        assert "/app/con[0]/ses[1]" in created
        # the mock lives in the cscript process; a new session there is visible to later calls
        assert "Bound to /app/con[0]/ses[1]" in ctx.call("sap_sessions", {"action": "bind", "session": "0/1"})["result"]
        assert "ses[1]" in ctx.call("sap_status")["result"]

    def test_timeout_resets_the_bridge_and_the_next_call_works(self, windows, monkeypatch):
        monkeypatch.setenv("FAKE_WSH_HANG_OP", "table")
        ctx = windows({"request_timeout": 5})
        out = ctx.call("sap_table")
        assert out["code"] == "TIMEOUT"
        monkeypatch.delenv("FAKE_WSH_HANG_OP")
        assert "entered /nMM03" in ctx.call("sap_transaction", {"tcode": "MM03"})["result"]
        assert "ctxtRMMG1-MATNR" in ctx.call("sap_screen")["result"]

    def test_windows_script_host_disabled(self, windows, monkeypatch):
        monkeypatch.setenv("FAKE_WSH_DISABLED", "1")
        ctx = windows()
        out = ctx.call("sap_screen")
        assert out["code"] == "WSH_DISABLED"
        assert "Windows Script Host" in out["error"]

    def test_sap_logon_not_running(self, windows, monkeypatch):
        monkeypatch.setenv("FAKE_SAP_DOWN", "1")
        ctx = windows()
        assert ctx.call("sap_screen")["code"] == "SAPGUI_UNAVAILABLE"
        assert "not reachable" in ctx.call("sap_status")["result"]
        doctor = ctx.commands["sap-doctor"]["handler"]("")
        assert "FAIL  SAP GUI scripting engine" in doctor

    def test_doctor_on_a_healthy_setup(self, windows):
        ctx = windows()
        doctor = ctx.call("sap_doctor")["result"]
        assert "OK    bridge 0.1.0 answers" in doctor
        assert "OK    DEV - Development: scripting allowed by the server" in doctor

    def test_screenshot_is_attached_as_image(self, windows):
        ctx = windows(sap={"writeHardCopy": True})
        out = ctx.call("sap_screenshot")
        assert out["_multimodal"] is True
        url = out["content"][1]["image_url"]["url"]
        assert base64.b64decode(url.split(",", 1)[1]).startswith(b"\x89PNG")
        assert out["meta"]["screenshot_path"].endswith(".png")


@needs_node
class TestLogin:
    def setup_system(self, ctx, **extra):
        out = ctx.call("sap_setup_system", {"name": "DEV", "sid": "DEV", "connection": "DEV - Development", "client": "100",
                                            "user": "PAT", "language": "DE", "password": "${env:SAP_TEST_PW}", **extra})
        assert "Saved system DEV" in out["result"], out

    def test_login_resolves_the_secret_and_binds_the_session(self, windows, monkeypatch):
        monkeypatch.setenv("SAP_TEST_PW", "secret")
        ctx = windows(sap={"loggedOn": False})
        self.setup_system(ctx)
        out = ctx.call("sap_login", {"system": "DEV"})
        assert "Logged on" in out["result"]
        assert "Bound to /app/con[0]/ses[0]" in out["result"]
        assert "secret" not in json.dumps(out)
        listing = ctx.call("sap_systems")["result"]
        assert "password: env: SAP_TEST_PW" in listing
        assert "secret" not in listing

    def test_wrong_password(self, windows, monkeypatch):
        monkeypatch.setenv("SAP_TEST_PW", "wrong-one")
        ctx = windows(sap={"loggedOn": False})
        self.setup_system(ctx)
        out = ctx.call("sap_login", {"system": "DEV"})
        assert out["code"] == "LOGON_FAILED"
        assert "wrong-one" not in json.dumps(out)

    def test_missing_secret_and_unknown_system(self, windows):
        ctx = windows(sap={"loggedOn": False})
        self.setup_system(ctx)
        assert ctx.call("sap_login", {"system": "DEV"})["code"] == "SECRET_UNAVAILABLE"
        assert ctx.call("sap_login", {"system": "PRD"})["code"] == "NO_SYSTEM"

    def test_setup_refuses_clear_text(self, windows):
        ctx = windows()
        out = ctx.call("sap_setup_system", {"name": "X", "connection": "X", "password": "hunter2"})
        assert out["code"] == "PLAINTEXT_PASSWORD"
        assert "hunter2" not in json.dumps(out)


@needs_java
class TestJavaBackend:
    def test_start_drive_reconnect(self, java):
        ctx = java(sap={"savePopup": True})
        assert ctx.call("sap_screen")["code"] == "NOT_RUNNING"
        started = ctx.call("sap_start", {"waitSeconds": 30})["result"]
        assert "Started SAP GUI for Java with the bridge" in started
        assert "already running" in ctx.call("sap_start")["result"]
        ctx.call("sap_transaction", {"tcode": "MM02"})
        screen = ctx.call("sap_screen")["result"]
        assert "Change Material 4711" in screen
        # a second agent process (another Manager) reaches the same SAP GUI
        other = java()
        assert "Change Material 4711" in other.call("sap_screen")["result"]
        doctor = other.call("sap_doctor")["result"]
        assert "bridge mode loop" in doctor
        assert "Rhino" in doctor

    def test_doctor_explains_how_to_start(self, java):
        ctx = java()
        doctor = ctx.call("sap_doctor")["result"]
        assert "FAIL  bridge: [NOT_RUNNING]" in doctor
        assert "sap_start" in doctor
