/*
 * sapgui-bridge core: operations that run INSIDE the SAP GUI scripting engine.
 *
 * The same file runs on two engines:
 *   - Windows Script Host (JScript, ES3) driving SAP GUI for Windows over COM
 *   - the JavaScript engine embedded in SAP GUI for Java (Rhino) on macOS/Linux
 *
 * Rules that keep it portable (checked by core/test/es3.test.mjs):
 *   - ECMAScript 3 only: var, function, no trailing commas, no getters
 *   - no Array.prototype.forEach/map/filter/indexOf, no String.prototype.trim,
 *     no Object.keys, no Date.now -- use the helpers below
 *   - never use a reserved word as a property name with dot notation
 *   - every access to a SAP object goes through prop()/call guards, because a
 *     missing member throws on COM and returns undefined on Java
 *
 * A host file (host-windows.js / host-java.js) defines HOST before calling
 * SapBridge.init(HOST) and feeds request lines to SapBridge.handleLine().
 *
 * Protocol: one JSON object per line.
 *   request  {"id": 1, "op": "screen", "args": {...}}
 *   response {"id": 1, "ok": true, "result": {...}}
 *            {"id": 1, "ok": false, "error": {"code": "...", "message": "...", "hint": "..."}}
 * All output is pure ASCII (non-ASCII is \\u-escaped), so code pages never matter.
 */

