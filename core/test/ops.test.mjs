import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { bridge } from "./harness.mjs";

describe("protocol", () => {
  test("hello reports bridge and SAP GUI versions", () => {
    const b = bridge();
    const r = b.ok("hello");
    assert.equal(r.host, "windows");
    assert.equal(r.sapgui.major, "8");
    assert.equal(r.connections, 1);
  });

  test("unknown op and bad JSON give structured errors", () => {
    const b = bridge();
    assert.equal(b.call("nope").error.code, "UNKNOWN_OP");
    const bad = b.raw("{not json");
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, "BAD_REQUEST");
  });

  test("non-ASCII survives the round trip as escapes", () => {
    const b = bridge();
    b.ok("transaction", { tcode: "MM03" });
    const r = b.ok("set", { fields: [{ id: "wnd[0]/usr/ctxtRMMG1-MATNR", value: "Größe-ÄÖÜ €" }] });
    assert.equal(r.data.fields[0].value, "Größe-ÄÖÜ €");
    assert.match(r.text, /= "Größe-ÄÖÜ €"/, "display text keeps the characters, only the wire format escapes them");
  });

  test("encode/decode handle nested data", () => {
    const b = bridge();
    const s = b.ctx.SapBridge.encode({ a: [1, true, null, "x\"y\n"], b: { c: "ü" } });
    assert.deepEqual(JSON.parse(s), { a: [1, true, null, "x\"y\n"], b: { c: "ü" } });
    const back = JSON.parse(JSON.stringify(b.ctx.SapBridge.decode('{"a":[1,2.5e1,-3],"b":"\\u00fc","c":{}}')));
    assert.deepEqual(back, { a: [1, 25, -3], b: "ü", c: {} });
  });

  test("SAP GUI not running maps to SAPGUI_UNAVAILABLE with a hint", () => {
    const b = bridge({ noSapGui: true });
    const r = b.call("screen");
    assert.equal(r.error.code, "SAPGUI_UNAVAILABLE");
    assert.match(r.error.hint, /sap_start/);
  });
});

describe("sessions", () => {
  test("list, bind, create, close", () => {
    const b = bridge();
    const list = b.ok("sessions");
    assert.match(list.text, /DEV - Development/);
    assert.match(list.text, /\/app\/con\[0\]\/ses\[0\]\s+DEV\/100 TESTER/);
    assert.equal(b.ok("sessions", { action: "bind", session: "0/0" }).data.id, "/app/con[0]/ses[0]");
    const created = b.ok("sessions", { action: "create" });
    assert.equal(created.data.id, "/app/con[0]/ses[1]");
    b.ok("sessions", { action: "close", session: "/app/con[0]/ses[1]" });
    assert.equal(b.call("sessions", { action: "close", session: "/app/con[0]/ses[0]" }).error.code, "BAD_REQUEST");
    assert.equal(b.call("sessions", { action: "bind", session: "/app/con[0]/ses[7]" }).error.code, "SESSION_NOT_FOUND");
  });

  test("no session gives NO_SESSION", () => {
    const b = bridge({ loggedOn: false });
    assert.equal(b.call("screen").error.code, "NO_SESSION");
  });
});

