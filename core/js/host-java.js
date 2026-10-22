/*
 * Java host: runs inside the JavaScript engine of SAP GUI for Java
 * (macOS, Linux, or Windows with the Java GUI).
 *
 * The adapters start SAP GUI for Java with this bundle as the startup script:
 *     <SAPGUI launcher> -f <bundle>.js
 * The bundle is a config line + ops.js + this file.
 *
 * Transport: a file queue. SAP GUI for Java runs startup scripts in its
 * "SAPGUI:UserScript" sandbox, which grants FilePermission "<<ALL FILES>>"
 * but no SocketPermission (a socket can listen, but accept() is denied).
 * So the adapters drop one request per file into <queueDir>/in and the
 * bridge answers into <queueDir>/out:
 *     in/<name>.tmp  -> renamed to in/<name>.req   (written by the adapter)
 *     out/<name>.tmp -> renamed to out/<name>.res  (written by the bridge)
 * Each file holds one JSON line of the usual protocol. Requests run in name
 * order. The queue lives in ~/.sapgui-bridge (mode 0700), so only the user
 * can submit requests. A status file with a heartbeat (every 2 s) tells the
 * adapters whether the bridge is alive.
 *
 * Mode "loop" (default) executes requests on the script thread, the thread
 * SAP GUI gave the script. Fallbacks, for SAP GUI releases where a
 * long-running script blocks the user interface: mode "thread" executes on a
 * worker thread while the script thread idles; mode "detach" does the same
 * but lets the startup script end right away.
 *
 * Works with Rhino (what SAP GUI for Java embeds) and Nashorn; GraalJS needs
 * its Nashorn compatibility mode.
 */

