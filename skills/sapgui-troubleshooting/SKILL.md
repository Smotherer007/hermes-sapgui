---
name: sapgui-troubleshooting
description: "Fix the connection between the agent and SAP GUI: SAP GUI not reachable, SAP GUI for Java not started with the bridge, scripting disabled on the client or the server, Windows Script Host disabled, timeouts, logon failures. Use when a sap_* tool returns SAPGUI_UNAVAILABLE, NOT_RUNNING, SCRIPTING_DISABLED, WSH_DISABLED, LAUNCH_TIMEOUT, LOGON_FAILED or TIMEOUT."
---

# Troubleshooting the SAP GUI connection

Run `sap_doctor` first. It checks each link in order and prints `FAIL` with a fix for the first broken one. Then work through the matching section. Tell the user plainly what they have to do themselves (settings, Basis requests); do not guess around a disabled security setting.

## How the pieces fit

- **SAP GUI for Windows**: the plugin runs a small script with `cscript.exe` that attaches to SAP Logon through COM (`GetObject("SAPGUI")`). SAP Logon must be running.
- **SAP GUI for Java (macOS, Linux)**: the bridge runs *inside* SAP GUI for Java as its startup script and exchanges requests as files in `~/.sapgui-bridge/java-queue` (the script sandbox forbids sockets). That only works for a SAP GUI that `sap_start` started. A SAP GUI opened from the Dock or menu is invisible to the agent.
- In both cases scripting must be allowed on the client **and** on the SAP server.

## SAPGUI_UNAVAILABLE (Windows)

1. Is SAP Logon running? `sap_start` starts it.
2. Client scripting: SAP GUI Options → Accessibility & Scripting → Scripting → "Enable scripting". Untick "Notify when a script attaches to SAP GUI" and "Notify when a script opens a connection", otherwise every call pops up a confirmation.
3. If the option is greyed out, it is locked by group policy – the user's IT has to allow it.

## NOT_RUNNING / LAUNCH_TIMEOUT (SAP GUI for Java)

1. `sap_start` starts SAP GUI for Java with the bridge. If SAP GUI for Java is not found, set the launcher (Hermes setting `java_launcher`, pi `javaLauncher` / `SAPGUI_JAVA_LAUNCHER`):
   - macOS: `/Applications/SAP Clients/SAPGUI/SAPGUI.app/Contents/MacOS/SAPGUI` (the folder name contains the release, e.g. `SAPGUI 8.10`).
   - Linux: `/opt/SAPClients/SAPGUI/bin/guilogon`.
   - Any platform: `java -cp <install>/jar/GuiStartS.jar com.sap.platin.Gui`.
2. Scripting in SAP GUI for Java: Preferences → Accessibility & Scripting → Scripting → enable scripting (and allow scripts to run without asking, if offered).
3. `LAUNCH_TIMEOUT`: SAP GUI started but the bridge did not report. `sap_doctor` shows the end of `~/.sapgui-bridge/javagui.log`. Look for:
   - `[sapgui-bridge] ready: file queue …` – the bridge runs. If calls still fail, check that `~/.sapgui-bridge/java-queue/in` empties (the bridge picks up requests) and look for later lines in the log.
   - an exception mentioning `AccessControlException` – SAP GUI for Java's script sandbox (`SAPGUI:UserScript`) refused something. It allows file access, environment variables and screen capture, but no sockets and no custom JVM options; grants in `SAPGUI.policy` or `-Djava.security.policy` do not change the script's permissions. Report the exact message to the user.
   - a scripting-disabled message – enable scripting (step 2).
4. If SAP GUI for Java freezes while the bridge runs, set the bridge mode (Hermes setting `java_bridge_mode`, pi `javaBridgeMode` / `SAPGUI_JAVA_BRIDGE_MODE`) to `thread`, quit SAP GUI for Java and run `sap_start` again. If it still freezes, try `detach`.
5. If the user had SAP GUI for Java open already, the new window from `sap_start` is the one the agent sees. Ask the user to log on there (or use `sap_login`).

## SCRIPTING_DISABLED (server)

The SAP system does not allow scripting. Only Basis can change it:

- `sapgui/user_scripting = TRUE` (RZ11; dynamic, but lost on restart unless also set in the profile with RZ10).
- With `sapgui/user_scripting_per_user = TRUE`, the user also needs authorization object `S_SCR`.
- `sapgui/user_scripting_set_readonly = TRUE` allows reading only; sessions then show "read-only scripting" in `sap_sessions`, and every change fails.

## WSH_DISABLED (Windows)

Windows Script Host is switched off (often by policy). IT has to set `HKCU\Software\Microsoft\Windows Script Host\Settings\Enabled` (or the HKLM key) to 1. There is no workaround in the plugin.

## Logon problems

- `LOGON_FAILED`: the status bar text is in the message (wrong password, user locked, wrong client). Check the profile with `sap_systems`. Do not retry in a loop – SAP locks the user after a few failed attempts.
- `SECRET_UNAVAILABLE`: the password reference could not be read (environment variable missing, Keychain item missing or locked, `secret-tool` not installed). Fix the reference with `sap_setup_system`.
  - macOS Keychain: `security add-generic-password -s sapgui -a <SYSTEM> -w` and reference `${keychain:sapgui/<SYSTEM>}`.
  - Windows Credential Manager: `cmdkey /generic:sapgui/<SYSTEM> /user:<user> /pass` and reference `${wincred:sapgui/<SYSTEM>}`.
  - Linux: `secret-tool store --label=SAP service sapgui system <SYSTEM>` and reference `${secret-tool:service sapgui system <SYSTEM>}`.
- `PASSWORD_CHANGE_REQUIRED`: the user must change the password in SAP GUI; the agent never does that.
- `CONNECT_FAILED`: the SAP Logon entry name must match exactly (the description, not the SID), or the connection string is wrong / the VPN is down.

## TIMEOUT

SAP did not answer in time (default 60 s; Hermes setting `request_timeout`, pi `requestTimeout` / `SAPGUI_TIMEOUT`). Usually a long-running report or a dialog only visible on screen (for example a security prompt of SAP GUI). Ask the user to look at the SAP window, then read the screen with `sap_screen`. On Windows the bridge restarts by itself; on SAP GUI for Java it keeps running.
