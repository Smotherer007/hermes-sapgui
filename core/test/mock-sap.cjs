/*
 * A small but faithful mock of the SAP GUI Scripting object model, used to
 * test ops.js without SAP. Written in plain ES5 so it loads in Node and in
 * Rhino (where it stands in for SAP GUI for Java's `application`).
 *
 * It models what the bridge relies on: findById with relative and absolute
 * ids, children collections (count/elementAt/item), session.info, the OK-code
 * field, status bar, popups as wnd[1], ALV grids that only render the rows in
 * their scroll window, table controls with padding rows, trees, list output,
 * the logon screen and the multiple-logon popup.
 */
function createMockSap(options) {
  options = options || {};
  var actions = [];
  function act(s) { actions.push(s); }
  function notFound() { var e = new Error("The control could not be found by id."); throw e; }

  function coll(items) {
    return {
      count: items.length, length: items.length,
      elementAt: function (i) { if (i < 0 || i >= items.length) { notFound(); } return items[i]; },
      item: function (i) { return this.elementAt(i); },
      _items: items
    };
  }
  function pad(n, w) { var s = String(n); while (s.length < w) { s = "0" + s; } return s; }

  var app = { type: "GuiApplication", id: "/app", majorVersion: 8, minorVersion: 10, patchlevel: 2, revision: 0, connections: [] };

  /* ---------------- screens ---------------- */

  function base(title) {
    return [
      { path: "mbar", type: "GuiMenubar" },
      { path: "mbar/menu[0]", type: "GuiMenu", text: "Edit" },
      { path: "mbar/menu[0]/menu[0]", type: "GuiMenu", text: "Select All", fcode: "SELALL" },
      { path: "mbar/menu[0]/menu[1]", type: "GuiMenu", text: "Save", fcode: "SAVE" },
      { path: "mbar/menu[1]", type: "GuiMenu", text: "System" },
      { path: "tbar[0]", type: "GuiToolbar" },
      { path: "tbar[0]/okcd", type: "GuiOkCodeField", text: "" },
      { path: "tbar[0]/btn[0]", type: "GuiButton", text: "", tooltip: "Enter" },
      { path: "tbar[0]/btn[11]", type: "GuiButton", text: "", tooltip: "Save (Ctrl+S)" },
      { path: "tbar[0]/btn[3]", type: "GuiButton", text: "", tooltip: "Back (F3)" },
      { path: "titl", type: "GuiTitlebar", text: title },
      { path: "tbar[1]", type: "GuiToolbar" },
      { path: "usr", type: "GuiUserArea" },
      { path: "sbar", type: "GuiStatusbar", text: "", messageType: "" }
    ];
  }

  var SCREENS = {
    logon: function () {
      return { title: "SAP", program: "SAPMSYST", screen: "20", tcode: "S000", els: base("SAP").concat([
        { path: "usr/lblRSYST-MANDT", type: "GuiLabel", text: "Client", left: 1, top: 1 },
        { path: "usr/txtRSYST-MANDT", type: "GuiTextField", text: "", changeable: true, left: 20, top: 1 },
        { path: "usr/lblRSYST-BNAME", type: "GuiLabel", text: "User", left: 1, top: 2 },
        { path: "usr/txtRSYST-BNAME", type: "GuiTextField", text: "", changeable: true, left: 20, top: 2 },
        { path: "usr/lblRSYST-BCODE", type: "GuiLabel", text: "Password", left: 1, top: 3 },
        { path: "usr/pwdRSYST-BCODE", type: "GuiPasswordField", text: "", changeable: true, left: 20, top: 3 },
        { path: "usr/lblRSYST-LANGU", type: "GuiLabel", text: "Logon Language", left: 1, top: 4 },
        { path: "usr/txtRSYST-LANGU", type: "GuiTextField", text: "", changeable: true, left: 20, top: 4 }
      ]) };
    },
    easy: function () {
      return { title: "SAP Easy Access", program: "SAPLSMTR_NAVIGATION", screen: "100", tcode: "SESSION_MANAGER", els: base("SAP Easy Access").concat([
        { path: "usr/lblX", type: "GuiLabel", text: "Welcome", left: 1, top: 1 }
      ]) };
    },
    mm03: function () {
      return { title: "Display Material (Initial Screen)", program: "SAPLMGMM", screen: "60", tcode: "MM03", els: base("Display Material (Initial Screen)").concat([
        { path: "tbar[1]/btn[5]", type: "GuiButton", text: "Select View(s)", tooltip: "Select View(s) (Enter)" },
        { path: "usr/lblRMMG1-MATNR", type: "GuiLabel", text: "Material", left: 1, top: 2 },
        { path: "usr/ctxtRMMG1-MATNR", type: "GuiCTextField", text: "", changeable: true, left: 25, top: 2, maxLength: 40, required: true },
        { path: "usr/chkRMMG1-FLAG", type: "GuiCheckBox", text: "Only basic data", selected: false, changeable: true, left: 1, top: 4 },
        { path: "usr/radOPT1", type: "GuiRadioButton", text: "Option A", selected: true, changeable: true, left: 1, top: 5 },
        { path: "usr/radOPT2", type: "GuiRadioButton", text: "Option B", selected: false, changeable: true, left: 20, top: 5 },
        { path: "usr/cmbLANG", type: "GuiComboBox", key: "EN", value: "English", changeable: true, left: 25, top: 6,
          entries: [{ key: "DE", value: "German" }, { key: "EN", value: "English" }] },
        { path: "usr/lblLANG", type: "GuiLabel", text: "Language", left: 1, top: 6 }
      ]) };
    },
    mm02: function () {
      return { title: "Change Material 4711", program: "SAPLMGMM", screen: "4004", tcode: "MM02", els: base("Change Material 4711").concat([
        { path: "usr/lblMAKT-MAKTX", type: "GuiLabel", text: "Description", left: 1, top: 2 },
        { path: "usr/txtMAKT-MAKTX", type: "GuiTextField", text: "Steel plate", changeable: true, left: 25, top: 2 },
        { path: "usr/txtMARA-MATNR", type: "GuiTextField", text: "4711", changeable: false, left: 25, top: 1 },
        { path: "tbar[1]/btn[20]", type: "GuiButton", text: "Post", tooltip: "Post document" },
        { path: "tbar[1]/btn[21]", type: "GuiButton", text: "Details", tooltip: "Show details" }
      ]) };
    },
    se16n: function () {
      return { title: "General Table Display", program: "SAPLSE16N", screen: "200", tcode: "SE16N", els: base("General Table Display").concat([
        { path: "usr/cntlRESULT_LIST", type: "GuiCustomControl" },
        { path: "usr/cntlRESULT_LIST/shellcont", type: "GuiContainerShell" },
        { path: "usr/cntlRESULT_LIST/shellcont/shell", type: "GuiShell", subType: "GridView", grid: true }
      ]) };
    },
    tc: function () {
      return { title: "Maintain Entries", program: "SAPLSVIM", screen: "100", tcode: "SM30", els: base("Maintain Entries").concat([
        { path: "usr/tblSAPLSVIMTCTRL", type: "GuiTableControl", table: true }
      ]) };
    },
    tree: function () {
      return { title: "Tree Screen", program: "SAPLTREE", screen: "100", tcode: "ZTREE", els: base("Tree Screen").concat([
        { path: "usr/cntlTREE/shellcont/shell", type: "GuiShell", subType: "Tree", tree: true }
      ]) };
    },
    list: function (page) {
      var els = base("Report Output");
      for (var i = 0; i < 5; i++) {
        var y = i + 1;
        els.push({ path: "usr/lbl[1," + y + "]", type: "GuiLabel", text: "Doc " + pad(page * 5 + i, 4), left: 1, top: y });
        els.push({ path: "usr/lbl[12," + y + "]", type: "GuiLabel", text: String((page * 5 + i) * 10) + ".00 EUR", left: 12, top: y });
      }
      return { title: "Report Output", program: "ZREPORT", screen: "120", tcode: "ZREP", els: els, listPage: page };
    }
  };

  function makeGrid(el) {
    var rows = options.gridRows || 250;
    var cols = ["MATNR", "MAKTX", "MTART"];
    var titles = { MATNR: "Material", MAKTX: "Description", MTART: "Material Type" };
    var g = el;
    g.rowCount = rows;
    g.columnCount = 3;
    g.visibleRowCount = 20;
    g.firstVisibleRow = 0;
    g.columnOrder = coll(cols);
    g.selectedRows = "";
    g.title = "MARA";
    g.getDisplayedColumnTitle = function (c) { return titles[c]; };
    g.getCellValue = function (r, c) {
      if (r < 0 || r >= rows) { throw new Error("row out of range"); }
      if (r < g.firstVisibleRow || r >= g.firstVisibleRow + g.visibleRowCount) { return pad(r, 10); }
      if (c === "MATNR") { return "MAT-" + pad(r, 4); }
      if (c === "MAKTX") { return "Material " + r; }
      return r % 2 ? "FERT" : "ROH";
    };
    var tb = [
      { id: "&MB_EXPORT", type: 2, text: "", tooltip: "Export" },
      { id: "&SORT_ASC", type: 0, text: "", tooltip: "Sort in Ascending Order" },
      { id: "", type: 3, text: "", tooltip: "" },
      { id: "&DELETE_ROW", type: 0, text: "Delete", tooltip: "Delete Row" }
    ];
    g.toolbarButtonCount = tb.length;
    g.getToolbarButtonId = function (i) { return tb[i].id; };
    g.getToolbarButtonType = function (i) { return tb[i].type; };
    g.getToolbarButtonText = function (i) { return tb[i].text; };
    g.getToolbarButtonTooltip = function (i) { return tb[i].tooltip; };
    g.getToolbarButtonEnabled = function () { return true; };
    g.pressToolbarButton = function (id) { act("grid.pressToolbarButton " + id); };
    g.pressToolbarContextButton = function (id) {
      act("grid.pressToolbarContextButton " + id);
      g.currentContextMenu = { children: coll([{ text: "Spreadsheet...", name: "&XXL" }, { text: "", name: "" }, { text: "Local File...", name: "&PC" }]) };
    };
    g.selectContextMenuItem = function (code) { act("grid.selectContextMenuItem " + code); };
    g.setCurrentCell = function (r, c) { g.currentCellRow = r; g.currentCellColumn = c; act("grid.setCurrentCell " + r + " " + c); };
    g.doubleClickCurrentCell = function () { act("grid.doubleClickCurrentCell"); g._session._nav("mm03"); };
    g.clickCurrentCell = function () { act("grid.clickCurrentCell"); };
    g.selectAll = function () { g.selectedRows = "0-" + (rows - 1); };
    g.clearSelection = function () { g.selectedRows = ""; };
    g.modifyCell = function (r, c, v) { act("grid.modifyCell " + r + " " + c + " " + v); };
    g.contextMenu = function () { g.currentContextMenu = { children: coll([{ text: "Details", name: "&DETAIL" }]) }; };
  }

  function makeTable(el) {
    var data = [];
    for (var i = 0; i < 25; i++) { data.push(["K" + pad(i, 3), "Key text " + i, i % 3 === 0]); }
    var t = el;
    t.rowCount = 30;
    t.visibleRowCount = 10;
    t.verticalScrollbar = { position: 0, minimum: 0, maximum: 29 };
    t.columns = coll([{ title: "Key" }, { title: "Text" }, { title: "Active" }]);
    var names = ["V_T001-KEY", "V_T001-TEXT", "V_T001-ACTIVE"];
    var types = ["GuiTextField", "GuiTextField", "GuiCheckBox"];
    t.getCell = function (v, c) {
      var abs = t.verticalScrollbar.position + v;
      var row = data[abs];
      var cell = { type: types[c], name: names[c], id: t.id + "/" + (types[c] === "GuiCheckBox" ? "chk" : "txt") + names[c] + "[" + c + "," + v + "]", changeable: true };
      if (types[c] === "GuiCheckBox") { cell.selected = row ? row[c] : false; }
      else { cell.text = row ? row[c] : ""; }
      cell.setFocus = function () { act("cell.setFocus " + abs + "," + c); };
      return cell;
    };
    t.getAbsoluteRow = function (r) { var o = { selected: false }; act("table.getAbsoluteRow " + r); return o; };
  }

  function makeTree(el) {
    var nodes = [
      { key: "N1", text: "Root", level: 0, folder: true, expanded: true },
      { key: "N2", text: "Child A", level: 1, folder: false },
      { key: "N3", text: "Child B", level: 1, folder: true, expanded: false }
    ];
    var t = el;
    var map = {};
    for (var i = 0; i < nodes.length; i++) { map[nodes[i].key] = nodes[i]; }
    t.getAllNodeKeys = function () { var k = []; for (var j = 0; j < nodes.length; j++) { k.push(nodes[j].key); } return coll(k); };
    t.getNodeTextByKey = function (k) { return map[k].text; };
    t.getHierarchyLevel = function (k) { return map[k].level; };
    t.isFolder = function (k) { return map[k].folder; };
    t.isFolderExpanded = function (k) { return !!map[k].expanded; };
    t.expandNode = function (k) { map[k].expanded = true; act("tree.expandNode " + k); };
    t.selectNode = function (k) { act("tree.selectNode " + k); };
    t.doubleClickNode = function (k) { act("tree.doubleClickNode " + k); };
  }

  /* ---------------- windows & sessions ---------------- */

  function buildWindow(session, index, spec, modal) {
    var prefix = session.id + "/wnd[" + index + "]";
    var wnd = { type: modal ? "GuiModalWindow" : "GuiMainWindow", id: prefix, text: spec.title, _els: {}, _order: [],
      left: 10, top: 10, width: 800, height: 600, screenLeft: 10, screenTop: 10 };
    wnd.children = null;
    var all = {};
    function ensure(path) {
      if (all[path]) { return all[path]; }
      var seg = path.lastIndexOf("/") >= 0 ? path.substring(path.lastIndexOf("/") + 1) : path;
      var guess = /^usr$/.test(seg) ? "GuiUserArea" : (/^tbar/.test(seg) ? "GuiToolbar" : "GuiSimpleContainer");
      return add({ path: path, type: guess });
    }
    function add(e) {
      var el = {};
      for (var k in e) { if (Object.prototype.hasOwnProperty.call(e, k) && k !== "path" && k !== "entries") { el[k] = e[k]; } }
      el.id = prefix + "/" + e.path;
      el.name = e.name || (e.path.substring(e.path.lastIndexOf("/") + 1).replace(/^(ctxt|txt|pwd|chk|rad|cmb|lbl|btn|tbl|tabp|tabs)/, ""));
      el._kids = [];
      el._session = session;
      all[e.path] = el;
      var parentPath = e.path.lastIndexOf("/") >= 0 ? e.path.substring(0, e.path.lastIndexOf("/")) : "";
      var parent = parentPath ? ensure(parentPath) : wnd;
      (parent === wnd ? wnd._order : parent._kids).push(el);
      el.parent = parent;
      el.setFocus = function () { act("setFocus " + e.path); session._focus = el; };
      if (e.entries) {
        el.entries = coll(e.entries);
        var currentKey = e.key;
        Object.defineProperty(el, "key", {
          get: function () { return currentKey; },
          set: function (k) {
            for (var q = 0; q < e.entries.length; q++) { if (e.entries[q].key === k) { currentKey = k; el.value = e.entries[q].value; return; } }
            throw new Error("Invalid key " + k);
          }
        });
      }
      if (e.type === "GuiButton") {
        el.changeable = e.changeable === undefined ? true : e.changeable;
        el.press = function () { act("press " + e.path); session._onPress(index, e.path); };
      }
      if (e.type === "GuiRadioButton") { el.select = function () { act("select " + e.path); var k2; for (k2 in all) { if (all[k2].type === "GuiRadioButton") { all[k2].selected = false; } } el.selected = true; }; }
      if (e.type === "GuiTab" || e.type === "GuiMenu") { el.select = function () { act("select " + e.path); session._onMenu(e); }; }
      if (e.grid) { makeGrid(el); }
      if (e.table) { makeTable(el); }
      if (e.tree) { makeTree(el); }
      return el;
    }
    for (var i = 0; i < spec.els.length; i++) { add(spec.els[i]); }
    for (var p in all) {
      if (Object.prototype.hasOwnProperty.call(all, p)) { (function (el) { el.children = coll(el._kids); })(all[p]); }
    }
    wnd.children = coll(wnd._order);
    wnd._all = all;
    wnd.sendVKey = function (vk) { act("sendVKey " + vk + " wnd[" + index + "]"); session._onKey(index, vk); };
    wnd.isVKeyAllowed = function (vk) { return vk !== 99; };
    wnd.hardCopy = function (path, fmt) { act("hardCopy " + path + " " + fmt); if (options.onHardCopy) { options.onHardCopy(path); } return path; };
    return wnd;
  }

  function createSession(conn, index, screenName) {
    var s = { type: "GuiSession", id: conn.id + "/ses[" + index + "]", busy: false, parent: conn, _windows: [], _history: [] };
    s.info = { systemName: options.sid || "DEV", client: "", user: "", language: "", transaction: "", program: "", screenNumber: "",
      sessionNumber: index + 1, systemNumber: "00", applicationServer: "sapdev", scriptingModeReadOnly: false };
    s._nav = function (name, arg) {
      if (s._screen && name !== s._screenName) { s._history.push(s._screenName); }
      s._screenName = name;
      s._screen = SCREENS[name](arg || 0);
      s._windows = [buildWindow(s, 0, s._screen, false)];
      s.info.transaction = s._screen.tcode;
      s.info.program = s._screen.program;
      s.info.screenNumber = s._screen.screen;
    };
    s._popup = function (spec) { s._windows.push(buildWindow(s, s._windows.length, spec, true)); };
    s._closePopup = function () { s._windows.pop(); };
    s._status = function (type, text) {
      var sb = s._windows[0]._all["sbar"];
      sb.text = text; sb.messageType = type; sb.messageId = type ? "M3" : ""; sb.messageNumber = type ? "305" : "";
    };
    s.findById = function (rel) {
      var r = String(rel);
      var abs = /^\/app\/con\[\d+\]\/ses\[\d+\]\/(.*)$/.exec(r);
      if (abs) { r = abs[1]; }
      var m = /^wnd\[(\d+)\](?:\/(.*))?$/.exec(r);
      if (!m) { notFound(); }
      var w = s._windows[Number(m[1])];
      if (!w) { notFound(); }
      if (!m[2]) { return w; }
      var el = w._all[m[2]];
      if (!el) { notFound(); }
      return el;
    };
    s.createSession = function () { act("createSession"); var ns = createSession(conn, conn._sessions.length, "easy"); ns.info.user = s.info.user; ns.info.client = s.info.client; conn._sessions.push(ns); conn.children = coll(conn._sessions); };
    s._onKey = function (w, vk) {
      if (w > 0) {
        var pop = s._windows[w];
        if (pop._kind === "multi") {
          var opt = pop._all["usr/radMULTI_LOGON_OPT2"].selected ? 2 : (pop._all["usr/radMULTI_LOGON_OPT1"].selected ? 1 : 3);
          act("multilogon option " + opt);
          s._closePopup();
          if (opt === 3) { s._nav("logon"); } else { s._nav("easy"); }
          return;
        }
        if (vk === 12) { s._closePopup(); return; }
        if (vk === 0 && pop._kind === "info") { s._closePopup(); return; }
        if (vk === 0 && pop._kind === "save") { s._closePopup(); s._status("S", "Material 4711 changed"); return; }
        return;
      }
      if (vk === 0) {
        var okcd = s._windows[0]._all["tbar[0]/okcd"];
        var cmd = okcd.text;
        okcd.text = "";
        if (cmd) { s._command(cmd); return; }
        if (s._screenName === "logon") { s._logon(); return; }
        if (s._screenName === "mm03") {
          var mat = s._windows[0]._all["usr/ctxtRMMG1-MATNR"].text;
          if (mat === "4711") { s._nav("mm02"); } else { s._status("E", "Material " + mat + " does not exist"); }
        }
        return;
      }
      if (vk === 3 || vk === 15) { var prev = s._history.pop() || "easy"; s._screenName = null; s._nav(prev); s._history.pop(); return; }
      if (vk === 11) { s._save(); return; }
      if (vk === 82 && s._screenName === "list") { var pg = s._screen.listPage; if (pg < 2) { s._screenName = null; s._nav("list", pg + 1); } return; }
    };
    s._save = function () {
      if (s._screenName === "mm02") {
        if (options.savePopup) {
          s._popup({ title: "Save Changes", els: [
            { path: "usr", type: "GuiUserArea" },
            { path: "usr/txtSPOP-TEXTLINE1", type: "GuiTextField", text: "Do you want to save the changes?", changeable: false },
            { path: "usr/btnSPOP-OPTION1", type: "GuiButton", text: "Yes" },
            { path: "usr/btnSPOP-OPTION2", type: "GuiButton", text: "No" },
            { path: "usr/btnSPOP-OPTION_CAN", type: "GuiButton", text: "Cancel" }
          ] });
          s._windows[1]._kind = "save";
        } else { s._status("S", "Material 4711 changed"); }
      }
    };
    s._onPress = function (w, path) {
      if (w > 0) {
        var pop = s._windows[w];
        if (pop._kind === "save") {
          s._closePopup();
          if (path === "usr/btnSPOP-OPTION1") { s._status("S", "Material 4711 changed"); }
        } else { s._closePopup(); }
        return;
      }
      if (path === "tbar[0]/btn[11]") { s._save(); return; }
      if (path === "tbar[0]/btn[3]") { s._onKey(0, 3); return; }
      if (path === "tbar[1]/btn[5]") { s._onKey(0, 0); return; }
      if (path === "tbar[1]/btn[21]") {
        s._popup({ title: "Information", els: [
          { path: "usr", type: "GuiUserArea" },
          { path: "usr/txtMESSTXT1", type: "GuiTextField", text: "Details are not available", changeable: false },
          { path: "tbar[0]", type: "GuiToolbar" },
          { path: "tbar[0]/btn[0]", type: "GuiButton", text: "", tooltip: "Continue (Enter)" }
        ] });
        s._windows[1]._kind = "info";
      }
    };
    s._onMenu = function (e) { if (e.fcode === "SAVE") { s._save(); } };
    s._command = function (cmd) {
      var m = /^\/[nNoO](.*)$/.exec(cmd);
      var t = (m ? m[1] : cmd).toUpperCase();
      var map = { MM03: "mm03", MM02: "mm02", SE16N: "se16n", SM30: "tc", ZTREE: "tree", ZREP: "list", "": "easy" };
      if (Object.prototype.hasOwnProperty.call(map, t)) { s._nav(map[t]); s.info.transaction = t || "SESSION_MANAGER"; }
      else { s._status("E", "Transaction " + t + " does not exist"); }
    };
    s._logon = function () {
      var u = s._windows[0]._all;
      var pw = u["usr/pwdRSYST-BCODE"].text;
      if (pw !== (options.password || "secret")) { s._status("E", "Name or password is incorrect (repeat logon)"); return; }
      s.info.client = u["usr/txtRSYST-MANDT"].text || "100";
      s.info.user = u["usr/txtRSYST-BNAME"].text;
      s.info.language = u["usr/txtRSYST-LANGU"].text || "EN";
      s._nav("easy");
      if (options.multiLogon) {
        s._popup({ title: "License Information for Multiple Logons", els: [
          { path: "usr", type: "GuiUserArea" },
          { path: "usr/txtMULTI_LOGON_TEXT", type: "GuiTextField", text: "User is already logged on", changeable: false },
          { path: "usr/radMULTI_LOGON_OPT1", type: "GuiRadioButton", text: "Continue and end other logons", selected: false },
          { path: "usr/radMULTI_LOGON_OPT2", type: "GuiRadioButton", text: "Continue without ending", selected: false },
          { path: "usr/radMULTI_LOGON_OPT3", type: "GuiRadioButton", text: "Terminate this logon", selected: true }
        ] });
        s._windows[1]._kind = "multi";
      }
    };
    Object.defineProperty(s, "children", { get: function () { return coll(s._windows); } });
    s._nav(screenName || "easy");
    return s;
  }

  function createConnection(desc, screenName) {
    var index = app.connections.length;
    var conn = { type: "GuiConnection", id: "/app/con[" + index + "]", description: desc, connectionString: "/H/sapdev/S/3200",
      disabledByServer: !!options.disabledByServer, _sessions: [] };
    conn._sessions.push(createSession(conn, 0, screenName));
    conn.children = coll(conn._sessions);
    conn.closeSession = function (id) {
      act("closeSession " + id);
      var keep = [];
      for (var i = 0; i < conn._sessions.length; i++) { if (conn._sessions[i].id !== id) { keep.push(conn._sessions[i]); } }
      conn._sessions = keep;
      conn.children = coll(keep);
    };
    conn.closeConnection = function () {
      act("closeConnection " + conn.id);
      var keep = [];
      for (var i = 0; i < app.connections.length; i++) { if (app.connections[i] !== conn) { keep.push(app.connections[i]); } }
      app.connections = keep;
      app.children = coll(keep);
    };
    app.connections.push(conn);
    app.children = coll(app.connections);
    return conn;
  }

  app.children = coll([]);
  app.openConnection = function (desc) { act("openConnection " + desc); return createConnection(desc, "logon"); };
  app.openConnectionByConnectionString = function (cs) { act("openConnectionByConnectionString " + cs); return createConnection("", "logon"); };
  app.findById = function (id) {
    var m = /^\/app\/con\[(\d+)\](?:\/ses\[(\d+)\])?(?:\/(.*))?$/.exec(String(id));
    if (!m) { notFound(); }
    var c = app.connections[Number(m[1])];
    if (!c) { notFound(); }
    if (m[2] === undefined) { return c; }
    var s = c._sessions[Number(m[2])];
    if (!s) { notFound(); }
    return m[3] ? s.findById(m[3]) : s;
  };
  app._createConnection = createConnection;
  app._actions = actions;

  if (options.loggedOn !== false) {
    var c0 = createConnection("DEV - Development", "easy");
    c0._sessions[0].info.client = "100";
    c0._sessions[0].info.user = "TESTER";
    c0._sessions[0].info.language = "EN";
  }
  return app;
}

if (typeof module !== "undefined" && module.exports) { module.exports = { createMockSap: createMockSap }; }
