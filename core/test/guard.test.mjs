// The bridge op "guard" decides what a tool call would do (read / navigate /
// input / commit). The adapters only map that category onto the safety level,
// so every safety decision is tested here once for both of them.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { bridge } from "./harness.mjs";

function guard(b, tool, args = {}) {
  return b.ok("guard", { tool, args });
}

describe("guard: static classification", () => {
  const b = bridge();
  const cases = [
    ["sap_screen", {}, "read"],
    ["sap_table", { id: "x" }, "read"],
    ["sap_screenshot", {}, "read"],
    ["sap_sessions", { action: "list" }, "read"],
    ["sap_sessions", { action: "create" }, "navigate"],
    ["sap_sessions", { action: "close" }, "commit"],
    ["sap_sessions", { action: "logoff" }, "commit"],
    ["sap_transaction", { tcode: "MM03" }, "navigate"],
    ["sap_transaction", { command: "/nMM03" }, "navigate"],
    ["sap_transaction", { command: "/oSE16N" }, "navigate"],
    ["sap_transaction", { command: "/n" }, "navigate"],
    ["sap_transaction", { command: "/nend" }, "commit"],
    ["sap_transaction", { command: "/nex" }, "commit"],
    ["sap_transaction", { command: "=SAVE" }, "commit"],
    ["sap_transaction", { command: "BU" }, "commit"],
    ["sap_set", { fields: [{ id: "usr/txtA", value: 1 }] }, "input"],
    ["sap_set", { fields: [{ id: "wnd[0]/tbar[0]/okcd", value: "=SAVE" }] }, "commit"],
    ["sap_script", { code: "1" }, "commit"],
    ["sap_login", { system: "DEV" }, "navigate"],
  ];
  for (const [tool, args, expected] of cases) {
    test(`${tool} ${JSON.stringify(args)} -> ${expected}`, () => {
      assert.equal(guard(b, tool, args).category, expected);
    });
  }
});

describe("guard: actions that depend on the screen", () => {
  test("save button, save key, post button, harmless button", () => {
    const b = bridge();
    b.ok("transaction", { tcode: "MM02" });
    assert.equal(guard(b, "sap_press", { id: "tbar[0]/btn[11]" }).category, "commit");
    assert.equal(guard(b, "sap_press", { label: "Post" }).category, "commit");
    assert.equal(guard(b, "sap_press", { id: "wnd[0]/tbar[1]/btn[21]" }).category, "navigate");
    assert.equal(guard(b, "sap_press", { id: "tbar[0]/btn[3]" }).category, "navigate");
    assert.equal(guard(b, "sap_key", { key: "Ctrl+S" }).category, "commit");
    assert.equal(guard(b, "sap_key", { key: "F11" }).category, "commit");
    assert.equal(guard(b, "sap_key", { key: "Enter" }).category, "navigate");
    assert.equal(guard(b, "sap_key", { key: "F3" }).category, "navigate");
    assert.equal(guard(b, "sap_menu", { path: ["Edit", "Save"] }).category, "commit");
    assert.equal(guard(b, "sap_menu", { path: "Edit > Select All" }).category, "navigate");
    assert.equal(guard(b, "sap_menu", {}).category, "read");
  });

  test("description names the target, the system and the reason", () => {
    const b = bridge();
    b.ok("transaction", { tcode: "MM02" });
    const g = guard(b, "sap_press", { label: "Post" });
    assert.equal(g.description, 'Press "Post" (wnd[0]/tbar[1]/btn[20]) in DEV/100 (MM02) -- presses "Post"');
    assert.deepEqual(JSON.parse(JSON.stringify(g.system)), { sid: "DEV", client: "100", user: "TESTER", transaction: "MM02", session: "/app/con[0]/ses[0]" });
  });

  test("popups about saving: yes is a commit, no and cancel are not", () => {
    const b = bridge({ savePopup: true });
    b.ok("transaction", { tcode: "MM02" });
    b.ok("key", { key: "F11" });
    assert.equal(guard(b, "sap_popup", { action: "read" }).category, "read");
    assert.equal(guard(b, "sap_popup", { action: "confirm" }).category, "commit");
    assert.equal(guard(b, "sap_popup", { action: "press", button: "Yes" }).category, "commit");
    assert.equal(guard(b, "sap_popup", { action: "press", button: "No" }).category, "navigate");
    assert.equal(guard(b, "sap_popup", { action: "cancel" }).category, "navigate");
    assert.equal(guard(b, "sap_press", { id: "wnd[1]/usr/btnSPOP-OPTION1" }).category, "commit");
    assert.equal(guard(b, "sap_press", { id: "wnd[1]/usr/btnSPOP-OPTION_CAN" }).category, "navigate");
    assert.equal(guard(b, "sap_key", { key: "Enter", window: 1 }).category, "commit");
  });

  test("informational popups are navigation", () => {
    const b = bridge();
    b.ok("transaction", { tcode: "MM02" });
    b.ok("press", { label: "Details" });
    assert.equal(guard(b, "sap_popup", { action: "confirm" }).category, "navigate");
    assert.equal(guard(b, "sap_key", { key: "Enter" }).category, "navigate");
  });

  test("grid toolbar and menu items", () => {
    const b = bridge();
    b.ok("transaction", { tcode: "SE16N" });
    assert.equal(guard(b, "sap_table_action", { action: "pressToolbar", button: "&DELETE_ROW" }).category, "commit");
    assert.equal(guard(b, "sap_table_action", { action: "pressToolbar", button: "&SORT_ASC" }).category, "navigate");
    assert.equal(guard(b, "sap_table_action", { action: "setCell", row: 1, column: "MAKTX", value: "x" }).category, "input");
    assert.equal(guard(b, "sap_table_action", { action: "doubleClick", row: 1 }).category, "navigate");
  });

  test("without a session, screen-dependent actions fail closed", () => {
    const b = bridge({ loggedOn: false });
    const g = guard(b, "sap_press", { id: "tbar[0]/btn[0]" });
    assert.equal(g.category, "commit");
    assert.equal(g.system, null);
  });

  test("guard never changes the screen", () => {
    const b = bridge({ savePopup: true });
    b.ok("transaction", { tcode: "MM02" });
    const before = b.app._actions.length;
    guard(b, "sap_press", { label: "Post" });
    guard(b, "sap_menu", { path: "Edit > Save" });
    guard(b, "sap_key", { key: "F11" });
    assert.equal(b.app._actions.length, before);
  });
});
