// End-to-end tests of both hosts.
//  - host-windows.js runs in a context that imitates Windows Script Host
//    (WScript.StdIn/StdOut, GetObject("SAPGUI")).
//  - host-java.js runs in real Rhino (the engine SAP GUI for Java embeds),
//    with the mock standing in for SAP GUI for Java's `application`, and is
//    reached over its loopback socket exactly like the adapters reach it.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn, execFileSync } from "node:child_process";
import { CORE, OPS_SRC, createMockSap } from "./harness.mjs";

const RHINO = process.env.RHINO_JAR || "/root/tools/rhino.jar";

describe("windows host (simulated WSH)", () => {
  function runWsh(lines, { app = createMockSap(), noSapGui = false } = {}) {
    const out = [];
    let i = 0;
    const ctx = vm.createContext({
      WScript: {
        StdIn: {
          get AtEndOfStream() { return i >= lines.length; },
          ReadLine: () => lines[i++],
        },
        StdOut: { WriteLine: (s) => out.push(String(s)) },
        StdErr: { WriteLine() {} },
        Sleep() {},
      },
      GetObject(name) {
        assert.equal(name, "SAPGUI");
        if (noSapGui) throw new Error("ActiveX component can't create object");
        return { GetScriptingEngine: app };
      },
      ScriptEngineMajorVersion: () => 5,
      ScriptEngineMinorVersion: () => 8,
      ScriptEngineBuildVersion: () => 16384,
    });
    vm.runInContext(OPS_SRC, ctx);
    vm.runInContext(fs.readFileSync(path.join(CORE, "js", "host-windows.js"), "utf8"), ctx);
    return out.map((l) => JSON.parse(l));
  }

  test("announces itself, then answers line by line", () => {
    const res = runWsh([
      JSON.stringify({ id: 1, op: "hello" }),
      "",
      JSON.stringify({ id: 2, op: "transaction", args: { tcode: "MM03" } }),
      JSON.stringify({ id: 3, op: "screen" }),
      "__quit__",
      JSON.stringify({ id: 4, op: "hello" }),
    ]);
    assert.equal(res.length, 4);
    assert.equal(res[0].ready, true);
    assert.equal(res[0].host, "windows");
    assert.equal(res[1].id, 1);
    assert.equal(res[1].result.engine, "JScript 5.8.16384");
    assert.match(res[3].result.text, /ctxtRMMG1-MATNR/);
  });

  test("SAP Logon not running is an error, not a crash", () => {
    const res = runWsh([JSON.stringify({ id: 1, op: "sessions" }), JSON.stringify({ id: 2, op: "ping" })], { noSapGui: true });
    assert.equal(res[1].error.code, "SAPGUI_UNAVAILABLE");
    assert.equal(res[2].result.pong, true);
  });
});

const haveRhino = (() => {
  try { execFileSync("java", ["-version"], { stdio: "ignore" }); return fs.existsSync(RHINO); } catch { return false; }
})();