var SapBridge = (function () {
  var VERSION = "0.1.0";
  var PROTOCOL = 1;
  var HOST = null;

  /* ------------------------------------------------------------------ */
  /* small ES3 helpers                                                   */
  /* ------------------------------------------------------------------ */

  function isArray(v) { return Object.prototype.toString.call(v) === "[object Array]"; }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isNil(v) { return v === null || v === undefined; }
  function str(v) {
    if (isNil(v)) { return ""; }
    try { return String(v); } catch (e) { return ""; }
  }
  function trim(s) { return str(s).replace(/^\s+|\s+$/g, ""); }
  function lower(s) { return str(s).toLowerCase(); }
  function num(v, dflt) {
    if (isNil(v)) { return dflt; }
    var n = Number(str(v));
    return isNaN(n) ? dflt : n;
  }
  function bool(v) {
    if (v === true) { return true; }
    if (v === false || isNil(v)) { return false; }
    var s = lower(v);
    return s === "true" || s === "1" || s === "-1" || s === "yes";
  }
  function indexOf(arr, v) {
    for (var i = 0; i < arr.length; i++) { if (arr[i] === v) { return i; } }
    return -1;
  }
  function startsWith(s, p) { return str(s).substring(0, p.length) === p; }
  function endsWith(s, p) { s = str(s); return p.length <= s.length && s.substring(s.length - p.length) === p; }
  function pad(s, n) { s = str(s); while (s.length < n) { s += " "; } return s; }
  function clip(s, n) { s = str(s); return s.length > n ? s.substring(0, n - 1) + "\u2026" : s; }
  function now() { return HOST && HOST.now ? HOST.now() : new Date().getTime(); }
  function sleep(ms) { if (HOST && HOST.sleep) { HOST.sleep(ms); } }

  /* ------------------------------------------------------------------ */
  /* JSON (ASCII-safe encoder, tolerant of COM / Java values; ES3 parser) */
  /* ------------------------------------------------------------------ */

  function quote(s) {
    s = str(s);
    var out = "\"";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var code = s.charCodeAt(i);
      if (c === "\"") { out += "\\\""; }
      else if (c === "\\") { out += "\\\\"; }
      else if (c === "\n") { out += "\\n"; }
      else if (c === "\r") { out += "\\r"; }
      else if (c === "\t") { out += "\\t"; }
      else if (code < 32 || code > 126) {
        var h = code.toString(16);
        while (h.length < 4) { h = "0" + h; }
        out += "\\u" + h;
      } else { out += c; }
    }
    return out + "\"";
  }

  /** Quote for display text: escapes quotes and line breaks, keeps every other character. */
  function dq(s) {
    return "\"" + str(s).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\r?\n/g, "\\n").replace(/\t/g, " ") + "\"";
  }

  function encode(v, depth) {
    depth = depth || 0;
    if (depth > 40) { return "null"; }
    if (isNil(v)) { return "null"; }
    var t = typeof v;
    if (t === "boolean") { return v ? "true" : "false"; }
    if (t === "number") { return isFinite(v) ? String(v) : "null"; }
    if (t === "string") { return quote(v); }
    if (t === "function" || t === "unknown") { return "null"; }
    if (isArray(v)) {
      var parts = [];
      for (var i = 0; i < v.length; i++) { parts.push(encode(v[i], depth + 1)); }
      return "[" + parts.join(",") + "]";
    }
    var tag = Object.prototype.toString.call(v);
    if (tag === "[object Object]") {
      var props = [];
      try {
        for (var k in v) {
          if (has(v, k)) {
            var val = v[k];
            if (val === undefined || typeof val === "function") { continue; }
            props.push(quote(k) + ":" + encode(val, depth + 1));
          }
        }
        return "{" + props.join(",") + "}";
      } catch (e) {
        return quote(str(v));
      }
    }
    // Java strings/numbers/booleans, COM variants and everything else
    var s = str(v);
    if (s === "true" || s === "false") { return s; }
    return quote(s);
  }

  function JsonParser(text) { this.t = text; this.i = 0; }
  JsonParser.prototype.fail = function (msg) {
    throw makeError("BAD_REQUEST", "Invalid JSON: " + msg + " at " + this.i);
  };
  JsonParser.prototype.ws = function () {
    while (this.i < this.t.length) {
      var c = this.t.charAt(this.i);
      if (c === " " || c === "\t" || c === "\n" || c === "\r") { this.i++; } else { break; }
    }
  };
  JsonParser.prototype.value = function () {
    this.ws();
    var c = this.t.charAt(this.i);
    if (c === "{") { return this.object(); }
    if (c === "[") { return this.array(); }
    if (c === "\"") { return this.string(); }
    if (c === "t" && this.t.substring(this.i, this.i + 4) === "true") { this.i += 4; return true; }
    if (c === "f" && this.t.substring(this.i, this.i + 5) === "false") { this.i += 5; return false; }
    if (c === "n" && this.t.substring(this.i, this.i + 4) === "null") { this.i += 4; return null; }
    var m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+\-]?[0-9]+)?/.exec(this.t.substring(this.i));
    if (m) { this.i += m[0].length; return Number(m[0]); }
    return this.fail("unexpected character");
  };
  JsonParser.prototype.object = function () {
    var o = {};
    this.i++;
    this.ws();
    if (this.t.charAt(this.i) === "}") { this.i++; return o; }
    while (true) {
      this.ws();
      if (this.t.charAt(this.i) !== "\"") { this.fail("expected key"); }
      var k = this.string();
      this.ws();
      if (this.t.charAt(this.i) !== ":") { this.fail("expected ':'"); }
      this.i++;
      o[k] = this.value();
      this.ws();
      var c = this.t.charAt(this.i);
      this.i++;
      if (c === "}") { return o; }
      if (c !== ",") { this.fail("expected ',' or '}'"); }
    }
  };
  JsonParser.prototype.array = function () {
    var a = [];
    this.i++;
    this.ws();
    if (this.t.charAt(this.i) === "]") { this.i++; return a; }
    while (true) {
      a.push(this.value());
      this.ws();
      var c = this.t.charAt(this.i);
      this.i++;
      if (c === "]") { return a; }
      if (c !== ",") { this.fail("expected ',' or ']'"); }
    }
  };
  JsonParser.prototype.string = function () {
    var out = "";
    this.i++;
    while (this.i < this.t.length) {
      var c = this.t.charAt(this.i);
      this.i++;
      if (c === "\"") { return out; }
      if (c === "\\") {
        var e = this.t.charAt(this.i);
        this.i++;
        if (e === "n") { out += "\n"; }
        else if (e === "r") { out += "\r"; }
        else if (e === "t") { out += "\t"; }
        else if (e === "b") { out += "\b"; }
        else if (e === "f") { out += "\f"; }
        else if (e === "u") {
          var hex = this.t.substring(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) { this.fail("bad unicode escape"); }
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 4;
        } else { out += e; }
      } else { out += c; }
    }
    return this.fail("unterminated string");
  };
  function decode(text) {
    var p = new JsonParser(str(text));
    var v = p.value();
    p.ws();
    if (p.i !== p.t.length) { p.fail("trailing characters"); }
    return v;
  }

  /* ------------------------------------------------------------------ */
  /* errors                                                              */
  /* ------------------------------------------------------------------ */

  function makeError(code, message, hint) {
    var e = new Error(message);
    e.bridgeCode = code;
    e.bridgeMessage = message;
    if (hint) { e.hint = hint; }
    return e;
  }
  function fail(code, message, hint) { throw makeError(code, message, hint); }

  function errText(e) {
    if (isNil(e)) { return "unknown error"; }
    if (e.bridgeMessage) { return str(e.bridgeMessage); }
    var m = "";
    try { m = str(e.message); } catch (x) { m = ""; }
    if (!m) { try { m = str(e.description); } catch (y) { m = ""; } }
    if (!m) { m = str(e); }
    // Rhino prefixes wrapped Java exceptions
    m = m.replace(/^(JavaException|InternalError|WrappedException):\s*/, "");
    return m;
  }

  /** Map an engine error to a stable code the adapters and the model can act on. */
  function classifyError(e) {
    if (e && e.bridgeCode) {
      return { code: e.bridgeCode, message: errText(e), hint: e.hint };
    }
    var msg = errText(e);
    var l = lower(msg);
    if (/could not be found|findbyid|not found by id|no element with id|element .* not found/.test(l)) {
      return { code: "NOT_FOUND", message: msg, hint: "The id is not on the current screen. Read the screen again with sap_screen and use an id from there." };
    }
    if (/rpc|remote procedure|disconnected|has been closed|0x800706ba|0x800706be|0x80010108|server execution failed|not connected/.test(l)) {
      if (HOST && HOST.resetApplication) { try { HOST.resetApplication(); } catch (x) { /* ignore */ } }
      return { code: "SAPGUI_UNAVAILABLE", message: msg, hint: "SAP GUI is not reachable any more (closed or crashed). Start it again with sap_start." };
    }
    if (/scripting.*(disabled|not enabled|deactivated)|disabledbyserver|user_scripting/.test(l)) {
      return { code: "SCRIPTING_DISABLED", message: msg, hint: "Enable scripting in SAP GUI options and on the server (RZ11: sapgui/user_scripting = TRUE)." };
    }
    if (/changeable|read.?only|not modifiable|nicht eingabebereit/.test(l)) {
      return { code: "READ_ONLY", message: msg, hint: "The field is not changeable on this screen (display mode?)." };
    }
    if (/busy/.test(l)) {
      return { code: "BUSY", message: msg, hint: "SAP is still processing. Wait a moment and read the screen again." };
    }
    return { code: "SAP_ERROR", message: msg };
  }

  /* ------------------------------------------------------------------ */
  /* safe access to SAP objects                                          */
  /* ------------------------------------------------------------------ */

  function prop(o, name) {
    if (isNil(o)) { return undefined; }
    try {
      var v = o[name];
      if (typeof v === "function") { return undefined; }
      return v;
    } catch (e) {
      return undefined;
    }
  }
  function propStr(o, name) { return str(prop(o, name)); }

  /** Call o[name](args...) if it exists; returns {ok, value, error}. */
  function tryCall(o, name, args) {
    if (isNil(o)) { return { ok: false }; }
    try {
      var a = args || [];
      var v;
      if (a.length === 0) { v = o[name](); }
      else if (a.length === 1) { v = o[name](a[0]); }
      else if (a.length === 2) { v = o[name](a[0], a[1]); }
      else if (a.length === 3) { v = o[name](a[0], a[1], a[2]); }
      else { v = o[name](a[0], a[1], a[2], a[3]); }
      return { ok: true, value: v };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  function collCount(c) {
    if (isNil(c)) { return 0; }
    var n = prop(c, "count");
    if (isNil(n)) { n = prop(c, "Count"); }
    if (isNil(n)) { n = prop(c, "length"); }
    if (isNil(n)) { var r = tryCall(c, "size"); if (r.ok) { n = r.value; } }
    if (isNil(n)) { var r2 = tryCall(c, "getCount"); if (r2.ok) { n = r2.value; } }
    return num(n, 0);
  }
  function collItem(c, i) {
    var r = tryCall(c, "elementAt", [i]);
    if (r.ok && !isNil(r.value)) { return r.value; }
    r = tryCall(c, "item", [i]);
    if (r.ok && !isNil(r.value)) { return r.value; }
    r = tryCall(c, "get", [i]);
    if (r.ok && !isNil(r.value)) { return r.value; }
    try { var v = c(i); if (!isNil(v)) { return v; } } catch (e) { /* not callable */ }
    try { return c[i]; } catch (e2) { return undefined; }
  }
  function collToArray(c, limit) {
    var out = [];
    var n = collCount(c);
    if (limit && n > limit) { n = limit; }
    for (var i = 0; i < n; i++) { out.push(collItem(c, i)); }
    return out;
  }
  function children(o) {
    var c = prop(o, "children");
    if (isNil(c)) { c = prop(o, "Children"); }
    return c;
  }

  /* ------------------------------------------------------------------ */
  /* application, connections, sessions                                  */
  /* ------------------------------------------------------------------ */

  function app() {
    var a = null;
    try { a = HOST.getApplication(); } catch (e) {
      var c = classifyError(e);
      if (c.code === "SAP_ERROR") {
        fail("SAPGUI_UNAVAILABLE", "SAP GUI scripting engine not available: " + c.message,
          HOST.kind === "windows"
            ? "Start SAP Logon (sap_start) and make sure scripting is enabled in SAP GUI Options > Accessibility & Scripting."
            : "Start SAP GUI for Java through sap_start so the bridge runs inside it.");
      }
      throw makeError(c.code, c.message, c.hint);
    }
    if (isNil(a)) { fail("SAPGUI_UNAVAILABLE", "SAP GUI scripting engine not available.", "Start SAP GUI with sap_start."); }
    return a;
  }

  /** "/app/con[0]/ses[1]", "con[0]/ses[1]", "0/1", "0:1" -> "/app/con[0]/ses[1]" */
  function normalizeSessionId(ref) {
    var s = trim(ref);
    if (!s) { return ""; }
    var m = /^(\d+)\s*[\/:]\s*(\d+)$/.exec(s);
    if (m) { return "/app/con[" + m[1] + "]/ses[" + m[2] + "]"; }
    m = /con\[(\d+)\]\/ses\[(\d+)\]/.exec(s);
    if (m) { return "/app/con[" + m[1] + "]/ses[" + m[2] + "]"; }
    fail("BAD_REQUEST", "Not a session id: " + s, "Use an id like /app/con[0]/ses[0] from sap_sessions.");
    return "";
  }

  function allSessions() {
    var a = app();
    var out = [];
    var conns = collToArray(children(a), 50);
    for (var i = 0; i < conns.length; i++) {
      var sess = collToArray(children(conns[i]), 20);
      for (var j = 0; j < sess.length; j++) { out.push({ connection: conns[i], session: sess[j] }); }
    }
    return out;
  }

  function findSession(ref) {
    var a = app();
    if (ref) {
      var id = normalizeSessionId(ref);
      var r = tryCall(a, "findById", [id]);
      if (r.ok && !isNil(r.value)) { return r.value; }
      fail("SESSION_NOT_FOUND", "Session " + id + " does not exist (any more).", "List the open sessions with sap_sessions.");
    }
    var active = prop(a, "activeSession");
    if (!isNil(active) && propStr(active, "id")) { return active; }
    var list = allSessions();
    if (list.length > 0) { return list[0].session; }
    fail("NO_SESSION", "No SAP session is open.", "Log on with sap_login, or log on in SAP GUI yourself and call sap_sessions.");
    return null;
  }

  function sessionId(s) { return propStr(s, "id").replace(/^.*?(\/app\/)/, "/app/"); }

  function sessionInfo(s) {
    var info = prop(s, "info");
    var out = { id: sessionId(s) };
    if (isNil(info)) { return out; }
    var keys = ["systemName", "client", "user", "language", "transaction", "program", "screenNumber",
      "sessionNumber", "systemNumber", "applicationServer", "messageServer", "group", "codepage",
      "systemSessionId", "scriptingModeReadOnly", "isLowSpeedConnection"];
    for (var i = 0; i < keys.length; i++) {
      var v = prop(info, keys[i]);
      if (!isNil(v) && str(v) !== "") { out[keys[i]] = (keys[i] === "scriptingModeReadOnly" || keys[i] === "isLowSpeedConnection") ? bool(v) : str(v); }
    }
    if (out.screenNumber) {
      var n = out.screenNumber;
      while (n.length < 4) { n = "0" + n; }
      out.screenNumber = n;
    }
    return out;
  }

  function waitIdle(s, timeoutMs) {
    var limit = num(timeoutMs, 30000);
    var t0 = now();
    while (true) {
      var busy = false;
      try { busy = bool(prop(s, "busy")); } catch (e) { busy = false; }
      if (!busy) { return true; }
      if (now() - t0 > limit) { return false; }
      sleep(100);
    }
  }

  /* ------------------------------------------------------------------ */
  /* elements                                                            */
  /* ------------------------------------------------------------------ */

  var ID_PREFIX_TYPES = [
    ["ctxt", "GuiCTextField"], ["txt", "GuiTextField"], ["pwd", "GuiPasswordField"],
    ["chk", "GuiCheckBox"], ["rad", "GuiRadioButton"], ["cmb", "GuiComboBox"],
    ["btn", "GuiButton"], ["tabs", "GuiTabStrip"], ["tabp", "GuiTab"], ["tbl", "GuiTableControl"],
    ["lbl", "GuiLabel"], ["box", "GuiBox"], ["shellcont", "GuiContainerShell"], ["shell", "GuiShell"],
    ["cntl", "GuiCustomControl"], ["okcd", "GuiOkCodeField"], ["sbar", "GuiStatusbar"],
    ["titl", "GuiTitlebar"], ["tbar", "GuiToolbar"], ["mbar", "GuiMenubar"], ["menu", "GuiMenu"],
    ["usr", "GuiUserArea"], ["ssub", "GuiSimpleContainer"], ["sub", "GuiSimpleContainer"],
    ["wnd", "GuiFrameWindow"], ["cnt", "GuiCustomControl"]
  ];

  function lastSegment(id) {
    var s = str(id);
    var k = s.lastIndexOf("/");
    return k >= 0 ? s.substring(k + 1) : s;
  }
  function typeFromId(id) {
    var seg = lastSegment(id);
    for (var i = 0; i < ID_PREFIX_TYPES.length; i++) {
      if (startsWith(seg, ID_PREFIX_TYPES[i][0])) { return ID_PREFIX_TYPES[i][1]; }
    }
    return "";
  }
  function elType(el) {
    var t = propStr(el, "type");
    if (!t) { t = typeFromId(propStr(el, "id")); }
    return t;
  }
  function shellSubType(el) { return propStr(el, "subType"); }

  /** SAP GUI for Java exposes ALV grids as a GuiShell without a subType, but with the grid methods. */
  function shellActsAsGrid(el) {
    if (shellSubType(el)) { return false; }
    if (isNil(prop(el, "rowCount"))) { return false; }
    var fn;
    try { fn = el.getCellValue; } catch (e) { return false; }
    return typeof fn === "function";
  }

  /** Element id relative to the session: "wnd[0]/usr/ctxtX". */
  function relId(el) {
    var id = propStr(el, "id");
    var m = /\/ses\[\d+\]\/(.*)$/.exec(id);
    return m ? m[1] : id;
  }

  function windowExists(s, n) {
    var r = tryCall(s, "findById", ["wnd[" + n + "]"]);
    return r.ok && !isNil(r.value);
  }
  function activeWindowIndex(s) {
    var top = 0;
    for (var i = 1; i < 10; i++) { if (windowExists(s, i)) { top = i; } else { break; } }
    return top;
  }

  /** Normalise an element id given by the model: absolute, relative, or missing the window. */
  function normalizeElementId(id, windowIndex) {
    var s = trim(id).replace(/\\/g, "/");
    if (!s) { fail("BAD_REQUEST", "Element id must not be empty."); }
    var m = /\/ses\[\d+\]\/(.*)$/.exec(s);
    if (m) { s = m[1]; }
    s = s.replace(/^\/+/, "");
    if (!/^wnd\[\d+\]/.test(s)) {
      s = "wnd[" + (isNil(windowIndex) ? 0 : windowIndex) + "]/" + s;
    }
    return s;
  }

  function findElement(s, id, windowIndex) {
    var rel = normalizeElementId(id, windowIndex);
    var r = tryCall(s, "findById", [rel]);
    if (r.ok && !isNil(r.value)) { return r.value; }
    var popup = activeWindowIndex(s);
    var hint = "Read the screen again with sap_screen and use an id from there.";
    if (popup > 0 && /^wnd\[0\]/.test(rel)) {
      hint = "A popup (wnd[" + popup + "]) is open and blocks the main window. Handle it first with sap_popup.";
    }
    fail("NOT_FOUND", "No element with id " + rel + " on the current screen.", hint);
    return null;
  }

  function isInputType(t) {
    return t === "GuiTextField" || t === "GuiCTextField" || t === "GuiPasswordField" ||
      t === "GuiComboBox" || t === "GuiCheckBox" || t === "GuiRadioButton" || t === "GuiOkCodeField";
  }

  /* ------------------------------------------------------------------ */
  /* screen reading                                                      */
  /* ------------------------------------------------------------------ */

  var CONTAINER_TYPES = ["GuiMainWindow", "GuiModalWindow", "GuiFrameWindow", "GuiUserArea",
    "GuiSimpleContainer", "GuiScrollContainer", "GuiTabStrip", "GuiTab", "GuiCustomControl",
    "GuiContainerShell", "GuiSplitterContainer", "GuiDockShell", "GuiGOSShell", "GuiToolbar",
    "GuiShell", "GuiListContainer", "GuiSubscreenContainer", "GuiSubscreen"];

  function readStatus(s, wndIndex) {
    var w = isNil(wndIndex) ? 0 : wndIndex;
    var r = tryCall(s, "findById", ["wnd[" + w + "]/sbar"]);
    if (!r.ok || isNil(r.value)) {
      if (w !== 0) { return readStatus(s, 0); }
      return null;
    }
    var sb = r.value;
    var text = trim(propStr(sb, "text"));
    var type = trim(propStr(sb, "messageType"));
    if (!text && !type) { return null; }
    var out = { type: type, text: text };
    var mid = trim(propStr(sb, "messageId"));
    var mno = trim(propStr(sb, "messageNumber"));
    if (mid) { out.messageId = mid; }
    if (mno) { out.messageNumber = mno; }
    return out;
  }

  function describeElement(el, opts) {
    var id = relId(el);
    var t = elType(el);
    var d = { id: id, type: t };
    var name = propStr(el, "name");
    if (name) { d.name = name; }
    if (t === "GuiPasswordField") {
      d.kind = "password";
      d.changeable = bool(prop(el, "changeable"));
      return d;
    }
    if (t === "GuiTextField" || t === "GuiCTextField") {
      d.changeable = bool(prop(el, "changeable"));
      d.kind = d.changeable ? "input" : "output";
      d.value = propStr(el, "text");
      if (t === "GuiCTextField") { d.f4 = true; }
      if (bool(prop(el, "required"))) { d.required = true; }
      var maxLen = num(prop(el, "maxLength"), 0);
      if (maxLen) { d.maxLength = maxLen; }
      var ll = prop(el, "leftLabel");
      if (!isNil(ll) && typeof ll === "object") {
        var lt = trim(propStr(ll, "text"));
        if (lt) { d.label = lt; d.labelId = relId(ll); }
      }
    } else if (t === "GuiComboBox") {
      d.kind = "combo";
      d.changeable = bool(prop(el, "changeable"));
      d.key = propStr(el, "key");
      d.value = propStr(el, "value");
      var cl = prop(el, "leftLabel");
      if (!isNil(cl) && typeof cl === "object") {
        var clt = trim(propStr(cl, "text"));
        if (clt) { d.label = clt; d.labelId = relId(cl); }
      }
      if (opts && opts.entries) { d.entries = comboEntries(el, 60); }
    } else if (t === "GuiCheckBox") {
      d.kind = "check";
      d.label = trim(propStr(el, "text"));
      d.selected = bool(prop(el, "selected"));
      d.changeable = bool(prop(el, "changeable"));
    } else if (t === "GuiRadioButton") {
      d.kind = "radio";
      d.label = trim(propStr(el, "text"));
      d.selected = bool(prop(el, "selected"));
      d.changeable = bool(prop(el, "changeable"));
    } else if (t === "GuiButton") {
      d.kind = "button";
      d.label = trim(propStr(el, "text"));
      d.enabled = isNil(prop(el, "changeable")) ? true : bool(prop(el, "changeable"));
    } else if (t === "GuiTab") {
      d.kind = "tab";
      d.label = trim(propStr(el, "text"));
    } else if (t === "GuiLabel") {
      d.kind = "text";
      d.value = propStr(el, "text");
    } else if (t === "GuiBox") {
      d.kind = "box";
      d.label = trim(propStr(el, "text"));
    } else if (t === "GuiTableControl") {
      d.kind = "table";
      d.rowCount = num(prop(el, "rowCount"), 0);
      d.visibleRowCount = num(prop(el, "visibleRowCount"), 0);
      d.columnCount = collCount(prop(el, "columns"));
    } else if (t === "GuiTextedit" || (t === "GuiShell" && shellSubType(el) === "TextEdit")) {
      d.kind = "textedit";
      d.value = clip(propStr(el, "text"), 300);
      d.changeable = bool(prop(el, "changeable"));
    } else if (t === "GuiShell" || t === "GuiGridView" || t === "GuiTree" || t === "GuiToolbarControl" ||
      t === "GuiHTMLViewer" || t === "GuiAbapEditor" || t === "GuiPicture" || t === "GuiCalendar") {
      var sub = shellSubType(el);
      d.subType = sub;
      if (sub === "GridView" || t === "GuiGridView" || shellActsAsGrid(el)) {
        d.kind = "grid";
        d.rowCount = num(prop(el, "rowCount"), 0);
        d.columnCount = num(prop(el, "columnCount"), 0);
        if (!d.columnCount) { d.columnCount = collCount(prop(el, "columnOrder")); }
        var title = trim(propStr(el, "title"));
        if (title) { d.label = title; }
      } else if (sub === "Tree" || t === "GuiTree") {
        d.kind = "tree";
      } else if (sub === "Toolbar" || t === "GuiToolbarControl") {
        d.kind = "toolbar";
        d.buttons = toolbarButtons(el, "toolbar");
      } else if (sub === "HTMLViewer") {
        d.kind = "html";
      } else if (sub === "AbapEditor" || t === "GuiAbapEditor") {
        d.kind = "editor";
      } else {
        d.kind = "control";
      }
    } else if (t === "GuiStatusbar" || t === "GuiTitlebar" || t === "GuiOkCodeField" || t === "GuiMenubar") {
      d.kind = "chrome";
    } else if (indexOf(CONTAINER_TYPES, t) >= 0) {
      d.kind = "container";
    } else {
      d.kind = "other";
    }
    var tip = trim(propStr(el, "tooltip"));
    if (tip && tip !== d.label) { d.tooltip = tip; }
    if (opts && opts.geometry) {
      d.left = num(prop(el, "left"), 0);
      d.top = num(prop(el, "top"), 0);
    }
    if (opts && opts.icon) {
      var icon = propStr(el, "iconName");
      if (icon) { d.icon = icon; }
    }
    return d;
  }

  function comboEntries(el, limit) {
    var out = [];
    var entries = collToArray(prop(el, "entries"), limit || 60);
    for (var i = 0; i < entries.length; i++) {
      out.push({ key: propStr(entries[i], "key"), value: propStr(entries[i], "value") });
    }
    return out;
  }

  /** Buttons of an ALV grid toolbar or a toolbar shell. */
  function toolbarButtons(shell, mode) {
    var out = [];
    var n = num(prop(shell, mode === "grid" ? "toolbarButtonCount" : "buttonCount"), 0);
    if (n > 80) { n = 80; }
    var prefix = mode === "grid" ? "getToolbarButton" : "getButton";
    for (var i = 0; i < n; i++) {
      var b = {};
      var r = tryCall(shell, prefix + "Id", [i]);
      if (r.ok) { b.id = str(r.value); }
      r = tryCall(shell, prefix + "Type", [i]);
      if (r.ok) { b.type = toolbarButtonType(r.value); }
      if (b.type === "Separator") { continue; }
      r = tryCall(shell, prefix + "Text", [i]);
      if (r.ok && trim(str(r.value))) { b.text = trim(str(r.value)); }
      r = tryCall(shell, prefix + "Tooltip", [i]);
      if (r.ok && trim(str(r.value))) { b.tooltip = trim(str(r.value)); }
      r = tryCall(shell, prefix + "Enabled", [i]);
      if (r.ok) { b.enabled = bool(r.value); }
      if (b.id || b.text) { out.push(b); }
    }
    return out;
  }
  function toolbarButtonType(v) {
    var s = str(v);
    var map = { "0": "Button", "1": "ButtonAndMenu", "2": "Menu", "3": "Separator", "4": "CheckBox", "5": "Group" };
    return has(map, s) ? map[s] : s;
  }

  /**
   * Walk a window and collect a flat element list. Lists (lbl[x,y]) are
   * collected separately; table controls are summarised, not expanded.
   */
  function collect(root, opts) {
    var out = { elements: [], listCells: [], truncated: false };
    var max = num(opts.maxElements, 400);
    var maxDepth = 14;
    function walk(container, depth) {
      if (depth > maxDepth) { return; }
      var kids = children(container);
      var n = collCount(kids);
      for (var i = 0; i < n; i++) {
        if (out.elements.length >= max) { out.truncated = true; return; }
        var el = collItem(kids, i);
        if (isNil(el)) { continue; }
        var id = relId(el);
        var seg = lastSegment(id);
        var t = elType(el);
        if (!opts.includeToolbar && /\/tbar\[0\]$/.test(id)) { continue; }
        if (/\/(mbar|sbar|titl)$/.test(id) || t === "GuiMenubar" || t === "GuiStatusbar" || t === "GuiTitlebar") { continue; }
        if (t === "GuiOkCodeField") { continue; }
        var lm = /^(lbl|txt)\[(\d+),(\d+)\]$/.exec(seg);
        if (lm && (t === "GuiLabel" || t === "GuiTextField")) {
          out.listCells.push({ x: num(lm[2], 0), y: num(lm[3], 0), text: propStr(el, "text"), id: id,
            changeable: t === "GuiTextField" ? bool(prop(el, "changeable")) : false });
          continue;
        }
        var d = describeElement(el, { geometry: true, icon: opts.icon });
        if (d.kind === "text" && !trim(d.value)) { continue; }
        if (d.kind !== "chrome" && d.kind !== "container") { out.elements.push(d); }
        var recurse = indexOf(CONTAINER_TYPES, t) >= 0 || t === "";
        /* SAP GUI for Java uses container types we do not list (GuiListContainer,
           GuiSplitterShell, ...); descend into anything unknown that has children. */
        if (!recurse && d.kind === "other") { recurse = collCount(children(el)) > 0; }
        if (d.kind === "table" || d.kind === "grid" || d.kind === "tree" || d.kind === "textedit" || d.kind === "toolbar") { recurse = false; }
        if (recurse) { walk(el, depth + 1); }
      }
    }
    walk(root, 0);
    attachLabels(out.elements);
    return out;
  }

  /** Give inputs without a leftLabel the nearest label on the same row; drop labels that got used. */
  function attachLabels(elements) {
    var used = {};
    var i, j;
    for (i = 0; i < elements.length; i++) { if (elements[i].labelId) { used[elements[i].labelId] = true; } }
    for (i = 0; i < elements.length; i++) {
      var e = elements[i];
      if ((e.kind === "input" || e.kind === "output" || e.kind === "password" || e.kind === "combo") && !e.label) {
        var best = null;
        var bestDist = 100000;
        for (j = 0; j < elements.length; j++) {
          var l = elements[j];
          if (l.kind !== "text" || used[l.id]) { continue; }
          if (l.top === e.top && l.left < e.left && (e.left - l.left) < bestDist) { best = l; bestDist = e.left - l.left; }
        }
        if (!best && e.name) {
          for (j = 0; j < elements.length; j++) {
            if (elements[j].kind === "text" && elements[j].name === e.name && !used[elements[j].id]) { best = elements[j]; break; }
          }
        }
        if (best) { e.label = trim(best.value); e.labelId = best.id; used[best.id] = true; }
      }
    }
    var kept = [];
    for (i = 0; i < elements.length; i++) {
      if (elements[i].kind === "text" && used[elements[i].id]) { continue; }
      kept.push(elements[i]);
    }
    elements.length = 0;
    for (i = 0; i < kept.length; i++) { elements.push(kept[i]); }
  }

  function listLines(cells, maxLines) {
    if (!cells.length) { return []; }
    var rows = {};
    var ys = [];
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (!has(rows, "y" + c.y)) { rows["y" + c.y] = []; ys.push(c.y); }
      rows["y" + c.y].push(c);
    }
    ys.sort(function (a, b) { return a - b; });
    var lines = [];
    for (var k = 0; k < ys.length && lines.length < (maxLines || 200); k++) {
      var row = rows["y" + ys[k]];
      row.sort(function (a, b) { return a.x - b.x; });
      var line = "";
      for (var r = 0; r < row.length; r++) {
        var x = row[r].x;
        var col = x > 0 ? x - 1 : 0;
        if (line.length < col) { line = pad(line, col); } else if (line.length > 0) { line += " "; }
        line += str(row[r].text);
      }
      lines.push(line.replace(/\s+$/, ""));
    }
    return lines;
  }

  function popupSummary(s, w) {
    var r = tryCall(s, "findById", ["wnd[" + w + "]"]);
    if (!r.ok || isNil(r.value)) { return null; }
    var wnd = r.value;
    var res = collect(wnd, { maxElements: 120, includeToolbar: true, icon: true });
    var lines = [];
    var buttons = [];
    var inputs = [];
    for (var i = 0; i < res.elements.length; i++) {
      var e = res.elements[i];
      if (e.kind === "button") { buttons.push({ id: e.id, label: e.label, tooltip: e.tooltip }); }
      else if (e.kind === "text" || e.kind === "output") { if (trim(e.value)) { lines.push(trim(e.value)); } }
      else if (e.kind === "input" || e.kind === "combo" || e.kind === "check" || e.kind === "radio" || e.kind === "password") { inputs.push(e); }
    }
    var ll = listLines(res.listCells, 40);
    for (var k = 0; k < ll.length; k++) { if (trim(ll[k])) { lines.push(trim(ll[k])); } }
    return { window: "wnd[" + w + "]", title: propStr(wnd, "text"), lines: lines, buttons: buttons, inputs: inputs.length };
  }

  /** Header facts about the session after any action. */
  function afterState(s, opts) {
    var settled = waitIdle(s, opts && opts.timeoutMs ? opts.timeoutMs : 30000);
    var info = sessionInfo(s);
    var top = activeWindowIndex(s);
    var w0 = tryCall(s, "findById", ["wnd[0]"]);
    var st = {
      session: info.id,
      system: info.systemName, client: info.client, user: info.user, language: info.language,
      transaction: info.transaction, program: info.program, screen: info.screenNumber,
      title: w0.ok ? propStr(w0.value, "text") : "",
      status: readStatus(s, 0),
      activeWindow: "wnd[" + top + "]"
    };
    if (!settled) { st.busy = true; }
    if (top > 0) { st.popup = popupSummary(s, top); }
    return st;
  }

  function renderAfter(st) {
    var lines = [];
    var sys = st.system ? st.system + "/" + str(st.client) : "(not logged on)";
    lines.push(sys + (st.user ? " " + st.user : "") + " \u00b7 " + (st.transaction || "-") + " \u00b7 " +
      (st.program || "-") + " " + (st.screen || "") + " \u00b7 \"" + str(st.title) + "\"");
    if (st.status) {
      lines.push("Status [" + (st.status.type || "-") + "] " + st.status.text +
        (st.status.messageId ? " (" + st.status.messageId + " " + str(st.status.messageNumber) + ")" : ""));
    }
    if (st.busy) { lines.push("SAP is still busy -- read the screen again in a moment."); }
    if (st.popup) {
      lines.push("POPUP " + st.popup.window + " \"" + st.popup.title + "\" is open and blocks the main window:");
      for (var i = 0; i < st.popup.lines.length && i < 12; i++) { lines.push("  | " + st.popup.lines[i]); }
      var bs = [];
      for (var j = 0; j < st.popup.buttons.length; j++) {
        var b = st.popup.buttons[j];
        bs.push((b.label || b.tooltip || "?") + " = " + b.id);
      }
      if (bs.length) { lines.push("  buttons: " + bs.join("; ")); }
      if (st.popup.inputs) { lines.push("  (" + st.popup.inputs + " input field(s) -- read them with sap_screen)"); }
    }
    return lines.join("\n");
  }

  function fmtValue(v) { return dq(clip(v, 160)); }

  function renderElement(e) {
    var lbl = e.label ? e.label : (e.tooltip ? e.tooltip : "");
    var flags = [];
    switch (e.kind) {
      case "input":
      case "output":
        if (e.f4) { flags.push("F4"); }
        if (e.required) { flags.push("required"); }
        if (e.kind === "output") { flags.push("read-only"); }
        return "[" + e.kind + "] " + e.id + "  " + (lbl || e.name || "") + " = " + fmtValue(e.value) +
          (flags.length ? "  (" + flags.join(", ") + ")" : "");
      case "password":
        return "[password] " + e.id + "  " + (lbl || "Password");
      case "combo":
        return "[combo] " + e.id + "  " + (lbl || e.name || "") + " = " + fmtValue(e.value) + " (key " + dq(e.key) + ")" +
          (e.changeable ? "" : "  (read-only)");
      case "check":
        return "[check] " + e.id + "  " + lbl + " = " + (e.selected ? "on" : "off") + (e.changeable ? "" : "  (read-only)");
      case "radio":
        return "[radio] " + e.id + "  " + lbl + (e.selected ? " = selected" : "") + (e.changeable ? "" : "  (read-only)");
      case "button":
        return "[button] " + e.id + "  " + (e.label || e.tooltip || "(icon)") +
          (e.label && e.tooltip ? "  -- " + e.tooltip : "") + (e.enabled ? "" : "  (disabled)");
      case "tab":
        return "[tab] " + e.id + "  " + lbl;
      case "text":
        return "[text] " + clip(e.value, 200);
      case "box":
        return "--- " + (lbl || "(group)") + " ---";
      case "table":
        return "[table] " + e.id + "  table control: " + e.rowCount + " rows (" + e.visibleRowCount + " visible) x " +
          e.columnCount + " columns -> sap_table";
      case "grid":
        return "[grid] " + e.id + "  ALV grid" + (e.label ? " \"" + e.label + "\"" : "") + ": " + e.rowCount + " rows x " +
          e.columnCount + " columns -> sap_table";
      case "tree":
        return "[tree] " + e.id + "  tree control -> sap_table";
      case "textedit":
        return "[textedit] " + e.id + "  " + fmtValue(e.value);
      case "toolbar":
        var bs = [];
        for (var i = 0; i < e.buttons.length && i < 30; i++) {
          bs.push((e.buttons[i].text || e.buttons[i].tooltip || e.buttons[i].id) + "=" + e.buttons[i].id);
        }
        return "[toolbar] " + e.id + "  " + bs.join("; ");
      default:
        return "[" + (e.kind || "other") + "] " + e.id + (e.subType ? " (" + e.subType + ")" : "") + (lbl ? "  " + lbl : "");
    }
  }

  /* ------------------------------------------------------------------ */
  /* operations                                                          */
  /* ------------------------------------------------------------------ */

  var OPS = {};

  OPS.hello = function () {
    var out = { bridge: VERSION, protocol: PROTOCOL, host: HOST.kind, engine: HOST.engine || "" };
    try {
      var a = app();
      out.sapgui = {
        major: str(prop(a, "majorVersion")), minor: str(prop(a, "minorVersion")),
        patch: str(prop(a, "patchlevel")), revision: str(prop(a, "revision"))
      };
      out.connections = collCount(children(a));
    } catch (e) {
      var c = classifyError(e);
      out.sapguiError = c;
    }
    return out;
  };

  OPS.ping = function () { return { pong: true, time: now() }; };

  OPS.sessions = function (args) {
    var a = app();
    var action = lower(args.action || "list");
    if (action === "create") {
      var base = findSession(args.session);
      var before = allSessions().length;
      base.createSession();
      var t0 = now();
      var created = null;
      while (now() - t0 < 15000) {
        var list = allSessions();
        if (list.length > before) { created = list[list.length - 1].session; break; }
        sleep(200);
      }
      if (!created) { fail("TIMEOUT", "The new session did not appear within 15 seconds.", "SAP allows at most 6 sessions per logon (rdisp/max_alt_modes)."); }
      waitIdle(created, 15000);
      return { text: "Opened new session " + sessionId(created), data: sessionInfo(created) };
    }
    if (action === "close") {
      var sc = findSession(args.session);
      var sid = sessionId(sc);
      var conn = prop(sc, "parent");
      if (isNil(conn)) { fail("SAP_ERROR", "Could not determine the connection of " + sid); }
      var cnt = collCount(children(conn));
      if (cnt <= 1 && !bool(args.force)) {
        fail("BAD_REQUEST", "This is the last session of the connection; closing it logs off.", "Use action logoff to close the whole connection.");
      }
      conn.closeSession(sid);
      return { text: "Closed session " + sid };
    }
    if (action === "bind") {
      if (!trim(args.session)) { fail("BAD_REQUEST", "bind needs session, e.g. /app/con[0]/ses[0]."); }
      var sb = findSession(args.session);
      var bi = sessionInfo(sb);
      return { text: "Bound to " + bi.id + " (" + (bi.systemName || "?") + "/" + str(bi.client) + " " + str(bi.user) + ")", data: bi };
    }
    if (action === "logoff") {
      var sl = findSession(args.session);
      var c2 = prop(sl, "parent");
      var desc = propStr(c2, "description");
      c2.closeConnection();
      return { text: "Closed connection " + (desc || propStr(c2, "id")) };
    }
    // list
    var conns = collToArray(children(a), 50);
    var data = [];
    var lines = [];
    for (var i = 0; i < conns.length; i++) {
      var cn = conns[i];
      var cinfo = {
        id: propStr(cn, "id").replace(/^.*?(\/app\/)/, "/app/"),
        description: propStr(cn, "description"),
        connectionString: propStr(cn, "connectionString"),
        disabledByServer: bool(prop(cn, "disabledByServer")),
        sessions: []
      };
      lines.push("Connection " + cinfo.id + (cinfo.description ? " \"" + cinfo.description + "\"" : "") +
        (cinfo.disabledByServer ? "  !! scripting disabled by server (RZ11 sapgui/user_scripting)" : ""));
      var ss = collToArray(children(cn), 20);
      for (var j = 0; j < ss.length; j++) {
        var si = sessionInfo(ss[j]);
        var busy = bool(prop(ss[j], "busy"));
        si.busy = busy;
        cinfo.sessions.push(si);
        lines.push("  " + si.id + "  " + (si.systemName || "?") + "/" + str(si.client) + " " + str(si.user) +
          "  " + (si.transaction || "-") + (busy ? "  (busy)" : "") +
          (si.scriptingModeReadOnly ? "  (read-only scripting)" : ""));
      }
      data.push(cinfo);
    }
    if (!lines.length) { lines.push("No SAP connection is open. Log on with sap_login or in SAP GUI."); }
    return { text: lines.join("\n"), data: data };
  };

  OPS.screen = function (args) {
    var s = findSession(args.session);
    waitIdle(s, 30000);
    var top = activeWindowIndex(s);
    var w = isNil(args.window) || args.window === "" ? top : num(args.window, top);
    var r = tryCall(s, "findById", ["wnd[" + w + "]"]);
    if (!r.ok || isNil(r.value)) { fail("NOT_FOUND", "Window wnd[" + w + "] does not exist.", "The active window is wnd[" + top + "]."); }
    var wnd = r.value;
    var filter = lower(trim(args.filter));
    var wanted = num(args.maxElements, 400);
    /* The filter is applied to the rendered lines after collecting, so the scan must not stop
       early: otherwise a small maxElements hides elements that would match the filter. */
    var res = collect(wnd, { maxElements: filter ? Math.max(wanted, 800) : wanted, includeToolbar: bool(args.includeToolbar), icon: false });
    var st = afterState(s);
    var lines = [renderAfter(st)];
    if (w !== top) { lines.push("(showing wnd[" + w + "], the active window is wnd[" + top + "])"); }
    else if (top > 0) { lines.push("Elements of the popup wnd[" + top + "]:"); }
    lines.push("");
    var shown = 0;
    for (var i = 0; i < res.elements.length; i++) {
      var line = renderElement(res.elements[i]);
      if (filter && lower(line).indexOf(filter) < 0) { continue; }
      if (shown >= wanted) { res.truncated = true; break; }
      lines.push(line);
      shown++;
    }
    var ll = listLines(res.listCells, num(args.maxListLines, 80));
    if (ll.length) {
      lines.push("");
      lines.push("List output (" + res.listCells.length + " cells; full list via sap_table kind=list):");
      for (var k = 0; k < ll.length; k++) {
        if (filter && lower(ll[k]).indexOf(filter) < 0) { continue; }
        lines.push("  " + ll[k]);
      }
    }
    if (!shown && !ll.length) { lines.push(filter ? "(no element matches \"" + args.filter + "\")" : "(no elements)"); }
    if (res.truncated) { lines.push("... more elements not shown; narrow down with filter or raise maxElements."); }
    return { text: lines.join("\n"), data: { state: st, window: "wnd[" + w + "]", elements: res.elements, list: ll } };
  };

  /** Resolve a field reference {id} or {label} to an element. */
  function resolveTarget(s, ref, windowIndex, kinds) {
    if (ref.id) { return findElement(s, ref.id, windowIndex); }
    var label = lower(trim(ref.label)).replace(/:$/, "");
    if (!label) { fail("BAD_REQUEST", "Give the element's id (preferred) or its label."); }
    var w = isNil(windowIndex) ? activeWindowIndex(s) : windowIndex;
    var wr = tryCall(s, "findById", ["wnd[" + w + "]"]);
    if (!wr.ok) { fail("NOT_FOUND", "Window wnd[" + w + "] does not exist."); }
    var res = collect(wr.value, { maxElements: 600, includeToolbar: true });
    var exact = [];
    var partial = [];
    for (var i = 0; i < res.elements.length; i++) {
      var e = res.elements[i];
      if (kinds && indexOf(kinds, e.kind) < 0) { continue; }
      var cands = [lower(trim(e.label)).replace(/:$/, ""), lower(trim(e.tooltip)), lower(e.name)];
      var hit = false;
      for (var c = 0; c < cands.length; c++) {
        if (cands[c] && cands[c] === label) { exact.push(e); hit = true; break; }
      }
      if (!hit) {
        for (var d = 0; d < cands.length; d++) {
          if (cands[d] && cands[d].indexOf(label) >= 0) { partial.push(e); break; }
        }
      }
    }
    var pick = exact.length ? exact : partial;
    if (pick.length === 1) { return findElement(s, pick[0].id); }
    if (!pick.length) { fail("NOT_FOUND", "No element labelled \"" + ref.label + "\" in wnd[" + w + "].", "Read the screen with sap_screen and pass the id."); }
    var ids = [];
    for (var k = 0; k < pick.length && k < 8; k++) { ids.push(pick[k].id + " (" + (pick[k].label || pick[k].name) + ")"); }
    fail("AMBIGUOUS", "The label \"" + ref.label + "\" matches " + pick.length + " elements: " + ids.join(", "), "Pass the id instead.");
    return null;
  }

  function setOne(s, f, windowIndex) {
    var el = resolveTarget(s, f, windowIndex, ["input", "output", "password", "combo", "check", "radio", "tab", "textedit"]);
    var t = elType(el);
    var id = relId(el);
    var value = f.value;
    if (t === "GuiOkCodeField") { fail("BAD_REQUEST", "Use sap_transaction to enter OK-codes, not sap_set."); }
    if (t !== "GuiTab" && t !== "GuiRadioButton" && !isNil(prop(el, "changeable")) && !bool(prop(el, "changeable"))) {
      fail("READ_ONLY", "Field " + id + " is not changeable on this screen.", "Switch to change mode or pick another field.");
    }
    if (t === "GuiCheckBox") {
      el.selected = bool(value);
      return { id: id, value: bool(prop(el, "selected")) ? "on" : "off" };
    }
    if (t === "GuiRadioButton") {
      if (isNil(value) || bool(value) || str(value) === "") { el.select(); }
      return { id: id, value: "selected" };
    }
    if (t === "GuiTab") { el.select(); return { id: id, value: "selected" }; }
    if (t === "GuiComboBox") {
      var want = str(value);
      var entries = comboEntries(el, 500);
      var key = null;
      var i;
      for (i = 0; i < entries.length; i++) { if (entries[i].key === want) { key = entries[i].key; break; } }
      if (key === null) {
        for (i = 0; i < entries.length; i++) { if (lower(trim(entries[i].value)) === lower(trim(want))) { key = entries[i].key; break; } }
      }
      if (key === null && entries.length) {
        var opts = [];
        for (i = 0; i < entries.length && i < 25; i++) { opts.push(dq(entries[i].key) + "=" + entries[i].value); }
        fail("BAD_REQUEST", "\"" + want + "\" is not an entry of combo box " + id + ". Entries: " + opts.join(", "));
      }
      el.key = key === null ? want : key;
      return { id: id, value: propStr(el, "value"), key: propStr(el, "key") };
    }
    if (t === "GuiPasswordField") {
      el.text = str(value);
      return { id: id, value: "(hidden)" };
    }
    el.text = str(value);
    var back = prop(el, "text");
    var res = { id: id, value: str(back) };
    if (trim(str(back)) !== trim(str(value)) && lower(trim(str(back))) !== lower(trim(str(value)))) {
      res.note = "SAP shows " + dq(str(back)) + " (input was " + dq(str(value)) + "; check length/format)";
    }
    return res;
  }

  OPS.set = function (args) {
    var s = findSession(args.session);
    waitIdle(s, 30000);
    var fields = args.fields;
    if (!isArray(fields)) {
      if (args.id || args.label) { fields = [{ id: args.id, label: args.label, value: args.value }]; }
      else { fail("BAD_REQUEST", "Pass fields: [{id, value}] (or id/label and value)."); }
    }
    if (!fields.length) { fail("BAD_REQUEST", "fields is empty."); }
    var w = isNil(args.window) || args.window === "" ? null : num(args.window, 0);
    var done = [];
    for (var i = 0; i < fields.length; i++) {
      try {
        done.push(setOne(s, fields[i], w));
      } catch (e) {
        var c = classifyError(e);
        var where = fields[i].id || fields[i].label;
        throw makeError(c.code, "Field " + (i + 1) + " (" + where + "): " + c.message +
          (done.length ? " -- the " + done.length + " field(s) before it were set." : ""), c.hint);
      }
    }
    var lines = [];
    for (var k = 0; k < done.length; k++) {
      lines.push("set " + done[k].id + " = " + dq(done[k].value) + (done[k].note ? "  !! " + done[k].note : ""));
    }
    if (bool(args.enter)) {
      var wi = activeWindowIndex(s);
      s.findById("wnd[" + wi + "]").sendVKey(0);
      lines.push("pressed Enter");
    }
    var st = afterState(s);
    lines.push(renderAfter(st));
    return { text: lines.join("\n"), data: { fields: done, state: st } };
  };

  var VKEYS = {
    "enter": 0, "f1": 1, "f2": 2, "f3": 3, "f4": 4, "f5": 5, "f6": 6, "f7": 7, "f8": 8, "f9": 9,
    "f10": 10, "f11": 11, "f12": 12, "back": 3, "exit": 15, "cancel": 12, "escape": 12, "esc": 12,
    "save": 11, "ctrl+s": 11, "execute": 8, "help": 1, "f4help": 4, "valuehelp": 4, "doubleclick": 2,
    "pageup": 81, "pagedown": 82, "page up": 81, "page down": 82, "firstpage": 80, "lastpage": 83,
    "ctrl+pageup": 80, "ctrl+pagedown": 83, "ctrl+f": 71, "find": 71, "ctrl+g": 84, "findnext": 84,
    "ctrl+p": 86, "print": 86
  };
  (function () {
    for (var i = 1; i <= 12; i++) {
      VKEYS["shift+f" + i] = 12 + i;
      VKEYS["ctrl+f" + i] = 24 + i;
      VKEYS["ctrl+shift+f" + i] = 36 + i;
    }
  })();

  function vkeyOf(key) {
    if (typeof key === "number") { return key; }
    var k = lower(trim(key)).replace(/\s*\+\s*/g, "+").replace(/^strg\+/, "ctrl+").replace(/^umsch\+/, "shift+");
    if (/^\d+$/.test(k)) { return num(k, 0); }
    if (has(VKEYS, k)) { return VKEYS[k]; }
    fail("BAD_REQUEST", "Unknown key \"" + key + "\".", "Use Enter, F1-F12, Shift+F1..F12, Ctrl+F1..F12, Ctrl+S, PageUp, PageDown, Back, Cancel, or a VKey number.");
    return 0;
  }

  OPS.key = function (args) {
    var s = findSession(args.session);
    /* noWait: keys that open a modal dialog (ABAP Debugger, "save changes?") make SAP GUI
       block until the dialog is answered, so the caller opts out of waiting and idle
       detection altogether and reads the screen afterwards. */
    var noWait = bool(args.noWait);
    if (!noWait) { waitIdle(s, 30000); }
    var vk = vkeyOf(isNil(args.key) ? "enter" : args.key);
    var w = isNil(args.window) || args.window === "" ? activeWindowIndex(s) : num(args.window, 0);
    var wnd = s.findById("wnd[" + w + "]");
    var allowed = tryCall(wnd, "isVKeyAllowed", [vk]);
    if (allowed.ok && !bool(allowed.value) && vk !== 0) {
      fail("NOT_ALLOWED", "Key " + str(args.key) + " (VKey " + vk + ") is not active on this screen.", "Read the screen for the available buttons.");
    }
    if (!isNil(args.focus) && args.focus !== "") { findElement(s, args.focus, w).setFocus(); }
    wnd.sendVKey(vk);
    if (noWait) {
      return { text: "sent " + str(args.key || "Enter") + " (VKey " + vk + ") to wnd[" + w + "] without waiting; read the next screen with sap_screen\n",
        data: { vkey: vk, noWait: true } };
    }
    var st = afterState(s);
    return { text: "sent " + str(args.key || "Enter") + " (VKey " + vk + ") to wnd[" + w + "]\n" + renderAfter(st), data: { vkey: vk, state: st } };
  };

  OPS.press = function (args) {
    var s = findSession(args.session);
    waitIdle(s, 30000);
    var w = isNil(args.window) || args.window === "" ? null : num(args.window, 0);
    var el = resolveTarget(s, { id: args.id, label: args.label }, w, args.id ? null : ["button", "tab", "check", "radio", "text", "output", "input"]);
    var t = elType(el);
    var id = relId(el);
    var action = lower(args.action || "auto");
    var did;
    if (action === "doubleclick" || action === "f2") {
      el.setFocus();
      var wi = /^wnd\[(\d+)\]/.exec(id);
      s.findById("wnd[" + (wi ? wi[1] : 0) + "]").sendVKey(2);
      did = "double-clicked";
    } else if (action === "focus") {
      el.setFocus();
      did = "focused";
    } else if (action === "f4") {
      el.setFocus();
      var wj = /^wnd\[(\d+)\]/.exec(id);
      s.findById("wnd[" + (wj ? wj[1] : 0) + "]").sendVKey(4);
      did = "opened value help (F4) for";
    } else if (t === "GuiButton") {
      el.press();
      did = "pressed";
    } else if (t === "GuiTab" || t === "GuiRadioButton" || t === "GuiMenu" || t === "GuiContextMenu") {
      el.select();
      did = "selected";
    } else if (t === "GuiCheckBox") {
      el.selected = !bool(prop(el, "selected"));
      did = "toggled";
    } else if (t === "GuiLabel" || t === "GuiTextField" || t === "GuiCTextField") {
      el.setFocus();
      var wk = /^wnd\[(\d+)\]/.exec(id);
      s.findById("wnd[" + (wk ? wk[1] : 0) + "]").sendVKey(2);
      did = "double-clicked";
    } else {
      var pr = tryCall(el, "press");
      if (!pr.ok) {
        var sr = tryCall(el, "select");
        if (!sr.ok) { fail("BAD_REQUEST", "Element " + id + " (" + t + ") cannot be pressed.", "For grids, trees and tables use sap_table_action."); }
        did = "selected";
      } else { did = "pressed"; }
    }
    var st = afterState(s);
    return { text: did + " " + id + "\n" + renderAfter(st), data: { id: id, type: t, state: st } };
  };

  function menuItems(container, depth) {
    var out = [];
    var kids = collToArray(children(container), 80);
    for (var i = 0; i < kids.length; i++) {
      var m = kids[i];
      var text = trim(propStr(m, "text"));
      if (!text) { continue; }
      var item = { text: text, id: relId(m) };
      if (depth > 0) {
        var sub = menuItems(m, depth - 1);
        if (sub.length) { item.items = sub; }
      }
      out.push(item);
    }
    return out;
  }
  function normMenuText(s) { return lower(trim(s)).replace(/&/g, "").replace(/\.\.\.$|\u2026$/, "").replace(/\s+/g, " "); }

  OPS.menu = function (args) {
    var s = findSession(args.session);
    waitIdle(s, 30000);
    var w = isNil(args.window) || args.window === "" ? 0 : num(args.window, 0);
    var mbar = findElement(s, "mbar", w);
    var path = args.path;
    if (typeof path === "string") { path = path.split(/\s*(?:>|\/|\\)\s*/); }
    if (!isArray(path) || !path.length) {
      var items = menuItems(mbar, num(args.depth, 1));
      var lines = [];
      for (var i = 0; i < items.length; i++) {
        lines.push(items[i].text);
        var sub = items[i].items || [];
        for (var j = 0; j < sub.length; j++) { lines.push("  " + sub[j].text); }
      }
      return { text: "Menu of wnd[" + w + "]:\n" + lines.join("\n"), data: items };
    }
    var node = mbar;
    var trail = [];
    for (var p = 0; p < path.length; p++) {
      var want = normMenuText(path[p]);
      var kids = collToArray(children(node), 80);
      var found = null;
      var k;
      for (k = 0; k < kids.length; k++) { if (normMenuText(propStr(kids[k], "text")) === want) { found = kids[k]; break; } }
      if (!found) { for (k = 0; k < kids.length; k++) { if (normMenuText(propStr(kids[k], "text")).indexOf(want) === 0) { found = kids[k]; break; } } }
      if (!found) {
        var avail = [];
        for (k = 0; k < kids.length; k++) { if (trim(propStr(kids[k], "text"))) { avail.push(trim(propStr(kids[k], "text"))); } }
        fail("NOT_FOUND", "Menu entry \"" + path[p] + "\" not found" + (trail.length ? " under " + trail.join(" > ") : "") +
          ". Available: " + avail.join(", "));
      }
      trail.push(trim(propStr(found, "text")));
      node = found;
    }
    node.select();
    var st = afterState(s);
    return { text: "selected menu " + trail.join(" > ") + "\n" + renderAfter(st), data: { path: trail, state: st } };
  };

  var NEGATIVE_BUTTON = /^(no|nein|cancel|abbrechen|zur(u|\u00fc)ck|back|close|schlie(ss|\u00df)en|exit|beenden|ignore)$/i;
  var NEGATIVE_ID = /(SPOP-OPTION2|SPOP-OPTION_CAN|BUTTON_2|btn\[12\]|btn\[15\])$/;

  function popupButtonFor(pop, choice) {
    var c = lower(trim(choice));
    var i, b;
    for (i = 0; i < pop.buttons.length; i++) {
      b = pop.buttons[i];
      if (lower(b.id) === c || endsWith(lower(b.id), c) || lower(trim(b.label)) === c || lower(trim(b.tooltip)) === c) { return b; }
    }
    for (i = 0; i < pop.buttons.length; i++) {
      b = pop.buttons[i];
      if ((b.label && lower(b.label).indexOf(c) >= 0) || (b.tooltip && lower(b.tooltip).indexOf(c) >= 0)) { return b; }
    }
    return null;
  }

  OPS.popup = function (args) {
    var s = findSession(args.session);
    waitIdle(s, 30000);
    var top = activeWindowIndex(s);
    var action = lower(args.action || "read");
    if (top === 0) {
      if (action === "read") { return { text: "No popup is open.\n" + renderAfter(afterState(s)), data: null }; }
      fail("NO_POPUP", "No popup is open.", "Read the screen with sap_screen.");
    }
    var pop = popupSummary(s, top);
    if (action === "read") { return { text: renderAfter(afterState(s)), data: pop }; }
    var wnd = s.findById("wnd[" + top + "]");
    var did;
    if (action === "cancel") {
      var cb = null;
      for (var i = 0; i < pop.buttons.length; i++) {
        if (NEGATIVE_ID.test(pop.buttons[i].id) && /OPTION_CAN|btn\[12\]/.test(pop.buttons[i].id)) { cb = pop.buttons[i]; break; }
      }
      if (cb) { s.findById(cb.id).press(); did = "pressed " + (cb.label || cb.tooltip || cb.id); }
      else { wnd.sendVKey(12); did = "cancelled (F12)"; }
    } else if (action === "confirm") {
      var yes = null;
      var prefs = [/SPOP-OPTION1$/, /BUTTON_1$/, /tbar\[0\]\/btn\[0\]$/];
      for (var p = 0; p < prefs.length && !yes; p++) {
        for (var j = 0; j < pop.buttons.length; j++) { if (prefs[p].test(pop.buttons[j].id)) { yes = pop.buttons[j]; break; } }
      }
      if (yes) { s.findById(yes.id).press(); did = "pressed " + (yes.label || yes.tooltip || yes.id); }
      else { wnd.sendVKey(0); did = "confirmed (Enter)"; }
    } else if (action === "press") {
      var b = popupButtonFor(pop, args.button);
      if (!b) {
        var names = [];
        for (var k = 0; k < pop.buttons.length; k++) { names.push((pop.buttons[k].label || pop.buttons[k].tooltip || "?") + "=" + pop.buttons[k].id); }
        fail("NOT_FOUND", "Popup has no button \"" + str(args.button) + "\". Buttons: " + names.join("; "));
      }
      s.findById(b.id).press();
      did = "pressed " + (b.label || b.tooltip || b.id);
    } else {
      fail("BAD_REQUEST", "action must be read, confirm, cancel or press.");
    }
    var st = afterState(s);
    return { text: did + " in popup \"" + pop.title + "\"\n" + renderAfter(st), data: { popup: pop, state: st } };
  };

  function tcodeCommand(args) {
    if (!isNil(args.command) && trim(args.command) !== "") { return trim(args.command); }
    var t = trim(args.tcode);
    if (!t) { fail("BAD_REQUEST", "Pass tcode (e.g. MM03) or command."); }
    var m = /^\/([nNoO])\s*(.+)$/.exec(t);
    var mode = bool(args.newSession) ? "o" : "n";
    if (m) { mode = lower(m[1]); t = m[2]; }
    if (!/^[A-Za-z0-9_\/*]{1,40}$/.test(t)) { fail("BAD_REQUEST", "Not a transaction code: " + t, "Use command for raw OK-codes."); }
    return "/" + mode + t.toUpperCase();
  }

  OPS.transaction = function (args) {
    var s = findSession(args.session);
    waitIdle(s, 30000);
    var cmd = tcodeCommand(args);
    var top = activeWindowIndex(s);
    if (top > 0) {
      var pop = popupSummary(s, top);
      fail("POPUP_OPEN", "Popup \"" + (pop ? pop.title : "") + "\" (wnd[" + top + "]) is open; handle it first with sap_popup.");
    }
    var okcd = findElement(s, "wnd[0]/tbar[0]/okcd");
    okcd.text = cmd;
    s.findById("wnd[0]").sendVKey(0);
    var st = afterState(s);
    var warn = "";
    if (st.status && st.status.type === "E") { warn = "\n!! SAP reported an error -- the transaction may not have started."; }
    return { text: "entered " + cmd + "\n" + renderAfter(st) + warn, data: { command: cmd, state: st } };
  };

  /* ---------------- tables, grids, trees, lists ---------------- */

  function tableKind(el) {
    var t = elType(el);
    var sub = shellSubType(el);
    if (t === "GuiTableControl") { return "table"; }
    if (t === "GuiGridView" || sub === "GridView") { return "grid"; }
    if (t === "GuiShell" && shellActsAsGrid(el)) { return "grid"; }
    if (t === "GuiTree" || sub === "Tree") { return "tree"; }
    if (t === "GuiTextedit" || sub === "TextEdit") { return "textedit"; }
    if (t === "GuiAbapEditor" || sub === "AbapEditor") { return "editor"; }
    return "";
  }

  function firstTable(s, w) {
    var wr = tryCall(s, "findById", ["wnd[" + w + "]"]);
    if (!wr.ok) { return null; }
    var res = collect(wr.value, { maxElements: 800, includeToolbar: false });
    for (var i = 0; i < res.elements.length; i++) {
      var k = res.elements[i].kind;
      if (k === "grid" || k === "table" || k === "tree") { return findElement(s, res.elements[i].id); }
    }
    return null;
  }

  function gridColumns(grid) {
    var cols = [];
    var order = collToArray(prop(grid, "columnOrder"), 300);
    for (var i = 0; i < order.length; i++) {
      var name = str(order[i]);
      var title = "";
      var r = tryCall(grid, "getDisplayedColumnTitle", [name]);
      if (r.ok) { title = str(r.value); }
      if (!title) {
        r = tryCall(grid, "getColumnTitles", [name]);
        if (r.ok && !isNil(r.value)) { title = str(collItem(r.value, 0)); }
      }
      cols.push({ name: name, title: trim(title) || name });
    }
    return cols;
  }

  function readGrid(grid, args) {
    var cols = gridColumns(grid);
    var want = args.columns;
    if (typeof want === "string" && want) { want = want.split(/\s*,\s*/); }
    if (isArray(want) && want.length) {
      var filtered = [];
      for (var i = 0; i < cols.length; i++) {
        for (var w = 0; w < want.length; w++) {
          if (lower(want[w]) === lower(cols[i].name) || lower(want[w]) === lower(cols[i].title)) { filtered.push(cols[i]); break; }
        }
      }
      cols = filtered;
    }
    var total = num(prop(grid, "rowCount"), 0);
    var start = Math.max(0, num(args.startRow, 0));
    var max = Math.min(num(args.maxRows, 100), 1000);
    var end = Math.min(total, start + max);
    var visible = Math.max(1, num(prop(grid, "visibleRowCount"), 1));
    var originalFirst = num(prop(grid, "firstVisibleRow"), 0);
    var rows = [];
    var stoppedAt = null;
    var r = start;
    while (r < end) {
      var windowEnd;
      try {
        grid.firstVisibleRow = r;
        windowEnd = Math.min(r + visible, end);
      } catch (e) {
        var shown = num(prop(grid, "firstVisibleRow"), 0);
        if (!(shown <= r && r < shown + visible)) { stoppedAt = r; break; }
        windowEnd = Math.min(shown + visible, end);
      }
      for (var row = r; row < windowEnd; row++) {
        var vals = [];
        for (var c = 0; c < cols.length; c++) {
          var cv = tryCall(grid, "getCellValue", [row, cols[c].name]);
          vals.push(cv.ok ? str(cv.value) : "");
        }
        rows.push(vals);
      }
      r = windowEnd;
    }
    try { grid.firstVisibleRow = originalFirst; } catch (e2) { /* read-only scripting */ }
    var out = { kind: "grid", id: relId(grid), rowCount: total, startRow: start, columns: cols, rows: rows,
      selectedRows: propStr(grid, "selectedRows") };
    if (stoppedAt !== null) { out.stoppedAt = stoppedAt; out.note = "The grid would not scroll (read-only scripting?); rows from " + stoppedAt + " were not read."; }
    if (start + rows.length < total && stoppedAt === null) { out.nextStartRow = start + rows.length; }
    if (bool(args.toolbar) || isNil(args.toolbar)) { out.toolbar = toolbarButtons(grid, "grid"); }
    return out;
  }

  function tableControlColumns(tbl) {
    var cols = [];
    var cc = prop(tbl, "columns");
    var n = collCount(cc);
    for (var i = 0; i < n; i++) {
      var col = collItem(cc, i);
      var title = trim(propStr(col, "title"));
      var name = "";
      var cell = tryCall(tbl, "getCell", [0, i]);
      if (cell.ok && !isNil(cell.value)) { name = propStr(cell.value, "name"); }
      cols.push({ index: i, name: name || title || ("col" + i), title: title || name });
    }
    return cols;
  }

  function cellText(cell) {
    var t = elType(cell);
    if (t === "GuiCheckBox") { return bool(prop(cell, "selected")) ? "X" : ""; }
    if (t === "GuiComboBox") { return propStr(cell, "value"); }
    if (t === "GuiPasswordField") { return ""; }
    return propStr(cell, "text");
  }

  function readTableControl(s, tbl, args) {
    var id = relId(tbl);
    var cols = tableControlColumns(tbl);
    var total = num(prop(tbl, "rowCount"), 0);
    var visible = num(prop(tbl, "visibleRowCount"), 0);
    var max = Math.min(num(args.maxRows, 100), 1000);
    var sb = prop(tbl, "verticalScrollbar");
    var originalPos = num(prop(sb, "position"), 0);
    var pos = isNil(args.startRow) || args.startRow === "" ? originalPos : Math.max(0, num(args.startRow, 0));
    var rows = [];
    var padFrom = null;
    var scrolled = false;
    var note = "";
    while (rows.length < max && pos < total) {
      if (num(prop(sb, "position"), 0) !== pos) {
        try {
          sb.position = pos;
          scrolled = true;
          waitIdle(s, 15000);
          tbl = s.findById(id);
          sb = prop(tbl, "verticalScrollbar");
        } catch (e) { note = "Could not scroll the table control: " + errText(e); break; }
      }
      var actual = num(prop(sb, "position"), pos);
      var vis = num(prop(tbl, "visibleRowCount"), visible);
      if (vis < 1) { break; }
      var emptyRow = false;
      for (var v = 0; v < vis && rows.length < max; v++) {
        var abs = actual + v;
        if (abs >= total) { break; }
        var vals = [];
        var blank = true;
        for (var c = 0; c < cols.length; c++) {
          var cr = tryCall(tbl, "getCell", [v, c]);
          var tx = cr.ok && !isNil(cr.value) ? cellText(cr.value) : "";
          if (trim(tx)) { blank = false; }
          vals.push(tx);
        }
        if (blank) { emptyRow = true; padFrom = abs; break; }
        rows.push({ row: abs, values: vals });
      }
      if (emptyRow) { break; }
      if (vis <= 0) { break; }
      pos = actual + vis;
      if (!bool(args.scroll) && isNil(args.startRow)) { break; }
    }
    if (scrolled && !bool(args.keepScroll)) {
      try { tbl = s.findById(id); prop(tbl, "verticalScrollbar").position = originalPos; waitIdle(s, 15000); } catch (e2) { /* ignore */ }
    }
    var out = { kind: "table", id: relId(tbl), rowCount: total, visibleRowCount: visible, columns: cols, rows: [] };
    var plain = [];
    var firstRow = rows.length ? rows[0].row : pos;
    for (var r = 0; r < rows.length; r++) { plain.push(rows[r].values); }
    out.rows = plain;
    out.startRow = firstRow;
    if (padFrom !== null) { out.dataEndsAt = padFrom; }
    else if (firstRow + plain.length < total) { out.nextStartRow = firstRow + plain.length; }
    if (note) { out.note = note; }
    return out;
  }

  function readTree(tree, args) {
    var max = Math.min(num(args.maxRows, 200), 2000);
    var keys = collToArray(tryCall(tree, "getAllNodeKeys").value, max + 1);
    var colNames = [];
    var cn = tryCall(tree, "getColumnNames");
    if (cn.ok && !isNil(cn.value)) { colNames = collToArray(cn.value, 30); }
    var nodes = [];
    for (var i = 0; i < keys.length && i < max; i++) {
      var k = str(keys[i]);
      var n = { key: k };
      var t = tryCall(tree, "getNodeTextByKey", [k]);
      n.text = t.ok ? str(t.value) : "";
      var lv = tryCall(tree, "getHierarchyLevel", [k]);
      if (lv.ok) { n.level = num(lv.value, 0); }
      var fo = tryCall(tree, "isFolder", [k]);
      if (fo.ok && bool(fo.value)) {
        n.folder = true;
        var ex = tryCall(tree, "isFolderExpanded", [k]);
        if (ex.ok) { n.expanded = bool(ex.value); }
      }
      if (colNames.length) {
        n.items = {};
        for (var c = 0; c < colNames.length; c++) {
          var it = tryCall(tree, "getItemText", [k, str(colNames[c])]);
          if (it.ok && trim(str(it.value))) { n.items[str(colNames[c])] = str(it.value); }
        }
      }
      nodes.push(n);
    }
    var sel = tryCall(tree, "getSelectedNodes");
    var out = { kind: "tree", id: relId(tree), nodeCount: keys.length > max ? max + "+" : keys.length, columns: colNames, nodes: nodes };
    if (sel.ok && !isNil(sel.value)) { out.selected = collToArray(sel.value, 50); }
    return out;
  }

  function renderTable(t) {
    var lines = [];
    var i, j;
    if (t.kind === "tree") {
      lines.push("Tree " + t.id + " (" + t.nodeCount + " nodes)");
      for (i = 0; i < t.nodes.length; i++) {
        var n = t.nodes[i];
        var ind = "";
        for (j = 0; j < (n.level || 0); j++) { ind += "  "; }
        var extra = [];
        if (n.items) { for (var k in n.items) { if (has(n.items, k)) { extra.push(k + "=" + n.items[k]); } } }
        lines.push(ind + (n.folder ? (n.expanded ? "v " : "> ") : "- ") + n.text + "  [key " + n.key + "]" + (extra.length ? "  " + extra.join(" | ") : ""));
      }
      return lines.join("\n");
    }
    if (t.kind === "list") {
      lines.push("List output (" + t.lines.length + " lines" + (t.pages > 1 ? ", " + t.pages + " pages" : "") + "):");
      for (i = 0; i < t.lines.length; i++) { lines.push(t.lines[i]); }
      return lines.join("\n");
    }
    if (t.kind === "textedit") { return "Text of " + t.id + ":\n" + t.text; }
    var head = [];
    for (i = 0; i < t.columns.length; i++) { head.push(t.columns[i].title + (t.columns[i].title !== t.columns[i].name ? " (" + t.columns[i].name + ")" : "")); }
    lines.push((t.kind === "grid" ? "ALV grid " : "Table control ") + t.id + ": " + t.rowCount + " rows; showing rows " + t.startRow +
      "-" + (t.startRow + t.rows.length - 1 < t.startRow ? t.startRow : t.startRow + t.rows.length - 1));
    lines.push("# | " + head.join(" | "));
    for (i = 0; i < t.rows.length; i++) {
      var cells = [];
      for (j = 0; j < t.rows[i].length; j++) { cells.push(str(t.rows[i][j]).replace(/\|/g, "/").replace(/\s+$/, "")); }
      lines.push((t.startRow + i) + " | " + cells.join(" | "));
    }
    if (t.nextStartRow !== undefined) { lines.push("... more rows: call again with startRow=" + t.nextStartRow); }
    if (t.dataEndsAt !== undefined) { lines.push("(data ends at row " + t.dataEndsAt + "; the rest are empty padding rows)"); }
    if (t.note) { lines.push("!! " + t.note); }
    if (t.selectedRows) { lines.push("selected rows: " + t.selectedRows); }
    if (t.toolbar && t.toolbar.length) {
      var bs = [];
      for (i = 0; i < t.toolbar.length && i < 40; i++) {
        var b = t.toolbar[i];
        bs.push((b.text || b.tooltip || b.id) + "=" + b.id + (b.type && b.type !== "Button" ? "(" + b.type + ")" : "") + (b.enabled === false ? "(disabled)" : ""));
      }
      lines.push("toolbar: " + bs.join("; "));
    }
    return lines.join("\n");
  }

  OPS.table = function (args) {
    var s = findSession(args.session);
    waitIdle(s, 30000);
    var kind = lower(args.kind || "");
    var w = isNil(args.window) || args.window === "" ? activeWindowIndex(s) : num(args.window, 0);
    if (kind === "list") {
      var pages = Math.max(1, Math.min(num(args.pages, 1), 50));
      var all = [];
      var got = 0;
      for (var p = 0; p < pages; p++) {
        var wr = s.findById("wnd[" + w + "]");
        var res = collect(wr, { maxElements: 4000 });
        var ll = listLines(res.listCells, 2000);
        if (p > 0 && ll.length && all.length && ll[ll.length - 1] === all[all.length - 1]) { break; }
        for (var i = 0; i < ll.length; i++) { all.push(ll[i]); }
        got++;
        if (p < pages - 1) {
          var allowed = tryCall(wr, "isVKeyAllowed", [82]);
          if (allowed.ok && !bool(allowed.value)) { break; }
          wr.sendVKey(82);
          waitIdle(s, 30000);
        }
      }
      var lt = { kind: "list", lines: all, pages: got };
      return { text: renderTable(lt), data: lt };
    }
    var el = args.id ? findElement(s, args.id, w) : firstTable(s, w);
    if (!el) { fail("NOT_FOUND", "No table, grid or tree on wnd[" + w + "].", "For classic report output use kind=list."); }
    var k = tableKind(el);
    var t;
    if (k === "grid") { t = readGrid(el, args); }
    else if (k === "table") { t = readTableControl(s, el, args); }
    else if (k === "tree") { t = readTree(el, args); }
    else if (k === "textedit" || k === "editor") {
      var txt = propStr(el, "text");
      if (!txt && k === "editor") {
        var lc = num(prop(el, "lineCount"), 0);
        var buf = [];
        for (var li = 1; li <= lc && li <= 5000; li++) { var lr = tryCall(el, "getLineText", [li]); if (lr.ok) { buf.push(str(lr.value)); } }
        txt = buf.join("\n");
      }
      t = { kind: "textedit", id: relId(el), text: txt };
    } else { fail("BAD_REQUEST", "Element " + relId(el) + " (" + elType(el) + ") is not a table, grid, tree or text control."); }
    return { text: renderTable(t), data: t };
  };

  OPS.table_action = function (args) {
    var s = findSession(args.session);
    waitIdle(s, 30000);
    var w = isNil(args.window) || args.window === "" ? activeWindowIndex(s) : num(args.window, 0);
    var el = args.id ? findElement(s, args.id, w) : firstTable(s, w);
    if (!el) { fail("NOT_FOUND", "No table, grid or tree on wnd[" + w + "]."); }
    var k = tableKind(el);
    var a = lower(args.action);
    var row = num(args.row, -1);
    var col = str(args.column);
    var did = a;
    var menu = null;
    function needRow() { if (row < 0) { fail("BAD_REQUEST", "action " + a + " needs row (0-based)."); } }
    if (k === "grid") {
      if (a === "selectrows") { el.selectedRows = str(isNil(args.rows) ? row : args.rows); did = "selected rows " + str(isNil(args.rows) ? row : args.rows); }
      else if (a === "selectall") { el.selectAll(); did = "selected all rows"; }
      else if (a === "clearselection") { el.clearSelection(); did = "cleared the selection"; }
      else if (a === "doubleclick" || a === "click" || a === "currentcell") {
        needRow();
        el.setCurrentCell(row, col || str(collItem(prop(el, "columnOrder"), 0)));
        if (a === "doubleclick") { el.doubleClickCurrentCell(); did = "double-clicked row " + row + " " + col; }
        else if (a === "click") { el.clickCurrentCell(); did = "clicked row " + row + " " + col; }
        else { did = "set current cell to row " + row + " " + col; }
      } else if (a === "setcell") {
        needRow();
        if (!col) { fail("BAD_REQUEST", "setCell needs column."); }
        el.modifyCell(row, col, str(args.value));
        did = "set cell row " + row + " " + col + " = " + dq(str(args.value));
      } else if (a === "presstoolbar") {
        var bid = str(args.button);
        var btype = "";
        var bl = toolbarButtons(el, "grid");
        for (var i = 0; i < bl.length; i++) { if (bl[i].id === bid) { btype = bl[i].type; } }
        if (btype === "Menu" || btype === "ButtonAndMenu") {
          el.pressToolbarContextButton(bid);
          menu = contextMenuItems(el);
          did = "opened toolbar menu " + bid;
        } else { el.pressToolbarButton(bid); did = "pressed toolbar button " + bid; }
      } else if (a === "contextmenu") {
        if (row >= 0) { el.setCurrentCell(row, col || str(collItem(prop(el, "columnOrder"), 0))); }
        el.contextMenu();
        menu = contextMenuItems(el);
        did = "opened context menu";
      } else if (a === "selectmenuitem") {
        var item = str(args.item);
        var rr = tryCall(el, "selectContextMenuItem", [item]);
        if (!rr.ok) { rr = tryCall(el, "selectContextMenuItemByText", [item]); }
        if (!rr.ok) { throw rr.error; }
        did = "selected menu item " + item;
      } else if (a === "selectcolumn") { el.selectColumn(col); did = "selected column " + col; }
      else if (a === "pressheader") { el.pressColumnHeader(col); did = "pressed column header " + col; }
      else { fail("BAD_REQUEST", "Unknown grid action " + args.action + "."); }
    } else if (k === "table") {
      if (a === "selectrows" || a === "selectrow") { needRow(); el.getAbsoluteRow(row).selected = true; did = "selected row " + row; }
      else if (a === "deselectrow") { needRow(); el.getAbsoluteRow(row).selected = false; did = "deselected row " + row; }
      else if (a === "scroll") { prop(el, "verticalScrollbar").position = Math.max(0, row); did = "scrolled to row " + row; }
      else if (a === "doubleclick" || a === "setcell" || a === "currentcell") {
        needRow();
        var sb = prop(el, "verticalScrollbar");
        var top = num(prop(sb, "position"), 0);
        var vis = num(prop(el, "visibleRowCount"), 0);
        var tid = propStr(el, "id");
        if (row < top || row >= top + vis) { sb.position = row; waitIdle(s, 15000); el = s.findById(tid); top = num(prop(prop(el, "verticalScrollbar"), "position"), row); }
        var cols = tableControlColumns(el);
        var ci = -1;
        for (var c = 0; c < cols.length; c++) { if (lower(cols[c].name) === lower(col) || lower(cols[c].title) === lower(col) || str(c) === col) { ci = c; break; } }
        if (ci < 0) { fail("BAD_REQUEST", "Column " + col + " not found. Columns: " + (function () { var n = []; for (var q = 0; q < cols.length; q++) { n.push(cols[q].name); } return n.join(", "); })()); }
        var cell = el.getCell(row - top, ci);
        if (a === "setcell") { cell.text = str(args.value); did = "set row " + row + " " + cols[ci].name + " = " + dq(str(args.value)); }
        else { cell.setFocus(); if (a === "doubleclick") { s.findById("wnd[" + w + "]").sendVKey(2); did = "double-clicked row " + row + " " + cols[ci].name; } else { did = "focused row " + row + " " + cols[ci].name; } }
      } else { fail("BAD_REQUEST", "Unknown table control action " + args.action + "."); }
    } else if (k === "tree") {
      var key = str(args.node);
      if (!key && a !== "selectmenuitem") { fail("BAD_REQUEST", "Tree actions need node (the key from sap_table)."); }
      if (a === "expand") { el.expandNode(key); did = "expanded " + key; }
      else if (a === "collapse") { el.collapseNode(key); did = "collapsed " + key; }
      else if (a === "select") { el.selectNode(key); did = "selected " + key; }
      else if (a === "doubleclick") {
        if (col) { el.doubleClickItem(key, col); } else { el.doubleClickNode(key); }
        did = "double-clicked " + key;
      } else if (a === "click" || a === "clicklink") { el.clickLink(key, col); did = "clicked " + key + " " + col; }
      else if (a === "pressbutton") { el.pressButton(key, col); did = "pressed button " + key + " " + col; }
      else if (a === "check") { el.changeCheckbox(key, col, bool(isNil(args.value) ? true : args.value)); did = "changed checkbox " + key; }
      else if (a === "contextmenu") { el.nodeContextMenu(key); menu = contextMenuItems(el); did = "opened context menu of " + key; }
      else if (a === "selectmenuitem") { el.selectContextMenuItem(str(args.item)); did = "selected menu item " + str(args.item); }
      else { fail("BAD_REQUEST", "Unknown tree action " + args.action + "."); }
    } else {
      fail("BAD_REQUEST", "Element " + relId(el) + " is not a grid, table control or tree.");
    }
    var st = afterState(s);
    var text = did + "\n";
    if (menu && menu.length) {
      var ms = [];
      for (var m = 0; m < menu.length; m++) { ms.push(menu[m].text + "=" + menu[m].code); }
      text += "menu items (pick with action selectMenuItem, item=<code>): " + ms.join("; ") + "\n";
    }
    return { text: text + renderAfter(st), data: { action: a, menu: menu, state: st } };
  };

  function contextMenuItems(shell) {
    var menu = prop(shell, "currentContextMenu");
    if (isNil(menu)) { return []; }
    var out = [];
    var kids = collToArray(children(menu), 80);
    for (var i = 0; i < kids.length; i++) {
      var text = trim(propStr(kids[i], "text"));
      if (!text) { continue; }
      out.push({ text: text, code: propStr(kids[i], "name") });
    }
    return out;
  }

  /* ---------------- login ---------------- */

  function openConnection(a, args) {
    var r;
    if (args.connection) {
      r = tryCall(a, "openConnection", [str(args.connection), true]);
      if (!r.ok) { r = tryCall(a, "openConnection", [str(args.connection)]); }
      if (r.ok && !isNil(r.value)) { return r.value; }
      if (!args.connectionString) {
        fail("CONNECT_FAILED", "Could not open the SAP Logon entry \"" + args.connection + "\": " + (r.error ? errText(r.error) : "no connection returned"),
          "The name must match the entry in SAP Logon exactly (description, not the SID).");
      }
    }
    if (args.connectionString) {
      var cs = str(args.connectionString);
      r = tryCall(a, "openConnectionByConnectionString", [cs, true]);
      if (!r.ok) { r = tryCall(a, "openConnectionByConnectionString", [cs]); }
      if ((!r.ok || isNil(r.value)) && HOST.kind === "java" && !/^conn=/.test(cs)) {
        r = tryCall(a, "openConnectionByConnectionString", ["conn=" + cs]);
      }
      if (r.ok && !isNil(r.value)) { return r.value; }
      fail("CONNECT_FAILED", "Could not open connection " + cs + ": " + (r.error ? errText(r.error) : "no connection returned"),
        "Check host, instance number and SAProuter string, and that you are on the VPN.");
    }
    fail("BAD_REQUEST", "The system needs connection (SAP Logon entry) or connectionString.");
    return null;
  }

  function exists(s, id) { var r = tryCall(s, "findById", [id]); return r.ok && !isNil(r.value); }

  OPS.login = function (args) {
    var a = app();
    var conn = null;
    var s = null;
    if (args.session) {
      s = findSession(args.session);
    } else {
      conn = openConnection(a, args);
      var t0 = now();
      while (now() - t0 < 30000) {
        var ss = children(conn);
        if (collCount(ss) > 0) { s = collItem(ss, 0); break; }
        sleep(200);
      }
      if (!s) { fail("TIMEOUT", "The connection opened but no session appeared within 30 seconds."); }
    }
    waitIdle(s, 30000);
    var steps = [];
    if (exists(s, "wnd[0]/usr/txtRSYST-BNAME")) {
      if (bool(prop(conn ? conn : prop(s, "parent"), "disabledByServer"))) {
        fail("SCRIPTING_DISABLED", "The server does not allow scripting on this system.", "Ask Basis to set sapgui/user_scripting = TRUE (RZ11).");
      }
      if (args.client) { s.findById("wnd[0]/usr/txtRSYST-MANDT").text = str(args.client); }
      if (args.user) { s.findById("wnd[0]/usr/txtRSYST-BNAME").text = str(args.user); }
      if (!isNil(args.password)) { s.findById("wnd[0]/usr/pwdRSYST-BCODE").text = str(args.password); }
      if (args.language && exists(s, "wnd[0]/usr/txtRSYST-LANGU")) { s.findById("wnd[0]/usr/txtRSYST-LANGU").text = str(args.language); }
      if (isNil(args.password) && !bool(args.submitWithoutPassword)) {
        /* No stored secret: leave the password field alone and hand the screen to the person.
           Submitting an empty password would only produce an SAP error and burn a logon attempt. */
        var filled = [];
        if (args.client) { filled.push("client " + str(args.client)); }
        if (args.user) { filled.push("user " + str(args.user)); }
        if (args.language) { filled.push("language " + str(args.language)); }
        var prepInfo = sessionInfo(s);
        return {
          text: "Logon screen prepared" + (filled.length ? " (" + filled.join(", ") + ")" : "") +
            ". SAP GUI is waiting for the password: type it in the window and press Enter, then call sap_sessions.",
          data: { session: prepInfo.id, info: prepInfo, prepared: true, state: afterState(s) }
        };
      }
      s.findById("wnd[0]").sendVKey(0);
      waitIdle(s, 60000);
      steps.push("submitted the logon screen");
    } else {
      steps.push("no logon screen (single sign-on or already logged on)");
    }
    for (var round = 0; round < 6; round++) {
      var top = activeWindowIndex(s);
      if (top === 0) { break; }
      var w = "wnd[" + top + "]";
      if (exists(s, w + "/usr/radMULTI_LOGON_OPT1")) {
        var mode = lower(args.multiLogon || "continue");
        if (mode === "cancel") {
          s.findById(w + "/usr/radMULTI_LOGON_OPT3").select();
          s.findById(w).sendVKey(0);
          fail("LOGON_CANCELLED", "The user is already logged on elsewhere; logon cancelled (multiLogon=cancel).");
        }
        s.findById(w + "/usr/" + (mode === "terminateothers" ? "radMULTI_LOGON_OPT1" : "radMULTI_LOGON_OPT2")).select();
        s.findById(w).sendVKey(0);
        waitIdle(s, 60000);
        steps.push(mode === "terminateothers" ? "multiple logon: ended the other logons" : "multiple logon: continued without ending the others");
        continue;
      }
      if (exists(s, w + "/usr/pwdRSYST-NCODE") || exists(s, "wnd[0]/usr/pwdRSYST-NCODE")) {
        fail("PASSWORD_CHANGE_REQUIRED", "SAP asks for a new password. Change it in SAP GUI yourself, then call sap_login again or attach with sap_sessions.");
      }
      var pop = popupSummary(s, top);
      if (pop && pop.inputs === 0) {
        s.findById(w).sendVKey(0);
        waitIdle(s, 30000);
        steps.push("closed popup \"" + pop.title + "\"");
        continue;
      }
      break;
    }
    var st = afterState(s);
    var info = sessionInfo(s);
    if (exists(s, "wnd[0]/usr/txtRSYST-BNAME") || exists(s, "wnd[0]/usr/pwdRSYST-NCODE")) {
      var msg = st.status ? st.status.text : "still on the logon screen";
      if (conn && !bool(args.keepOnFailure)) { try { conn.closeConnection(); } catch (e) { /* ignore */ } }
      fail("LOGON_FAILED", "Logon failed: " + msg, "Check client, user and password of the system profile.");
    }
    return { text: "Logged on: " + steps.join("; ") + "\n" + renderAfter(st), data: { session: info.id, info: info, state: st } };
  };

  /* ---------------- screenshot ---------------- */

  OPS.screenshot = function (args) {
    var s = findSession(args.session);
    waitIdle(s, 30000);
    var w = isNil(args.window) || args.window === "" ? activeWindowIndex(s) : num(args.window, 0);
    var wnd = s.findById("wnd[" + w + "]");
    var path = str(args.path);
    if (!path) { fail("BAD_REQUEST", "path is required."); }
    var r = tryCall(wnd, "hardCopy", [path, "PNG"]);
    if (!r.ok) { r = tryCall(wnd, "hardCopy", [path, 2]); }
    if (!r.ok) { r = tryCall(wnd, "hardCopy", [path]); }
    if (r.ok) {
      var written = str(r.value) || path;
      return { text: "screenshot of wnd[" + w + "] saved to " + written, data: { path: written, method: "hardCopy" } };
    }
    if (HOST.screenshot) {
      var geo = {
        left: num(prop(wnd, "screenLeft"), num(prop(wnd, "left"), 0)),
        top: num(prop(wnd, "screenTop"), num(prop(wnd, "top"), 0)),
        width: num(prop(wnd, "width"), 0),
        height: num(prop(wnd, "height"), 0)
      };
      var p = HOST.screenshot(path, geo);
      return { text: "screenshot of wnd[" + w + "] saved to " + p, data: { path: p, method: "host", geometry: geo } };
    }
    fail("NOT_SUPPORTED", "This SAP GUI cannot take screenshots: " + errText(r.error));
    return null;
  };

  /* ---------------- script ---------------- */

  OPS.script = function (args) {
    var s = findSession(args.session);
    var code = str(args.code);
    if (!trim(code)) { fail("BAD_REQUEST", "code must not be empty."); }
    var logLines = [];
    var api = {
      log: function (x) { logLines.push(str(x)); },
      findById: function (id) { return findElement(s, id); },
      waitIdle: function (ms) { return waitIdle(s, ms || 30000); }
    };
    var value = (function (session, application, sap) {
      return eval(code);
    })(s, app(), api);
    var st = afterState(s);
    var shown = encode(value);
    return {
      text: "script result: " + clip(shown, 4000) + (logLines.length ? "\nlog:\n" + logLines.join("\n") : "") + "\n" + renderAfter(st),
      data: { value: value, log: logLines, state: st }
    };
  };

  /* ---------------- safety classification ---------------- */

  var COMMIT_WORDS = /(sav(e|ing)|sichern|speichern|buchen|verbuchen|\bpost(en|ing)?\b|\bbook\b|freigeb|freigabe|\brelease\b|delet|l(\u00f6|oe)sch|entfern|\bremove\b|storn|\breverse\b|\bcommit\b|\bsubmit\b|absenden|\bsend(en)?\b|genehmig|\bapprove\b|verwerf|\bdiscard\b|unterschreib|\bsign\b)/i;
  var COMMIT_ICONS = /(SAVE|DELETE|POST|RELEASE|BOOK|TRASH)/i;
  var POPUP_COMMIT_WORDS = /(sav(e|ing)|sichern|speichern|buchen|\bpost|\u00e4nderungen|aenderungen|changes|daten.*verlor|data.*lost|verwerf|discard|l(\u00f6|oe)sch|delet|freigeb|release)/i;

  function popupIsSaveish(pop) {
    if (!pop) { return false; }
    if (POPUP_COMMIT_WORDS.test(pop.title)) { return true; }
    for (var i = 0; i < pop.lines.length; i++) { if (POPUP_COMMIT_WORDS.test(pop.lines[i])) { return true; } }
    return false;
  }
  function isNegativeButton(b) {
    return NEGATIVE_ID.test(str(b.id)) || NEGATIVE_BUTTON.test(trim(b.label)) || NEGATIVE_BUTTON.test(trim(b.tooltip));
  }
  function buttonLooksCommit(d) {
    if (/tbar\[0\]\/btn\[11\]$/.test(str(d.id))) { return "the Save button"; }
    var words = str(d.label) + " " + str(d.tooltip) + " " + str(d.text);
    if (COMMIT_WORDS.test(words)) { return "\"" + trim(d.label || d.tooltip || d.text) + "\""; }
    if (d.icon && COMMIT_ICONS.test(d.icon)) { return "icon " + d.icon; }
    if (d.id && /(SAVE|DELETE|POST|BUCH|LOESCH|DEL)\b/i.test(str(d.id).replace(/^.*[\/&]/, ""))) { return "id " + d.id; }
    return "";
  }

  function okcodeIsNavigation(cmd) {
    var c = trim(cmd);
    if (/^\/[nNoO](end|ex|END|EX)$/.test(c)) { return false; }
    if (/^\/[nNoO]\*?[A-Za-z0-9_\/]{1,40}$/.test(c)) { return true; }
    if (/^\/[nNoO]$/.test(c)) { return true; }
    return false;
  }

  /** What would this tool call do? Read-only: runs no SAP action. */
  function classify(tool, args) {
    var R = function (category, reason) { return { category: category, reason: reason }; };
    switch (tool) {
      case "sap_screen": case "sap_table": case "sap_screenshot": case "sap_status": case "sap_doctor": case "sap_systems":
        return R("read", "reads the screen");
      case "sap_sessions":
        var sa = lower(args.action || "list");
        if (sa === "list" || sa === "bind") { return R("read", "lists sessions"); }
        if (sa === "create") { return R("navigate", "opens a new session"); }
        return R("commit", sa === "logoff" ? "logs off the whole connection (unsaved data is lost)" : "closes a session (unsaved data is lost)");
      case "sap_login": case "sap_start": case "sap_setup_system":
        return R("navigate", "logs on / starts SAP GUI");
      case "sap_transaction":
        if (!isNil(args.command) && trim(args.command) !== "") {
          return okcodeIsNavigation(args.command) ? R("navigate", "navigates to " + trim(args.command)) : R("commit", "sends the raw OK-code " + dq(trim(args.command)));
        }
        return R("navigate", "starts transaction " + str(args.tcode));
      case "sap_set":
        var fl = isArray(args.fields) ? args.fields : [{ id: args.id }];
        for (var i = 0; i < fl.length; i++) { if (/okcd$/.test(str(fl[i] && fl[i].id))) { return R("commit", "writes into the OK-code field"); } }
        return bool(args.enter) ? R("input", "fills screen fields and presses Enter") : R("input", "fills screen fields");
      case "sap_script":
        return R("commit", "runs a custom script with full access to the session");
      default:
        return null;
    }
  }

  OPS.guard = function (args) {
    var tool = str(args.tool);
    var targs = args.args || {};
    var out = classify(tool, targs);
    var sys = null;
    var s = null;
    try {
      s = findSession(targs.session);
      var info = sessionInfo(s);
      sys = { sid: info.systemName || "", client: info.client || "", user: info.user || "", transaction: info.transaction || "", session: info.id };
    } catch (e) { s = null; }
    if (!out) { out = { category: "navigate", reason: "" }; }
    if (s && (tool === "sap_key" || tool === "sap_press" || tool === "sap_popup" || tool === "sap_menu" || tool === "sap_table_action")) {
      out = classifyAction(s, tool, targs);
    } else if (!s && (tool === "sap_key" || tool === "sap_press" || tool === "sap_popup" || tool === "sap_menu" || tool === "sap_table_action")) {
      out = { category: "commit", reason: "cannot inspect the screen, treated as a possible save" };
    }
    out.system = sys;
    out.description = describeCall(tool, targs, out, sys);
    return out;
  };

  function classifyAction(s, tool, a) {
    var top = activeWindowIndex(s);
    var pop = top > 0 ? popupSummary(s, top) : null;
    var saveish = popupIsSaveish(pop);
    if (tool === "sap_key") {
      var vk;
      try { vk = vkeyOf(isNil(a.key) ? "enter" : a.key); } catch (e) { return { category: "navigate", reason: "unknown key" }; }
      if (vk === 11) { return { category: "commit", reason: "Ctrl+S / F11 saves" }; }
      var w = isNil(a.window) || a.window === "" ? top : num(a.window, 0);
      if (w > 0 && pop && vk === 0 && (saveish || !pop.lines.length)) { return { category: "commit", reason: "Enter confirms the popup \"" + pop.title + "\"" }; }
      return { category: "navigate", reason: "sends a key" };
    }
    if (tool === "sap_popup") {
      var act = lower(a.action || "read");
      if (act === "read") { return { category: "read", reason: "reads the popup" }; }
      if (act === "cancel") { return { category: "navigate", reason: "cancels the popup" }; }
      if (!pop) { return { category: "navigate", reason: "no popup open" }; }
      if (act === "press") {
        var b = popupButtonFor(pop, a.button);
        if (b && isNegativeButton(b)) { return { category: "navigate", reason: "answers No/Cancel" }; }
        if (b && buttonLooksCommit({ id: b.id, label: b.label, tooltip: b.tooltip })) { return { category: "commit", reason: "presses " + (b.label || b.tooltip) + " in a popup" }; }
      }
      if (saveish || !pop.lines.length) { return { category: "commit", reason: "answers the popup \"" + pop.title + "\" (may save or discard data)" }; }
      return { category: "navigate", reason: "answers an informational popup" };
    }
    if (tool === "sap_menu") {
      var path = isArray(a.path) ? a.path.join(" > ") : str(a.path);
      if (!trim(path)) { return { category: "read", reason: "lists the menu" }; }
      return COMMIT_WORDS.test(path) ? { category: "commit", reason: "menu " + path } : { category: "navigate", reason: "menu " + path };
    }
    if (tool === "sap_press") {
      var el = null;
      try {
        el = resolveTarget(s, { id: a.id, label: a.label }, isNil(a.window) || a.window === "" ? null : num(a.window, 0),
          a.id ? null : ["button", "tab", "check", "radio", "text", "output", "input"]);
      } catch (e2) { return { category: "navigate", reason: "target not found (the call will fail)" }; }
      var d = describeElement(el, { icon: true });
      var rid = relId(el);
      var wm = /^wnd\[(\d+)\]/.exec(rid);
      var inPopup = wm && num(wm[1], 0) > 0;
      if (inPopup && pop) {
        if (isNegativeButton({ id: rid, label: d.label, tooltip: d.tooltip })) { return { category: "navigate", reason: "answers No/Cancel" }; }
        if (saveish || !pop.lines.length) { return { category: "commit", reason: "presses " + (d.label || d.tooltip || rid) + " in popup \"" + pop.title + "\"" }; }
      }
      var why = buttonLooksCommit({ id: rid, label: d.label, tooltip: d.tooltip, icon: d.icon });
      if (why) { return { category: "commit", reason: "presses " + why, target: { id: rid, label: d.label, tooltip: d.tooltip } }; }
      return { category: "navigate", reason: "presses " + (d.label || d.tooltip || rid), target: { id: rid, label: d.label, tooltip: d.tooltip } };
    }
    if (tool === "sap_table_action") {
      var ta = lower(a.action);
      if (ta === "setcell") { return { category: "input", reason: "changes a cell" }; }
      if (ta === "presstoolbar" || ta === "selectmenuitem") {
        var key = str(ta === "presstoolbar" ? a.button : a.item);
        var text = "";
        try {
          var grid = a.id ? findElement(s, a.id) : firstTable(s, top);
          if (grid && ta === "presstoolbar") {
            var bl = toolbarButtons(grid, "grid");
            for (var i = 0; i < bl.length; i++) { if (bl[i].id === key) { text = str(bl[i].text) + " " + str(bl[i].tooltip); } }
          } else if (grid) {
            var mi = contextMenuItems(grid);
            for (var j = 0; j < mi.length; j++) { if (mi[j].code === key || lower(mi[j].text) === lower(key)) { text = mi[j].text; } }
          }
        } catch (e3) { text = ""; }
        if (COMMIT_WORDS.test(text + " " + key) || /(SAVE|DELETE|DEL|POST|LOESCH)/i.test(key)) {
          return { category: "commit", reason: (ta === "presstoolbar" ? "toolbar button " : "menu item ") + trim(text || key) };
        }
        return { category: "navigate", reason: (ta === "presstoolbar" ? "toolbar button " : "menu item ") + trim(text || key) };
      }
      return { category: "navigate", reason: ta };
    }
    return { category: "navigate", reason: "" };
  }

  function describeCall(tool, a, c, sys) {
    var where = sys && sys.sid ? " in " + sys.sid + "/" + sys.client + (sys.transaction ? " (" + sys.transaction + ")" : "") : "";
    var what = tool.replace(/^sap_/, "");
    if (tool === "sap_press") { what = "Press " + (c.target ? dq(c.target.label || c.target.tooltip || c.target.id) + " (" + c.target.id + ")" : str(a.id || a.label)); }
    else if (tool === "sap_key") { what = "Send key " + str(a.key || "Enter"); }
    else if (tool === "sap_popup") { what = "Answer popup: " + str(a.action) + (a.button ? " " + dq(a.button) : ""); }
    else if (tool === "sap_menu") { what = "Menu " + (isArray(a.path) ? a.path.join(" > ") : str(a.path)); }
    else if (tool === "sap_transaction") { what = a.command ? "OK-code " + dq(a.command) : "Start transaction " + str(a.tcode); }
    else if (tool === "sap_script") { what = "Run script (" + str(a.code).length + " chars)"; }
    else if (tool === "sap_sessions") { what = "Session " + str(a.action || "list"); }
    else if (tool === "sap_table_action") { what = "Table action " + str(a.action) + (a.button ? " " + str(a.button) : "") + (a.item ? " " + str(a.item) : ""); }
    else if (tool === "sap_set") { what = "Fill " + (isArray(a.fields) ? a.fields.length : 1) + " field(s)"; }
    return what + where + (c.reason ? " -- " + c.reason : "");
  }

  /* ------------------------------------------------------------------ */
  /* dispatcher                                                          */
  /* ------------------------------------------------------------------ */

  function handle(req) {
    var id = isNil(req) || isNil(req.id) ? null : req.id;
    var op = isNil(req) ? "" : str(req.op);
    try {
      if (!has(OPS, op)) { fail("UNKNOWN_OP", "Unknown operation \"" + op + "\"."); }
      var args = req.args && typeof req.args === "object" ? req.args : {};
      var result = OPS[op](args);
      return { id: id, ok: true, result: result };
    } catch (e) {
      var c = classifyError(e);
      var err = { code: c.code, message: c.message };
      if (c.hint) { err.hint = c.hint; }
      return { id: id, ok: false, error: err };
    }
  }

  function handleLine(line) {
    var req;
    try {
      req = decode(line);
    } catch (e) {
      var c = classifyError(e);
      return encode({ id: null, ok: false, error: { code: "BAD_REQUEST", message: c.message } });
    }
    return encode(handle(req));
  }

  return {
    VERSION: VERSION,
    PROTOCOL: PROTOCOL,
    init: function (host) { HOST = host; },
    handle: handle,
    handleLine: handleLine,
    encode: encode,
    decode: decode,
    ops: OPS,
    _internal: {
      classify: classify, okcodeIsNavigation: okcodeIsNavigation, vkeyOf: vkeyOf, normalizeElementId: normalizeElementId,
      normalizeSessionId: normalizeSessionId, listLines: listLines, tcodeCommand: tcodeCommand, COMMIT_WORDS: COMMIT_WORDS
    }
  };
})();