describe("screen and fields", () => {
  test("transaction + screen lists labelled fields, buttons and state", () => {
    const b = bridge();
    const t = b.ok("transaction", { tcode: "mm03" });
    assert.equal(t.data.command, "/nMM03");
    assert.equal(t.data.state.transaction, "MM03");
    const s = b.ok("screen");
    assert.match(s.text, /DEV\/100 TESTER · MM03 · SAPLMGMM 0060 · "Display Material \(Initial Screen\)"/);
    assert.match(s.text, /\[input\] wnd\[0\]\/usr\/ctxtRMMG1-MATNR {2}Material = "" {2}\(F4, required\)/);
    assert.match(s.text, /\[check\] wnd\[0\]\/usr\/chkRMMG1-FLAG {2}Only basic data = off/);
    assert.match(s.text, /\[radio\] wnd\[0\]\/usr\/radOPT1 {2}Option A = selected/);
    assert.match(s.text, /\[combo\] wnd\[0\]\/usr\/cmbLANG {2}Language = "English" \(key "EN"\)/);
    assert.match(s.text, /\[button\] wnd\[0\]\/tbar\[1\]\/btn\[5\] {2}Select View\(s\)/);
    assert.doesNotMatch(s.text, /tbar\[0\]\/btn\[11\]/, "standard toolbar hidden by default");
    assert.doesNotMatch(s.text, /\[text\] Material/, "labels used for fields are not repeated");
    assert.match(b.ok("screen", { includeToolbar: true }).text, /tbar\[0\]\/btn\[11\] {2}Save \(Ctrl\+S\)/);
    const f = b.ok("screen", { filter: "option" });
    assert.match(f.text, /radOPT1/);
    assert.doesNotMatch(f.text, /ctxtRMMG1-MATNR/);
  });

  test("set by id and label, checkbox, radio, combo by text; enter navigates", () => {
    const b = bridge();
    b.ok("transaction", { tcode: "MM03" });
    const r = b.ok("set", { fields: [
      { label: "Only basic data", value: true },
      { id: "usr/radOPT2", value: true },
      { id: "wnd[0]/usr/cmbLANG", value: "German" },
      { label: "Material:", value: "4711" },
    ], enter: true });
    assert.match(r.text, /set wnd\[0\]\/usr\/chkRMMG1-FLAG = "on"/);
    assert.match(r.text, /set wnd\[0\]\/usr\/cmbLANG = "German"/);
    assert.match(r.text, /pressed Enter/);
    assert.equal(r.data.state.transaction, "MM02");
  });

  test("set reports the field that failed and how many were set", () => {
    const b = bridge();
    b.ok("transaction", { tcode: "MM03" });
    const r = b.call("set", { fields: [{ id: "usr/ctxtRMMG1-MATNR", value: "1" }, { id: "usr/txtNOPE", value: "x" }] });
    assert.equal(r.error.code, "NOT_FOUND");
    assert.match(r.error.message, /Field 2 \(usr\/txtNOPE\).*1 field\(s\) before it were set/);
    const c = b.call("set", { fields: [{ id: "usr/cmbLANG", value: "Klingon" }] });
    assert.match(c.error.message, /not an entry.*"DE"=German/);
  });

  test("read-only fields are refused", () => {
    const b = bridge();
    b.ok("transaction", { tcode: "MM02" });
    const r = b.call("set", { fields: [{ id: "usr/txtMARA-MATNR", value: "1" }] });
    assert.equal(r.error.code, "READ_ONLY");
    assert.match(b.ok("screen").text, /\[output\] wnd\[0\]\/usr\/txtMARA-MATNR {2}MARA-MATNR = "4711" {2}\(read-only\)/);
  });

  test("ambiguous and missing labels", () => {
    const b = bridge();
    b.ok("transaction", { tcode: "MM03" });
    assert.equal(b.call("set", { fields: [{ label: "Option", value: true }] }).error.code, "AMBIGUOUS");
    assert.equal(b.call("set", { fields: [{ label: "Nothing like it", value: 1 }] }).error.code, "NOT_FOUND");
  });

  test("status bar errors are shown", () => {
    const b = bridge();
    b.ok("transaction", { tcode: "MM03" });
    const r = b.ok("set", { fields: [{ id: "usr/ctxtRMMG1-MATNR", value: "999" }], enter: true });
    assert.match(r.text, /Status \[E\] Material 999 does not exist \(M3 305\)/);
    const t = b.ok("transaction", { tcode: "XX99" });
    assert.match(t.text, /SAP reported an error/);
  });

  test("tcode validation and raw commands", () => {
    const b = bridge();
    assert.equal(b.call("transaction", { tcode: "MM03; drop" }).error.code, "BAD_REQUEST");
    assert.equal(b.ok("transaction", { tcode: "/oSE16N" }).data.command, "/oSE16N");
    assert.equal(b.ok("transaction", { tcode: "SE16N", newSession: true }).data.command, "/oSE16N");
    assert.equal(b.ok("transaction", { command: "/nMM03" }).data.command, "/nMM03");
  });
});

