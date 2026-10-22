/*
 * Java host: runs inside the JavaScript engine of SAP GUI for Java
 * (macOS, Linux, or Windows with the Java GUI).
 *
 * The adapters start SAP GUI for Java with this bundle as the startup script:
 *     <SAPGUI launcher> -f <bundle>.js
 * The bundle is a config line + ops.js + this file. The script opens a
 * loopback-only TCP socket, accepts JSON-lines connections that start with
 * {"auth": "<token>"}, and executes every request on the script thread
 * (mode "loop", default) so SAP GUI sees the same thread it gave the script.
 * Fallbacks, for SAP GUI releases where a long-running script blocks the
 * user interface: mode "thread" executes requests on the connection threads
 * while the script thread idles; mode "detach" does the same but lets the
 * startup script end right away (the socket threads keep running).
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
  var ServerSocket = J("java.net.ServerSocket");
  var InetAddress = J("java.net.InetAddress");
  var BufferedReader = J("java.io.BufferedReader");
  var InputStreamReader = J("java.io.InputStreamReader");
  var OutputStreamWriter = J("java.io.OutputStreamWriter");
  var BufferedWriter = J("java.io.BufferedWriter");
  var LinkedBlockingQueue = J("java.util.concurrent.LinkedBlockingQueue");
  var ArrayBlockingQueue = J("java.util.concurrent.ArrayBlockingQueue");
  var TimeUnit = J("java.util.concurrent.TimeUnit");
  var ReentrantLock = J("java.util.concurrent.locks.ReentrantLock");
  var HashMap = J("java.util.HashMap");
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

  var state = { running: true, server: null };
  var queue = new LinkedBlockingQueue();
  var execLock = new ReentrantLock();
  var mode = String(cfg.mode || "loop");
  var token = String(cfg.token || "");
  if (!token) {
    try { token = String(System.getenv("SAPGUI_BRIDGE_TOKEN") || ""); } catch (e) { token = ""; }
  }
  if (!token) { log("no token configured -- refusing to start"); return; }

  function execute(line) {
    var req = null;
    try { req = SapBridge.decode(line); } catch (e) { return SapBridge.handleLine(line); }
    if (req && req.op === "bridge.shutdown") {
      state.running = false;
      try { state.server.close(); } catch (e2) { /* ignore */ }
      return SapBridge.encode({ id: req.id, ok: true, result: { text: "bridge stopped" } });
    }
    if (req && req.op === "bridge.info") {
      return SapBridge.encode({ id: req.id, ok: true, result: { mode: mode, engine: HOST.engine, pid: pid(),
        java: String(System.getProperty("java.version")), os: String(System.getProperty("os.name")) } });
    }
    return SapBridge.handleLine(line);
  }

  function writeLine(w, s) {
    w.write(String(s));
    w.write("\n");
    w.flush();
  }

  function serve(socket) {
    try {
      socket.setTcpNoDelay(true);
      var reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
      var writer = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));
      var first = reader.readLine();
      var auth = null;
      try { auth = SapBridge.decode(String(first)); } catch (e) { auth = null; }
      if (!auth || String(auth.auth) !== token) {
        writeLine(writer, SapBridge.encode({ id: null, ok: false, error: { code: "AUTH_FAILED", message: "bad token" } }));
        socket.close();
        return;
      }
      writeLine(writer, SapBridge.encode({ id: null, ok: true, ready: true, bridge: SapBridge.VERSION, protocol: SapBridge.PROTOCOL, host: "java", mode: mode }));
      while (state.running) {
        var line = reader.readLine();
        if (line === null) { break; }
        line = String(line);
        if (!line) { continue; }
        var reply;
        if (mode === "thread" || mode === "detach") {
          execLock.lock();
          try { reply = execute(line); } finally { execLock.unlock(); }
        } else {
          var item = new HashMap();
          var box = new ArrayBlockingQueue(1);
          item.put("line", line);
          item.put("reply", box);
          queue.put(item);
          var r = box.poll(30, TimeUnit.MINUTES);
          reply = r === null ? SapBridge.encode({ id: null, ok: false, error: { code: "TIMEOUT", message: "no answer from the script thread" } }) : String(r);
        }
        writeLine(writer, reply);
      }
    } catch (e3) {
      log("connection ended: " + e3);
    } finally {
      try { socket.close(); } catch (e4) { /* ignore */ }
    }
  }

  function startThread(fn, name) {
    var t = new Thread(new Runnable({ run: fn }), name);
    t.setDaemon(true);
    t.start();
    return t;
  }

  var basePort = Number(cfg.port || 0);
  var server = null;
  var lastError = null;
  for (var attempt = 0; attempt < 20 && server === null; attempt++) {
    try {
      server = new ServerSocket(basePort === 0 ? 0 : basePort + attempt, 16, InetAddress.getByName("127.0.0.1"));
    } catch (e) { lastError = e; server = null; if (basePort === 0) { break; } }
  }
  if (server === null) { log("could not open a socket: " + lastError); return; }
  state.server = server;
  var port = server.getLocalPort();

  if (cfg.statusFile) {
    try {
      var status = SapBridge.encode({ port: port, bridge: SapBridge.VERSION, protocol: SapBridge.PROTOCOL, mode: mode,
        pid: pid(), engine: HOST.engine, startedAt: HOST.now() });
      // write next to it and rename, so a reader never sees a half-written file
      var target = Paths.get(String(cfg.statusFile));
      var tmp = Paths.get(String(cfg.statusFile) + ".tmp");
      Files.write(tmp, new JString(status).getBytes(StandardCharsets.UTF_8));
      var CopyOption = J("java.nio.file.StandardCopyOption");
      try { Files.move(tmp, target, [CopyOption.REPLACE_EXISTING, CopyOption.ATOMIC_MOVE]); }
      catch (eMove) { Files.move(tmp, target, [CopyOption.REPLACE_EXISTING]); }
    } catch (e5) { log("could not write the status file: " + e5); }
  }
  log("listening on 127.0.0.1:" + port + " (mode " + mode + ", " + HOST.engine + ")");

  function spawnServe(sock) {
    // own function so every connection thread captures its own socket
    startThread(function () { serve(sock); }, "sapgui-bridge-conn");
  }

  startThread(function () {
    while (state.running) {
      try {
        spawnServe(server.accept());
      } catch (e) {
        if (state.running) { log("accept failed: " + e); }
      }
    }
  }, "sapgui-bridge-accept");

  if (mode === "detach") {
    log("detached: the startup script ends, the bridge keeps serving");
    return;
  }
  if (mode === "thread") {
    while (state.running) { Thread.sleep(500); }
  } else {
    while (state.running) {
      var item = queue.poll(250, TimeUnit.MILLISECONDS);
      if (item === null) { continue; }
      var out;
      try { out = execute(String(item.get("line"))); }
      catch (e6) { out = SapBridge.encode({ id: null, ok: false, error: { code: "BRIDGE_ERROR", message: String(e6) } }); }
      item.get("reply").put(new JString(String(out)));
    }
  }
  log("stopped");
})(this);