(function (global) {
  var cfg = typeof __SAPGUI_BRIDGE_CONFIG !== "undefined" ? __SAPGUI_BRIDGE_CONFIG : {};

  function J(name) {
    try {
      if (typeof Java !== "undefined" && Java && typeof Java.type === "function") { return Java.type(name); }
    } catch (e) { /* not Nashorn/Graal */ }
    var parts = name.split(".");
    var o = Packages;
    for (var i = 0; i < parts.length; i++) { o = o[parts[i]]; }
    return o;
  }

  var JString = J("java.lang.String");
  var System = J("java.lang.System");
  var Thread = J("java.lang.Thread");
  var Runnable = J("java.lang.Runnable");
  var JFile = J("java.io.File");
  var Files = J("java.nio.file.Files");
  var Paths = J("java.nio.file.Paths");
  var StandardCharsets = J("java.nio.charset.StandardCharsets");

  function log(msg) {
    try { System.err.println("[sapgui-bridge] " + msg); } catch (e) { /* ignore */ }
  }

  function engineName() {
    try {
      if (typeof Packages !== "undefined" && Packages.org && Packages.org.mozilla && Packages.org.mozilla.javascript &&
          Packages.org.mozilla.javascript.Context) {
        var cx = Packages.org.mozilla.javascript.Context.getCurrentContext();
        if (cx) { return String(cx.getImplementationVersion()); }
      }
    } catch (e) { /* ignore */ }
    if (typeof Java !== "undefined") { return "Nashorn/Graal"; }
    return "unknown";
  }

  function pid() {
    try { return String(J("java.lang.ProcessHandle").current().pid()); } catch (e) { /* Java 8 */ }
    try { return String(J("java.lang.management.ManagementFactory").getRuntimeMXBean().getName()).split("@")[0]; } catch (e2) { return ""; }
  }

  function getApp() {
    if (typeof application !== "undefined" && application) { return application; }
    if (global && global.application) { return global.application; }
    if (typeof sapgui !== "undefined" && sapgui) { return sapgui; }
    throw new Error("The SAP GUI for Java scripting object 'application' is not available. Is scripting enabled (Preferences > Accessibility & Scripting > Scripting)?");
  }

  var HOST = {
    kind: "java",
    engine: engineName(),
    sleep: function (ms) { Thread.sleep(ms); },
    now: function () { return Number(System.currentTimeMillis()); },
    getApplication: getApp,
    resetApplication: function () { /* the in-process object never goes stale */ },
    log: log,
    screenshot: function (path, geo) {
      var Robot = J("java.awt.Robot");
      var Rectangle = J("java.awt.Rectangle");
      var ImageIO = J("javax.imageio.ImageIO");
      var File = J("java.io.File");
      var rect;
      if (geo && geo.width > 0 && geo.height > 0) {
        rect = new Rectangle(geo.left, geo.top, geo.width, geo.height);
      } else {
        var size = J("java.awt.Toolkit").getDefaultToolkit().getScreenSize();
        rect = new Rectangle(0, 0, size.width, size.height);
      }
      var img = new Robot().createScreenCapture(rect);
      ImageIO.write(img, "png", new File(path));
      return path;
    }
  };

  SapBridge.init(HOST);

  var CopyOption = J("java.nio.file.StandardCopyOption");
  var mode = String(cfg.mode || "loop");
  var instance = String(cfg.instance || "");
  var state = { running: true, lastRequest: 0, startedAt: HOST.now() };

  if (!cfg.queueDir || !cfg.statusFile) { log("no queueDir/statusFile configured -- refusing to start"); return; }
  var inDir = new JFile(String(cfg.queueDir), "in");
  var outDir = new JFile(String(cfg.queueDir), "out");
  inDir.mkdirs();
  outDir.mkdirs();

  function writeAtomic(path, text) {
    // write next to it and rename, so a reader never sees a half-written file
    var target = Paths.get(String(path));
    var tmp = Paths.get(String(path).replace(/\.[a-z]+$/, "") + ".tmp");
    Files.write(tmp, new JString(String(text)).getBytes(StandardCharsets.UTF_8));
    try { Files.move(tmp, target, [CopyOption.REPLACE_EXISTING, CopyOption.ATOMIC_MOVE]); }
    catch (eMove) { Files.move(tmp, target, [CopyOption.REPLACE_EXISTING]); }
  }

  function readText(file) {
    return String(new JString(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
  }

  function listNames(dir, suffix) {
    var raw = dir.list();
    var out = [];
    if (raw === null) { return out; }
    for (var i = 0; i < raw.length; i++) {
      var n = String(raw[i]);
      if (n.length > suffix.length && n.substring(n.length - suffix.length) === suffix) { out.push(n); }
    }
    out.sort();
    return out;
  }

  function clear(dir, suffix, olderThanMs) {
    var names = listNames(dir, suffix);
    for (var i = 0; i < names.length; i++) {
      var f = new JFile(dir, names[i]);
      if (!olderThanMs || HOST.now() - Number(f.lastModified()) > olderThanMs) {
        try { f["delete"](); } catch (e) { /* ignore */ }
      }
    }
  }

  function writeStatus() {
    if (!state.running) { return; }
    try {
      writeAtomic(cfg.statusFile, SapBridge.encode({ transport: "file", queueDir: String(cfg.queueDir), bridge: SapBridge.VERSION,
        protocol: SapBridge.PROTOCOL, mode: mode, pid: pid(), engine: HOST.engine, instance: instance,
        startedAt: state.startedAt, heartbeat: HOST.now() }));
    } catch (e) { log("could not write the status file: " + e); }
  }

  function execute(line) {
    var req = null;
    try { req = SapBridge.decode(line); } catch (e) { return SapBridge.handleLine(line); }
    if (req && req.op === "bridge.shutdown") {
      state.running = false;
      try { new JFile(String(cfg.statusFile))["delete"](); } catch (e2) { /* ignore */ }
      return SapBridge.encode({ id: req.id, ok: true, result: { text: "bridge stopped" } });
    }
    if (req && req.op === "bridge.info") {
      return SapBridge.encode({ id: req.id, ok: true, result: { mode: mode, transport: "file", engine: HOST.engine, pid: pid(),
        java: String(System.getProperty("java.version")), os: String(System.getProperty("os.name")) } });
    }
    return SapBridge.handleLine(line);
  }

  /** Answer every waiting request; returns how many were handled. */
  function pollOnce() {
    var names = listNames(inDir, ".req");
    for (var i = 0; i < names.length && state.running; i++) {
      var f = new JFile(inDir, names[i]);
      var line;
      try {
        line = readText(f);
        f["delete"]();
      } catch (e) {
        log("could not read " + names[i] + ": " + e);
        continue;
      }
      var out;
      try { out = execute(line.replace(/[\r\n]+$/, "")); }
      catch (e2) { out = SapBridge.encode({ id: null, ok: false, error: { code: "BRIDGE_ERROR", message: String(e2) } }); }
      var base = names[i].substring(0, names[i].length - 4);
      try { writeAtomic(new JFile(outDir, base + ".res").getPath(), out); }
      catch (e3) { log("could not write the answer to " + base + ": " + e3); }
      state.lastRequest = HOST.now();
    }
    return names.length;
  }

  function serveLoop() {
    var lastClean = HOST.now();
    while (state.running) {
      var handled = 0;
      try { handled = pollOnce(); } catch (e) { log("poll failed: " + e); }
      if (!heartbeatThread && HOST.now() - lastBeat > 2000) { writeStatus(); lastBeat = HOST.now(); }
      if (HOST.now() - lastClean > 60000) {
        clear(outDir, ".res", 600000);   // answers nobody picked up
        lastClean = HOST.now();
      }
      if (!handled) { Thread.sleep(HOST.now() - state.lastRequest < 3000 ? 15 : 100); }
    }
  }

  function startThread(fn, name) {
    var t = new Thread(new Runnable({ run: fn }), name);
    t.setDaemon(true);
    t.start();
    return t;
  }

  // stale requests from an earlier SAP GUI must not run against this one
  clear(inDir, ".req", 0);
  clear(inDir, ".tmp", 0);
  clear(outDir, ".res", 0);

  var lastBeat = 0;
  var heartbeatThread = null;
  writeStatus();
  try {
    heartbeatThread = startThread(function () {
      while (state.running) {
        writeStatus();
        Thread.sleep(2000);
      }
    }, "sapgui-bridge-heartbeat");
  } catch (e) {
    heartbeatThread = null;
    log("no heartbeat thread (" + e + "); the request loop writes the heartbeat");
  }
  log("ready: file queue " + cfg.queueDir + " (mode " + mode + ", " + HOST.engine + ")");

  if (mode === "thread" || mode === "detach") {
    startThread(serveLoop, "sapgui-bridge-worker");
    if (mode === "detach") {
      log("detached: the startup script ends, the bridge keeps serving");
      return;
    }
    while (state.running) { Thread.sleep(500); }
  } else {
    serveLoop();
  }
  log("stopped");
})(this);