describe("buttons, keys, menus, popups", () => {
  test("press by label opens a popup that blocks the main window", () => {
    const b = bridge();
    b.ok("transaction", { tcode: "MM02" });
    const r = b.ok("press", { label: "Details" });
    assert.match(r.text, /POPUP wnd\[1\] "Information" is open/);
    assert.match(r.text, /\| Details are not available/);
    assert.match(r.text, /Continue \(Enter\) = wnd\[1\]\/tbar\[0\]\/btn\[0\]/);
    const t = b.call("transaction", { tcode: "MM03" });
    assert.equal(t.error.code, "POPUP_OPEN");
    const f = b.call("set", { fields: [{ id: "wnd[0]/usr/txtNOPE", value: "1" }] });
    assert.match(f.error.hint, /popup \(wnd\[1\]\) is open/);
    const s = b.ok("screen");
    assert.match(s.text, /Elements of the popup wnd\[1\]/);
    const c = b.ok("popup", { action: "confirm" });
    assert.match(c.text, /pressed Continue/);
    assert.equal(c.data.state.popup, undefined);
  });

  test("save popup: read, answer with a button", () => {
    const b = bridge({ savePopup: true });
    b.ok("transaction", { tcode: "MM02" });
    const k = b.ok("key", { key: "Ctrl+S" });
    assert.equal(k.data.vkey, 11);
    assert.match(k.text, /POPUP wnd\[1\] "Save Changes"/);
    const p = b.ok("popup");
    assert.equal(p.data.buttons.length, 3);
    const y = b.ok("popup", { action: "press", button: "yes" });
    assert.match(y.text, /Status \[S\] Material 4711 changed/);
  });

  test("popup cancel prefers the cancel button", () => {
    const b = bridge({ savePopup: true });
    b.ok("transaction", { tcode: "MM02" });
    b.ok("press", { id: "tbar[0]/btn[11]" });
    const c = b.ok("popup", { action: "cancel" });
    assert.match(c.text, /pressed Cancel/);
    assert.equal(b.call("popup", { action: "cancel" }).error.code, "NO_POPUP");
  });

  test("keys: names, numbers, unknown", () => {
    const b = bridge();
    assert.equal(b.ok("key", { key: "F3" }).data.vkey, 3);
    assert.equal(b.ok("key", { key: "shift + f3" }).data.vkey, 15);
    assert.equal(b.ok("key", { key: "Strg+F1" }).data.vkey, 25);
    assert.equal(b.ok("key", { key: 82 }).data.vkey, 82);
    assert.equal(b.call("key", { key: "Hyper+Z" }).error.code, "BAD_REQUEST");
    assert.equal(b.call("key", { key: 99 }).error.code, "NOT_ALLOWED");
  });

  test("menu: list and select by path", () => {
    const b = bridge();
    b.ok("transaction", { tcode: "MM02" });
    assert.match(b.ok("menu").text, /Edit\n {2}Select All\n {2}Save\nSystem/);
    const r = b.ok("menu", { path: "Edit > Select All" });
    assert.match(r.text, /selected menu Edit > Select All/);
    assert.match(b.call("menu", { path: ["Edit", "Frobnicate"] }).error.message, /Available: Select All, Save/);
  });
});

