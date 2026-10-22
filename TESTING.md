# Testing against a real SAP system

The automated tests run the real bridge JavaScript against a mock of the SAP GUI
Scripting object model: under an imitation of Windows Script Host (for the
Windows backend) and under Rhino, the engine SAP GUI for Java embeds (for the
Java backend). What they cannot prove is how a real SAP GUI behaves. This
checklist closes that gap. Work through it once per platform and note the
results; every step names what to report when it fails.

Use a development or sandbox system, a user with display authorizations, and a
material / customer / table you know.

## 0. Prerequisites

- [ ] Server: `sapgui/user_scripting = TRUE` (RZ11). If `sapgui/user_scripting_per_user` is on, the user needs `S_SCR`.
- [ ] Client: scripting enabled; "notify when a script attaches" / "opens a connection" unticked.
- [ ] `sap_doctor` (or `/sap-doctor`) shows no `FAIL`.

## A. SAP GUI for Java on macOS

| # | Step | Expected | If it fails, report |
|---|---|---|---|
| A1 | `sap_start` | "Started SAP GUI for Java with the bridge (Rhino …, mode loop, file queue)"; the SAP GUI logon window opens | the message, and the last 30 lines of `~/.sapgui-bridge/javagui.log` |
| A2 | Use the logon window while the bridge runs (scroll the list, open an entry) | SAP GUI reacts normally | whether the window is frozen; then retry A1 with bridge mode `thread`, then `detach` |
| A2b | `sap_doctor` | `OK    bridge 0.1.0 answers (Rhino …)` and `transport file` | the full output and the end of `javagui.log` (look for `AccessControlException`) |
| A3 | Log on by hand, then `sap_status` | the connection and session with SID/client/user | the full `sap_status` text |
| A4 | Quit SAP GUI, `sap_start`, then `sap_login system=<profile>` | "Logged on: submitted the logon screen …"; bound to `/app/con[0]/ses[0]` | the error code/message |
| A5 | `sap_transaction tcode=MM03`, then `sap_screen` | header `<SID>/<client> … MM03 · SAPLMGMM 0060`; `[input] wnd[0]/usr/ctxtRMMG1-MATNR  Material = ""` | the full `sap_screen` text (labels missing? types wrong?) |
| A6 | `sap_set fields=[{id: wnd[0]/usr/ctxtRMMG1-MATNR, value: <material>}] enter=true` | the next screen (view selection popup or basic data) | text + whether SAP shows the value |
| A7 | `sap_popup` on the view-selection popup, then `sap_popup action=confirm` | popup lines and buttons; then the material screen | text |
| A8 | `sap_transaction tcode=SE16N`, table `MARA`, F8; then `sap_table maxRows=200` | 200 rows with real values (no `0000000123` placeholders), `startRow=200` hint | the first and last rows of the answer |
| A9 | `sap_table_action action=pressToolbar button=&MB_EXPORT` (or another menu button from the toolbar list) | "menu items …" | text |
| A10 | Any classic report (e.g. `SE38` → `RSPARAM` or `SM37` job list), then `sap_table kind=list pages=2` | text lines of the list | text |
| A11 | `sap_screenshot` | an image of the SAP window | the message; on macOS SAP GUI may need *Screen Recording* permission (System Settings → Privacy & Security) |
| A12 | With safety level `confirm`: open a change transaction, `sap_key key=Ctrl+S` | an approval prompt naming the system and "Ctrl+S / F11 saves"; deny it | whether the prompt came and the call was blocked |
| A13 | `sap_sessions action=create`, then `sap_sessions` | two sessions listed | text |
| A14 | Restart Hermes/pi (SAP GUI stays open), then `sap_screen` | works without `sap_start` (reconnect via `~/.sapgui-bridge`) | error code |

## B. SAP GUI for Windows

| # | Step | Expected | If it fails, report |
|---|---|---|---|
| B1 | SAP Logon closed: `sap_start` | "Started SAP Logon …; scripting engine reachable" | the message |
| B2 | Log on by hand, `sap_status` | session listed | text |
| B3 | `sap_login system=<profile>` (profile with `connection` = the SAP Logon entry name) | "Logged on …" | error code; check the entry name matches exactly |
| B4–B11 | as A5–A13 | as there | as there |
| B12 | Start a long report and, while it runs, `sap_screen` with `request_timeout`/`SAPGUI_TIMEOUT` = 10 | `[TIMEOUT]`; the next call works again | text |
| B13 | Kill SAP Logon in Task Manager, call `sap_screen`, start SAP Logon, call again | `[SAPGUI_UNAVAILABLE]`, then it works | text |

## C. Safety, both platforms

- [ ] Global `readonly`: `sap_press id=tbar[0]/btn[11]` on a change screen → blocked; `sap_transaction` and `sap_set` still work.
- [ ] Profile with `safety: readonly` for the system, global `open` → saves on that system are blocked.
- [ ] A "Save changes?" popup (e.g. leave a changed screen with F3): `sap_popup action=confirm` asks; `action=cancel` does not.
- [ ] Post/Delete buttons of the application toolbar ask before they run.

## What to send back

For any failure: the step number, the tool output, `sap_doctor` output, the
SAP GUI version (About dialog) and, for SAP GUI for Java, the end of
`~/.sapgui-bridge/javagui.log`. Element types or property names that differ
between SAP GUI for Java and Windows show up in A5–A10; those answers are what
the bridge needs to be adjusted.
