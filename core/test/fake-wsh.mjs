#!/usr/bin/env node
// Stand-in for cscript.exe in adapter tests on Linux/macOS:
//   node fake-wsh.mjs //nologo //E:JScript <bundle.js>
// Runs the bundle in a context that imitates Windows Script Host, with the
// SAP GUI mock behind GetObject("SAPGUI"). stdin/stdout are read and written
// synchronously, line by line, like WScript.StdIn/StdOut.
//
// Env: FAKE_SAP_OPTIONS (JSON options for the mock), FAKE_WSH_DISABLED=1
// (print the WSH "disabled" banner and exit), FAKE_WSH_HANG_OP=<op> (never
// answer that op, to test timeouts).
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createMockSap } = require("./mock-sap.cjs");

if (process.env.FAKE_WSH_DISABLED === "1") {
  process.stdout.write("Windows Script Host access is disabled on this machine. Contact your administrator for details.\n");
  process.exit(1);
}

const bundle = process.argv[process.argv.length - 1];
const mockOptions = JSON.parse(process.env.FAKE_SAP_OPTIONS || "{}");
if (mockOptions.writeHardCopy) {
  // a real 1x1 PNG, so adapters can attach it as an image
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  mockOptions.onHardCopy = (p) => fs.writeFileSync(p, png);
}
const app = createMockSap(mockOptions);
const hangOp = process.env.FAKE_WSH_HANG_OP || "";

let buffer = "";
let eof = false;
function fill() {
  const chunk = Buffer.alloc(65536);
  while (!eof && buffer.indexOf("\n") < 0) {
    let n = 0;
    try { n = fs.readSync(0, chunk, 0, chunk.length, null); }
    catch (e) { if (e.code === "EAGAIN") { continue; } if (e.code === "EOF") { n = 0; } else { throw e; } }
    if (n === 0) { eof = true; break; }
    buffer += chunk.toString("latin1", 0, n);
  }
}

const ctx = vm.createContext({
  WScript: {
    StdIn: {
      get AtEndOfStream() { fill(); return eof && buffer.length === 0; },
      ReadLine() {
        fill();
        const k = buffer.indexOf("\n");
        let line;
        if (k < 0) { line = buffer; buffer = ""; } else { line = buffer.slice(0, k); buffer = buffer.slice(k + 1); }
        line = line.replace(/\r$/, "");
        if (hangOp && line.includes(`"op":"${hangOp}"`)) { for (;;) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); } }
        return line;
      },
    },
    StdOut: { WriteLine: (s) => { fs.writeSync(1, String(s) + "\r\n"); } },
    StdErr: { WriteLine: (s) => { fs.writeSync(2, String(s) + "\r\n"); } },
    Sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(ms, 50)); },
  },
  GetObject(name) {
    if (name !== "SAPGUI") throw new Error("bad moniker " + name);
    if (process.env.FAKE_SAP_DOWN === "1") throw new Error("ActiveX component can't create object");
    return { GetScriptingEngine: app };
  },
  ScriptEngineMajorVersion: () => 5,
  ScriptEngineMinorVersion: () => 8,
  ScriptEngineBuildVersion: () => 16384,
});
vm.runInContext(fs.readFileSync(bundle, "latin1"), ctx, { filename: bundle });
