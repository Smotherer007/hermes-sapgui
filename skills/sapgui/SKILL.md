---
name: sapgui
description: "Drive SAP GUI (SAP GUI for Windows or SAP GUI for Java) with the sap_* tools: run transactions, read screens, fill selection screens, read ALV grids and lists, handle popups, and never save, post or delete unless the user clearly asked for it. Use for any task in an SAP system: look up a material, customer, order or table entry, run a report, check a job or a dump, or step through a transaction."
---

# Working in SAP GUI

You drive the real SAP GUI the user sees. Everything you do happens with the user's SAP authorizations, in the system they are logged on to. Work like a careful key user: look before you act, act in small steps, and check what SAP answered.

## Start of a task

1. `sap_status` tells you the backend, the open sessions and the safety level.
2. No session? If a system profile exists (`sap_systems`), log on with `sap_login system=<name>`. Otherwise ask the user to log on in SAP GUI, then use `sap_sessions`.
   - SAP GUI for Java (macOS/Linux): SAP GUI must have been started through `sap_start`; a SAP GUI started from the Dock has no bridge. `sap_start` opens a new SAP GUI window.
3. Several sessions? Bind the one for this task: `sap_sessions action=bind session=/app/con[0]/ses[1]`. Never work in a session the user is typing in; open your own with `sap_sessions action=create` or `sap_transaction newSession=true`.
4. Check the system and client in the header before changing anything. If it is a production system and the task changes data, say so and ask first.

## The loop

For every step:

1. **Read** – `sap_screen` (use `filter` on big screens). It shows the header (system, transaction, program and dynpro, title), the status bar, an open popup, and each element with its id.
2. **Act** – one of:
   - `sap_transaction tcode=MM03` to start a transaction (it always uses `/n`, so the current transaction is left).
   - `sap_set fields=[{id, value}, ...]` to fill fields; add `enter=true` to press Enter afterwards. Prefer ids from `sap_screen` over labels.
   - `sap_press id=...` for buttons, tabs, radio buttons; `action=doubleClick` to drill into a list line or hotspot; `action=f4` for value help.
   - `sap_key key=F8` (execute), `F3` (back), `F12` (cancel), `Enter`, `PageDown`.
   - `sap_menu path=["Edit", "Select All"]` for menu bar entries (`sap_menu` without path lists them).
   - `sap_table` / `sap_table_action` for ALV grids, table controls, trees and list output.
3. **Check** – every action returns the new header, the status bar and any popup. Read it:
   - `Status [E]` is an error: fix the input, do not repeat the same action.
   - `Status [W]` is a warning: SAP usually wants Enter to continue; decide whether that is right.
   - `POPUP ... is open`: handle it with `sap_popup` before anything else; the main window is blocked.

## Reading data

- ALV grids: `sap_table` reads in pages (`startRow`, `maxRows`, at most 1000 rows per call) and scrolls so every row is rendered. Use `columns` to read only what you need. The answer ends with the next `startRow` if there is more.
- Big results: restrict them in SAP first (selection screen, maximum number of hits) instead of reading thousands of rows.
- Table controls (classic step-loop tables): `sap_table` reads the visible page; `scroll=true` reads further. Rows after `data ends at row` are empty padding.
- Classic reports (WRITE lists): `sap_table kind=list pages=3`.
- Trees: `sap_table` lists node keys; `sap_table_action action=expand node=<key>` opens a folder.
- `sap_screenshot` only when you need to see the layout or the user wants a picture; values come from `sap_screen`.

## Changing data

- Only save, post, release or delete when the user asked for exactly that. Filling a screen is fine; the save is the step that needs intent.
- Before saving, read the screen once more and tell the user what will be saved (values, document, system).
- Saving actions (Save button, Ctrl+S/F11, Post/Buchen, Delete, "Yes" in a save popup, raw OK-codes, `sap_script`) pass the safety gate: depending on the setting the user is asked, or the call is blocked. A blocked call is not an error to work around – tell the user.
- After a save, read the status bar and report the document number or message SAP gave.

## Popups

- `sap_popup` reads the popup: title, text and buttons with their ids.
- `action=confirm` (Yes/OK/Continue), `action=cancel` (No/Cancel/F12), `action=press button="<text or id>"`.
- "Data will be lost" / "Save changes?" popups decide about the user's data: answer them only in line with what the user asked.

## Errors from the tools

- `NOT_FOUND`: the id is not on the current screen (screen changed, popup open). Read the screen again.
- `POPUP_OPEN`: handle the popup first.
- `READ_ONLY`: the field is display-only – switch to change mode or pick the right transaction.
- `AMBIGUOUS`: use the id instead of the label.
- `TIMEOUT`: SAP did not answer (long report, a dialog only the user can see). Read the screen; ask the user if it stays busy.
- `SAPGUI_UNAVAILABLE`, `NOT_RUNNING`, `SCRIPTING_DISABLED`, `WSH_DISABLED`: read the sapgui-troubleshooting skill.

## Useful transactions

SE16N / SE16H (table contents), SE11 (dictionary), MM03 (material), XD03 / BP (customer, business partner), VA03 (sales order), ME23N (purchase order), FB03 (accounting document), SM37 (jobs), ST22 (dumps), SLG1 (application log), SU01D (user, display), SE38 / SA38 (run a report). Prefer the display transactions (…03) unless a change is asked for.

## Escape hatch

`sap_script` runs JavaScript against the SAP GUI scripting API (`session`, `application`, `sap.findById`). Use it only when no tool fits, keep it short, and expect an approval prompt.
