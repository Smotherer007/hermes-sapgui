/*
 * Windows host: runs under Windows Script Host (cscript.exe, JScript) and
 * talks to SAP GUI for Windows through its COM scripting engine.
 *
 * Started by the adapters as
 *     cscript.exe //nologo //E:JScript <bundle>.js
 * where the bundle is ops.js + this file. One JSON request per stdin line,
 * one JSON response per stdout line. The host keeps no state besides the
 * cached scripting engine, so the adapter can kill and restart it at any
 * time (for example when a COM call hangs).
 */

(function () {
  var cachedApp = null;

  function getEngine() {
    var sapgui = GetObject("SAPGUI");
    var engine = null;
    try { engine = sapgui.GetScriptingEngine; } catch (e) { engine = null; }
    if (engine === null || engine === undefined || typeof engine !== "object") {
      engine = sapgui.GetScriptingEngine();
    }
    return engine;
  }

  var HOST = {
    kind: "windows",
    engine: "JScript " + ScriptEngineMajorVersion() + "." + ScriptEngineMinorVersion() + "." + ScriptEngineBuildVersion(),
    sleep: function (ms) { WScript.Sleep(ms); },
    now: function () { return new Date().getTime(); },
    getApplication: function () {
      if (cachedApp !== null) {
        // A dead COM reference throws on any access; refresh it once.
        try { var probe = cachedApp.children; return cachedApp; } catch (e) { cachedApp = null; }
      }
      cachedApp = getEngine();
      return cachedApp;
    },
    resetApplication: function () { cachedApp = null; },
    log: function (msg) { try { WScript.StdErr.WriteLine(String(msg)); } catch (e) { /* no stderr */ } }
  };

  SapBridge.init(HOST);

  var stdin = WScript.StdIn;
  var stdout = WScript.StdOut;
  stdout.WriteLine(SapBridge.encode({ id: null, ok: true, ready: true, bridge: SapBridge.VERSION, protocol: SapBridge.PROTOCOL, host: "windows" }));
  while (!stdin.AtEndOfStream) {
    var line = stdin.ReadLine();
    if (!line) { continue; }
    if (line === "__quit__") { break; }
    var out;
    try {
      out = SapBridge.handleLine(line);
    } catch (e) {
      out = SapBridge.encode({ id: null, ok: false, error: { code: "BRIDGE_ERROR", message: String(e && (e.message || e.description) || e) } });
    }
    stdout.WriteLine(out);
  }
})();