describe("java host (Rhino, file queue)", { skip: !haveRhino && "java or rhino.jar missing" }, () => {
  const procs = [];
  after(() => { for (const p of procs) { try { p.kill(); } catch {} } });

  // SAP GUI for Java runs startup scripts in its "SAPGUI:UserScript" sandbox:
  // file access yes, sockets no (only the JDK default "localhost:0 listen").
  const SANDBOX_POLICY = `grant {
  permission java.io.FilePermission "<<ALL FILES>>", "read,write,delete,execute";
  permission java.lang.RuntimePermission "*";
  permission java.util.PropertyPermission "*", "read,write";
  permission java.lang.reflect.ReflectPermission "suppressAccessChecks";
  permission java.security.SecurityPermission "*";
  permission java.net.SocketPermission "localhost:0", "listen";
};
`;

  async function startBridge(mode, { sandbox = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sapgui-bridge-"));
    const statusFile = path.join(dir, "status.json");
    const queueDir = path.join(dir, "queue");
    const bundle = [
      `var __SAPGUI_BRIDGE_CONFIG = ${JSON.stringify({ queueDir, statusFile, mode, instance: "test" })};`,
      fs.readFileSync(path.join(CORE, "test", "mock-sap.cjs"), "utf8"),
      "var application = createMockSap({ savePopup: true });",
      // SAP GUI for Java keeps the JVM alive with its (non-daemon) UI threads; stand in for them
      mode === "detach" ? "new java.lang.Thread(new java.lang.Runnable({ run: function () { java.lang.Thread.sleep(600000); } })).start();" : "",
      OPS_SRC,
      fs.readFileSync(path.join(CORE, "js", "host-java.js"), "utf8"),
    ].join("\n;\n");
    const file = path.join(dir, "bridge.js");
    fs.writeFileSync(file, bundle);
    const jvm = [];
    if (sandbox) {
      const policy = path.join(dir, "sandbox.policy");
      fs.writeFileSync(policy, SANDBOX_POLICY);
      jvm.push("-Djava.security.manager=allow", "-Djava.security.manager", `-Djava.security.policy==${policy}`);
    }
    const p = spawn("java", [...jvm, "-jar", RHINO, "-opt", "-1", file], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => { stderr += d; });
    procs.push(p);
    let status = null;
    for (let i = 0; i < 300 && !status; i++) {
      try { status = JSON.parse(fs.readFileSync(statusFile, "utf8")); } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    assert.ok(status, "bridge did not start: " + stderr);
    return { queueDir, statusFile, status, proc: p, stderr: () => stderr };
  }

  // the same file protocol the adapters speak
  function client(queueDir, tag) {
    let seq = 0;
    return {
      async send(obj, timeoutMs = 20000) {
        const name = `${String(Date.now()).padStart(15, "0")}-${tag}-${++seq}`;
        const tmp = path.join(queueDir, "in", name + ".tmp");
        fs.writeFileSync(tmp, JSON.stringify(obj) + "\n");
        fs.renameSync(tmp, path.join(queueDir, "in", name + ".req"));
        const res = path.join(queueDir, "out", name + ".res");
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
          if (fs.existsSync(res)) {
            const text = fs.readFileSync(res, "utf8");
            fs.unlinkSync(res);
            return JSON.parse(text);
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("no answer to " + obj.op);
      },
    };
  }

  for (const mode of ["loop", "thread", "detach"]) {
    test(`mode ${mode}: requests, parallel clients, heartbeat, shutdown`, async () => {
      const b = await startBridge(mode);
      assert.equal(b.status.mode, mode);
      assert.equal(b.status.transport, "file");
      assert.match(b.status.engine, /Rhino/);

      const c1 = client(b.queueDir, "a");
      const c2 = client(b.queueDir, "b");
      const hello = await c1.send({ id: 1, op: "hello" });
      assert.equal(hello.result.host, "java");
      const info = await c1.send({ id: 2, op: "bridge.info" });
      assert.equal(info.result.mode, mode);
      assert.equal(info.result.transport, "file");

      const [t, s] = await Promise.all([
        c1.send({ id: 3, op: "transaction", args: { tcode: "MM02" } }),
        c2.send({ id: 4, op: "sessions" }),
      ]);
      assert.equal(t.ok, true, JSON.stringify(t));
      assert.equal(s.ok, true);

      const set = await c1.send({ id: 5, op: "set", args: { fields: [{ id: "usr/txtMAKT-MAKTX", value: "Blech äöü €" }] } });
      assert.equal(set.result.data.fields[0].value, "Blech äöü €");
      const g = await c2.send({ id: 6, op: "guard", args: { tool: "sap_key", args: { key: "Ctrl+S" } } });
      assert.equal(g.result.category, "commit");
      const k = await c1.send({ id: 7, op: "key", args: { key: "F11" } });
      assert.match(k.result.text, /POPUP wnd\[1\] "Save Changes"/);
      const err = await c1.send({ id: 8, op: "press", args: { id: "usr/btnNOPE" } });
      assert.equal(err.error.code, "NOT_FOUND");

      const beat1 = JSON.parse(fs.readFileSync(b.statusFile, "utf8")).heartbeat;
      await new Promise((r) => setTimeout(r, 2500));
      const beat2 = JSON.parse(fs.readFileSync(b.statusFile, "utf8")).heartbeat;
      assert.ok(beat2 > beat1, "heartbeat advances");
      assert.deepEqual(fs.readdirSync(path.join(b.queueDir, "in")), [], "requests are consumed");

      const bye = await c2.send({ id: 9, op: "bridge.shutdown" });
      assert.equal(bye.ok, true);
      assert.ok(!fs.existsSync(b.statusFile), "status file removed on shutdown");
      if (mode === "detach") {
        assert.match(b.stderr(), /detached/);
        b.proc.kill();
      } else {
        const code = await new Promise((r) => b.proc.on("exit", r));
        assert.equal(code, 0, b.stderr());
      }
    });
  }

  test("works inside a sandbox that forbids sockets, like SAP GUI for Java's", async () => {
    const b = await startBridge("loop", { sandbox: true });
    const c = client(b.queueDir, "s");
    assert.equal((await c.send({ id: 1, op: "transaction", args: { tcode: "MM03" } })).ok, true);
    const screen = await c.send({ id: 2, op: "screen" });
    assert.match(screen.result.text, /ctxtRMMG1-MATNR/);
    // proof that the sandbox is active: the bridge itself may not open a connection
    const sock = await c.send({ id: 3, op: "script", args: { code: 'new java.net.Socket("127.0.0.1", 9); "connected"' } });
    assert.equal(sock.ok, false);
    assert.match(sock.error.message, /AccessControlException|access denied/);
    await c.send({ id: 4, op: "bridge.shutdown" });
    await new Promise((r) => b.proc.on("exit", r));
  });

  test("stale requests from an earlier run are discarded at start", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sapgui-stale-"));
    fs.mkdirSync(path.join(dir, "in"), { recursive: true });
    fs.writeFileSync(path.join(dir, "in", "000000000000001-old-1.req"), JSON.stringify({ id: 1, op: "key", args: { key: "F11" } }) + "\n");
    const statusFile = path.join(dir, "status.json");
    const bundle = [
      `var __SAPGUI_BRIDGE_CONFIG = ${JSON.stringify({ queueDir: dir, statusFile, mode: "loop" })};`,
      fs.readFileSync(path.join(CORE, "test", "mock-sap.cjs"), "utf8"),
      "var application = createMockSap({});",
      OPS_SRC,
      fs.readFileSync(path.join(CORE, "js", "host-java.js"), "utf8"),
    ].join("\n;\n");
    fs.writeFileSync(path.join(dir, "b.js"), bundle);
    const p = spawn("java", ["-jar", RHINO, "-opt", "-1", path.join(dir, "b.js")], { stdio: "ignore" });
    procs.push(p);
    for (let i = 0; i < 300 && !fs.existsSync(statusFile); i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(fs.readdirSync(path.join(dir, "in")), []);
    assert.deepEqual(fs.readdirSync(path.join(dir, "out")), [], "the stale request was not answered");
    const c = client(dir, "x");
    await c.send({ id: 2, op: "bridge.shutdown" });
  });
});
