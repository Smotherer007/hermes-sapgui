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
import net from "node:net";
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

describe("java host (Rhino, loopback socket)", { skip: !haveRhino && "java or rhino.jar missing" }, () => {
  const procs = [];
  after(() => { for (const p of procs) { try { p.kill(); } catch {} } });

  async function startBridge(mode) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sapgui-bridge-"));
    const statusFile = path.join(dir, "status.json");
    const token = "tok-" + Math.random().toString(36).slice(2);
    const bundle = [
      `var __SAPGUI_BRIDGE_CONFIG = ${JSON.stringify({ port: 0, token, statusFile, mode })};`,
      fs.readFileSync(path.join(CORE, "test", "mock-sap.cjs"), "utf8"),
      "var application = createMockSap({ savePopup: true });",
      // SAP GUI for Java keeps the JVM alive with its (non-daemon) UI threads; stand in for them
      mode === "detach" ? "new java.lang.Thread(new java.lang.Runnable({ run: function () { java.lang.Thread.sleep(600000); } })).start();" : "",
      OPS_SRC,
      fs.readFileSync(path.join(CORE, "js", "host-java.js"), "utf8"),
    ].join("\n;\n");
    const file = path.join(dir, "bridge.js");
    fs.writeFileSync(file, bundle);
    const p = spawn("java", ["-jar", RHINO, "-opt", "-1", file], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => { stderr += d; });
    procs.push(p);
    for (let i = 0; i < 200 && !fs.existsSync(statusFile); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(statusFile), "bridge did not start: " + stderr);
    const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    return { port: status.port, token, status, proc: p, stderr: () => stderr };
  }

  function client(port) {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, "127.0.0.1");
      let buf = "";
      const waiters = [];
      sock.on("data", (d) => {
        buf += d;
        let k;
        while ((k = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, k);
          buf = buf.slice(k + 1);
          const w = waiters.shift();
          if (w) { try { w(JSON.parse(line)); } catch (e) { throw new Error("bad line: " + JSON.stringify(line)); } }
        }
      });
      sock.on("error", reject);
      sock.on("connect", () => resolve({
        send(obj) { return new Promise((res) => { waiters.push(res); sock.write(JSON.stringify(obj) + "\n"); }); },
        close() { sock.end(); },
        closed: new Promise((res) => sock.on("close", res)),
      }));
    });
  }

  for (const mode of ["loop", "thread", "detach"]) {
    test(`mode ${mode}: auth, requests, parallel clients, shutdown`, async () => {
      const b = await startBridge(mode);
      assert.equal(b.status.mode, mode);
      assert.match(b.status.engine, /Rhino/);

      const bad = await client(b.port);
      const denied = await bad.send({ auth: "wrong" });
      assert.equal(denied.error.code, "AUTH_FAILED");
      await bad.closed;

      const c1 = await client(b.port);
      const hi = await c1.send({ auth: b.token });
      assert.equal(hi.ready, true);
      assert.equal(hi.host, "java");
      const hello = await c1.send({ id: 1, op: "hello" });
      assert.equal(hello.result.host, "java");
      const info = await c1.send({ id: 2, op: "bridge.info" });
      assert.equal(info.result.mode, mode);

      const c2 = await client(b.port);
      await c2.send({ auth: b.token });
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

      const bye = await c2.send({ id: 9, op: "bridge.shutdown" });
      assert.equal(bye.ok, true);
      if (mode === "detach") {
        // the startup script ended long ago; the threads were serving on their own
        assert.match(b.stderr(), /detached/);
        b.proc.kill();
      } else {
        const code = await new Promise((r) => b.proc.on("exit", r));
        assert.equal(code, 0, b.stderr());
      }
    });
  }
});