describe("tables", () => {
  test("ALV grid reads rendered rows only, pages and lists the toolbar", () => {
    const b = bridge();
    b.ok("transaction", { tcode: "SE16N" });
    const s = b.ok("screen");
    assert.match(s.text, /\[grid\] wnd\[0\]\/usr\/cntlRESULT_LIST\/shellcont\/shell {2}ALV grid "MARA": 250 rows x 3 columns/);
    const t = b.ok("table", { maxRows: 50 });
    assert.equal(t.data.rows.length, 50);
    assert.equal(t.data.rows[45][0], "MAT-0045", "off-screen rows must be scrolled into view");
    assert.equal(t.data.nextStartRow, 50);
    assert.deepEqual(t.data.columns.map((c) => c.title), ["Material", "Description", "Material Type"]);
    assert.match(t.text, /# \| Material \(MATNR\) \| Description \(MAKTX\) \| Material Type \(MTART\)/);
    assert.match(t.text, /toolbar: Export=&MB_EXPORT\(Menu\); Sort in Ascending Order=&SORT_ASC; Delete=&DELETE_ROW/);
    const last = b.ok("table", { startRow: 240, maxRows: 50, columns: "MATNR" });
    assert.equal(last.data.rows.length, 10);
    assert.equal(last.data.nextStartRow, undefined);
    assert.deepEqual(last.data.rows[9], ["MAT-0249"]);
    assert.equal(b.session().findById("wnd[0]/usr/cntlRESULT_LIST/shellcont/shell").firstVisibleRow, 0, "scroll restored");
  });

  test("grid actions: toolbar menu, double click, selection", () => {
    const b = bridge();
    b.ok("transaction", { tcode: "SE16N" });
    const m = b.ok("table_action", { action: "pressToolbar", button: "&MB_EXPORT" });
    assert.match(m.text, /menu items .*Spreadsheet...=&XXL; Local File...=&PC/);
    assert.ok(b.app._actions.includes("grid.pressToolbarContextButton &MB_EXPORT"));
    b.ok("table_action", { action: "selectMenuItem", item: "&XXL" });
    b.ok("table_action", { action: "selectRows", rows: "0,2-4" });
    assert.equal(b.session().findById("wnd[0]/usr/cntlRESULT_LIST/shellcont/shell").selectedRows, "0,2-4");
    const d = b.ok("table_action", { action: "doubleClick", row: 3, column: "MATNR" });
    assert.equal(d.data.state.transaction, "MM03");
  });

  test("table control: current page, scrolling, padding rows", () => {
    const b = bridge();
    b.ok("transaction", { tcode: "SM30" });
    const one = b.ok("table");
    assert.equal(one.data.rows.length, 10);
    assert.equal(one.data.nextStartRow, 10);
    assert.deepEqual(one.data.rows[0], ["K000", "Key text 0", "X"]);
    assert.equal(one.data.columns[0].name, "V_T001-KEY");
    const all = b.ok("table", { scroll: true, maxRows: 100 });
    assert.equal(all.data.rows.length, 25);
    assert.equal(all.data.dataEndsAt, 25);
    assert.match(all.text, /data ends at row 25/);
    const tbl = b.session().findById("wnd[0]/usr/tblSAPLSVIMTCTRL");
    assert.equal(tbl.verticalScrollbar.position, 0, "scroll position restored");
    const from = b.ok("table", { startRow: 20 });
    assert.equal(from.data.startRow, 20);
    assert.equal(from.data.rows.length, 5);
    b.ok("table_action", { action: "selectRow", row: 12 });
    assert.ok(b.app._actions.includes("table.getAbsoluteRow 12"));
  });

  test("tree read and expand", () => {
    const b = bridge();
    b.ok("transaction", { tcode: "ZTREE" });
    const t = b.ok("table");
    assert.match(t.text, /v Root {2}\[key N1\]\n {2}- Child A {2}\[key N2\]\n {2}> Child B {2}\[key N3\]/);
    b.ok("table_action", { action: "expand", node: "N3" });
    assert.ok(b.app._actions.includes("tree.expandNode N3"));
    assert.equal(b.call("table_action", { action: "expand" }).error.code, "BAD_REQUEST");
  });

  test("classic list output: on screen and over pages", () => {
    const b = bridge();
    b.ok("transaction", { tcode: "ZREP" });
    const s = b.ok("screen");
    assert.match(s.text, /List output \(10 cells/);
    assert.match(s.text, /\n {2}Doc 0000 {3}0\.00 EUR/);
    const l = b.ok("table", { kind: "list", pages: 5 });
    assert.equal(l.data.lines.length, 15);
    assert.equal(l.data.pages, 3);
    assert.match(l.data.lines[14], /^Doc 0014 +140.00 EUR$/);
  });

  test("double click on a list line", () => {
    const b = bridge();
    b.ok("transaction", { tcode: "ZREP" });
    b.ok("press", { id: "usr/lbl[1,2]", action: "doubleClick" });
    assert.ok(b.app._actions.includes("sendVKey 2 wnd[0]"));
  });
});

describe("login", () => {
  test("logs on with client, user, password and language", () => {
    const b = bridge({ loggedOn: false });
    const r = b.ok("login", { connection: "DEV - Development", client: "200", user: "PAT", password: "secret", language: "DE" });
    assert.equal(r.data.session, "/app/con[0]/ses[0]");
    assert.equal(r.data.info.user, "PAT");
    assert.equal(r.data.info.client, "200");
    assert.doesNotMatch(JSON.stringify(r), /secret/);
  });

  test("wrong password closes the connection and reports the status", () => {
    const b = bridge({ loggedOn: false });
    const r = b.call("login", { connection: "DEV", user: "PAT", password: "nope" });
    assert.equal(r.error.code, "LOGON_FAILED");
    assert.match(r.error.message, /Name or password is incorrect/);
    assert.equal(b.app.connections.length, 0);
  });

  test("multiple logon popup: continue without ending other logons", () => {
    const b = bridge({ loggedOn: false, multiLogon: true });
    const r = b.ok("login", { connectionString: "/H/sapdev/S/3200", user: "PAT", password: "secret" });
    assert.match(r.text, /continued without ending the others/);
    assert.ok(b.app._actions.includes("multilogon option 2"));
  });

  test("multiple logon: cancel", () => {
    const b = bridge({ loggedOn: false, multiLogon: true });
    assert.equal(b.call("login", { connection: "DEV", user: "PAT", password: "secret", multiLogon: "cancel" }).error.code, "LOGON_CANCELLED");
  });

  test("scripting disabled by server", () => {
    const b = bridge({ loggedOn: false, disabledByServer: true });
    assert.equal(b.call("login", { connection: "DEV", user: "PAT", password: "secret" }).error.code, "SCRIPTING_DISABLED");
  });
});

describe("screenshot and script", () => {
  test("hardCopy is used when available", () => {
    const b = bridge();
    const r = b.ok("screenshot", { path: "/tmp/x.png" });
    assert.equal(r.data.method, "hardCopy");
    assert.ok(b.app._actions.includes("hardCopy /tmp/x.png PNG"));
  });

  test("host fallback when hardCopy is missing", () => {
    const app = bridge().app;
    const w = app.findById("/app/con[0]/ses[0]").findById("wnd[0]");
    delete w.hardCopy;
    let geo = null;
    const b = bridge({ app, hostScreenshot: (p, g) => { geo = g; return p; } }, "java");
    const r = b.ok("screenshot", { path: "/tmp/y.png" });
    assert.equal(r.data.method, "host");
    assert.deepEqual(JSON.parse(JSON.stringify(geo)), { left: 10, top: 10, width: 800, height: 600 });
  });

  test("script runs with session and sap helpers", () => {
    const b = bridge();
    b.ok("transaction", { tcode: "MM02" });
    const r = b.ok("script", { code: 'sap.log("hi"); [session.info.transaction, sap.findById("usr/txtMAKT-MAKTX").text]' });
    assert.deepEqual(r.data.value, ["MM02", "Steel plate"]);
    assert.match(r.text, /log:\nhi/);
    assert.equal(b.call("script", { code: "throw new Error('boom')" }).error.message, "boom");
  });
});
