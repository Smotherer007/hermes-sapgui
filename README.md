# hermes-sapgui

SAP GUI plugin for [Hermes Agent](https://github.com/NousResearch/hermes-agent).

With it, Hermes drives the real SAP GUI: it starts transactions, reads screens, fills selection screens, reads ALV grids, table controls, trees and report lists, answers popups, and can log on. It works with **SAP GUI for Windows** and with **SAP GUI for Java on macOS and Linux**. Anything that saves, posts, releases or deletes goes through Hermes' approval gate first.

This is the Hermes twin of [pi-sapgui](https://github.com/Smotherer007/pi-sapgui). Both share the same bridge code (`core/`, byte for byte), the same tools and parameters, the same config file and the same skills.

## How it works

Both SAP GUIs ship the same *SAP GUI Scripting API* (`findById`, `wnd[0]/usr/...`, `sendVKey`, ...). The plugin runs one small JavaScript library, `core/js/ops.js`, **inside** the scripting engine of whichever SAP GUI you use, and talks to it in JSON lines:

```
Hermes ──JSON lines──▶ bridge ──SAP GUI Scripting API──▶ SAP GUI ──▶ SAP system
                         │
   Windows:  cscript.exe + host-windows.js  ── COM: GetObject("SAPGUI")   (stdin/stdout)
   macOS/Linux: SAP GUI for Java runs host-java.js as its startup script   (127.0.0.1 socket + token)
```

- **SAP GUI for Windows**: `cscript.exe` (part of every Windows) attaches to SAP Logon through COM. No pywin32, no native modules. The bridge process holds no state, so a hung call is fixed by restarting it.
- **SAP GUI for Java**: SAP GUI for Java has its own JavaScript engine and can run a script at start-up (`-f <script>`). `sap_start` launches SAP GUI for Java with the bridge as that script. The bridge opens a socket on 127.0.0.1 only and accepts only clients that know the per-launch token stored in `~/.sapgui-bridge/` (mode 0600). SAP GUI keeps running when Hermes restarts; Hermes (or pi) reconnects.

Other SAP GUI MCP servers ([Hochfrequenz/sapgui.mcp](https://github.com/Hochfrequenz/sapgui.mcp), [kts982/mcp-sap-gui](https://github.com/kts982/mcp-sap-gui), ...) support SAP GUI for Windows only, plus the Web GUI in a browser. Driving SAP GUI for Java's own scripting engine is what this plugin adds.

## Installation

```bash
hermes plugins install Smotherer007/hermes-sapgui
hermes plugins enable sapgui
```

For development:

```bash
git clone https://github.com/Smotherer007/hermes-sapgui
hermes plugins install file://$PWD/hermes-sapgui --enable
hermes plugins doctor ./hermes-sapgui
```

The plugin uses only the Python standard library.

### Prepare SAP GUI

Scripting must be allowed in two places:

| Where | What |
|---|---|
| SAP system (Basis) | `sapgui/user_scripting = TRUE` (RZ11). Optionally `sapgui/user_scripting_per_user = TRUE` + authorization `S_SCR` to allow it per user, or `sapgui/user_scripting_set_readonly = TRUE` for read-only scripting. |
| SAP GUI for Windows | Options → Accessibility & Scripting → Scripting → *Enable scripting*; untick both *Notify when a script …* boxes. |
| SAP GUI for Java | Preferences → Accessibility & Scripting → Scripting → enable scripting (and allow scripts without asking, where offered). |

## Quick start

1. **Start SAP GUI.** Ask Hermes to run `sap_start`, or use `/sap-start`.
   - Windows: starts SAP Logon if needed.
   - macOS/Linux: starts SAP GUI for Java *with the bridge*. A SAP GUI for Java you opened from the Dock is invisible to the plugin. Use the window `sap_start` opens.
2. **Log on**: either by hand in SAP GUI, or with a system profile and `sap_login` (see below).
3. **Ask for something**: "Show me the description and material type of material 4711 in DEV", or `/sap show the open sales orders of customer 1000`.

`sap_doctor` (or `/sap-doctor`) checks each link of the chain and says how to fix the first broken one.

## Configuration

### System profiles

Profiles live in `~/.sapgui-bridge/config.json` (override: `SAPGUI_CONFIG`). pi-sapgui reads the same file. Create them with `sap_setup_system` or by hand:

```json
{
  "systems": {
    "DEV": {
      "description": "S/4 development",
      "sid": "DEV",
      "connection": "DEV - S/4HANA Development",
      "client": "100",
      "user": "PWEPPEL",
      "language": "DE",
      "password": "${keychain:sapgui/DEV}",
      "safety": "confirm"
    },
    "PRD": {
      "sid": "PRD",
      "connectionString": "/H/saprouter.example.com/S/3299/H/prd.example.com/S/3200",
      "client": "100",
      "user": "PWEPPEL",
      "safety": "readonly"
    }
  },
  "defaultSystem": "DEV"
}
```

- `connection` is the entry name exactly as SAP Logon shows it (Windows; SAP GUI for Java also knows the entries of its own logon pad). `connectionString` works everywhere (`/H/<router>/S/<port>/H/<host>/S/32<NN>`; for SAP GUI for Java also `conn=/H/...`).
- `sid` links the profile to sessions on that system, so its `safety` level applies even to sessions you opened by hand.
- Leave out `password` for single sign-on (SNC).

### Passwords

Passwords are **never** stored in clear text; `sap_setup_system` refuses them. The profile holds a reference, resolved at logon time and never shown to the model:

| Reference | Source | Store the secret with |
|---|---|---|
| `${keychain:sapgui/DEV}` | macOS Keychain (service/account) | `security add-generic-password -s sapgui -a DEV -w` |
| `${wincred:sapgui/DEV}` | Windows Credential Manager | `cmdkey /generic:sapgui/DEV /user:PWEPPEL /pass` |
| `${secret-tool:service sapgui system DEV}` | Linux Secret Service | `secret-tool store --label="SAP DEV" service sapgui system DEV` |
| `${env:SAP_DEV_PASSWORD}` | environment variable | your shell / container secrets |
| `${cmd:op read op://Private/SAP DEV/password}` | any command (1Password, pass, Bitwarden, ...) | that tool |

### Settings

`plugins.entries.sapgui.settings` in `config.yaml`, or the plugin's form in the Hermes Desktop app. The same keys (camelCase) also work in the `settings` object of `~/.sapgui-bridge/config.json`, and as environment variables.

| Setting | Env | Default | Meaning |
|---|---|---|---|
| `safety_level` | `SAPGUI_SAFETY_LEVEL` | `confirm` | see below |
| `backend` | `SAPGUI_BACKEND` | `auto` | `windows` (COM), `java`, or `auto` (Windows → COM, else Java) |
| `java_launcher` | `SAPGUI_JAVA_LAUNCHER` | auto | command that starts SAP GUI for Java; found automatically under `/Applications/SAP Clients/…` and `/opt/SAPClients/…` |
| `java_args` | `SAPGUI_JAVA_ARGS` | | extra SAP GUI for Java arguments |
| `java_bridge_mode` | `SAPGUI_JAVA_BRIDGE_MODE` | `loop` | `loop`, or the fallbacks `thread` / `detach` if SAP GUI for Java freezes while the bridge runs |
| `cscript_path` | `SAPGUI_CSCRIPT` | `%SystemRoot%\System32\cscript.exe` | Windows |
| `saplogon_path` | `SAPGUI_SAPLOGON` | standard install path | Windows, for `sap_start` |
| `request_timeout` | `SAPGUI_TIMEOUT` | `60` | seconds per SAP GUI call |

### Safety levels

| Level | Reads | Navigate / fill fields | Save, post, delete, raw OK-codes, `sap_script`, close session |
|---|---|---|---|
| `open` | ✓ | ✓ | ✓ |
| `confirm` (default) | ✓ | ✓ | approval |
| `confirm-all` | ✓ | approval | approval |
| `readonly` | ✓ | ✓ | blocked |

The global level and the level of the session's system profile combine. The stricter one wins, so `"safety": "readonly"` on a production profile protects it even when the global level is `open`.

What counts as a save is decided on the live screen, without touching it: the Save button and Ctrl+S/F11, buttons, menu entries and ALV toolbar entries whose text, tooltip or icon means save/post/release/delete (German and English), answers to popups about saving or discarding data, raw OK-codes other than `/n…` and `/o…`, and `sap_script`. If the screen cannot be read, the call counts as a save. For a hard guarantee, use the server switch `sapgui/user_scripting_set_readonly`.

## Tools

All tools belong to the `sapgui` toolset.

| Tool | What it does |
|---|---|
| `sap_status` | Backend, SAP GUI version, connections and sessions, bound session, safety level. |
| `sap_doctor` | Step-by-step diagnosis with fixes. |
| `sap_start` | Start SAP Logon (Windows) or SAP GUI for Java with the bridge. |
| `sap_systems` | List system profiles (never passwords). |
| `sap_setup_system` | Add, change or remove a system profile. |
| `sap_login` | Log on with a profile: client, user, password reference, language, multiple-logon and system-message popups. |
| `sap_sessions` | List, bind, create, close sessions; log off. |
| `sap_transaction` | Start a transaction (`/n`, or `/o` in a new session) or send a raw OK-code. |
| `sap_screen` | Read the screen: header, status bar, popup, every element with id, label, value and state. |
| `sap_set` | Fill text fields, checkboxes, radio buttons, combo boxes, tabs, table-control cells; optional Enter. |
| `sap_press` | Press buttons, select tabs, double-click list lines/hotspots, F4 help. |
| `sap_key` | Send Enter, F1–F12, Shift/Ctrl combinations, PageUp/Down. |
| `sap_menu` | Select a menu bar entry by its path, or list the menu. |
| `sap_popup` | Read or answer the open popup. |
| `sap_table` | Read ALV grids (paged, scrolled so every row renders), table controls, trees, text editors, classic lists. |
| `sap_table_action` | Select rows, click/double-click cells, ALV toolbar and context menus, edit cells, tree nodes. |
| `sap_screenshot` | Screenshot of the SAP window as an image. |
| `sap_script` | Run a JavaScript snippet against the scripting API (always gated). |

Commands: `/sap <task>`, `/sap-doctor`, `/sap-start [windows|java]`.

Skills: `sapgui:sapgui` (how to drive SAP safely) and `sapgui:sapgui-troubleshooting`.

### Error codes

Every failing call returns `{"error", "code", "hint"}`. The codes are stable:
`NOT_FOUND`, `AMBIGUOUS`, `READ_ONLY`, `POPUP_OPEN`, `NO_POPUP`, `NOT_ALLOWED`, `BAD_REQUEST`, `NO_SESSION`, `SESSION_NOT_FOUND`, `SAPGUI_UNAVAILABLE`, `NOT_RUNNING`, `SCRIPTING_DISABLED`, `WSH_DISABLED`, `TIMEOUT`, `BUSY`, `LOGON_FAILED`, `LOGON_CANCELLED`, `PASSWORD_CHANGE_REQUIRED`, `CONNECT_FAILED`, `NO_SYSTEM`, `SECRET_UNAVAILABLE`, `PLAINTEXT_PASSWORD`, `LAUNCHER_NOT_FOUND`, `LAUNCH_FAILED`, `LAUNCH_TIMEOUT`, `AUTH_FAILED`, `BRIDGE_VERSION`, `SAP_ERROR`.

## Limits

- The agent works with the SAP user's authorizations, in the user's SAP GUI. It is not an unattended RPA runtime.
- SAP GUI for Java: only the SAP GUI started with `sap_start` is visible. Screenshots use Java's screen capture and on macOS need *Screen Recording* permission for SAP GUI.
- SAP GUI for HTML / Fiori are not covered, and neither is the ABAP debugger.
- The SAP GUI for Java scripting engine is less documented than the Windows one. [TESTING.md](TESTING.md) is the checklist for verifying a new SAP GUI release.

## Development

```bash
pip install pytest pyyaml
python -m pytest tests                                    # the plugin (needs node; Java tests need java + RHINO_JAR)
npm i --no-save acorn && node --test core/test/*.test.mjs  # the shared bridge
```

The tests run the real bridge against a mock of the SAP GUI object model. For the Windows backend, `cscript.exe` is replaced by an imitation of Windows Script Host. For the Java backend, SAP GUI for Java is replaced by Rhino, its embedded JavaScript engine, reached over the real socket protocol. `RHINO_JAR` points to a Rhino 1.7.x jar ([releases](https://github.com/mozilla/rhino/releases)).

`core/` is shared with pi-sapgui. After changing it, run `python3 scripts/sync-core.py ../pi-sapgui` and commit both repositories. The test suites check `core/CHECKSUMS`.

## License

MIT
