// Loads ops.js into an isolated context with a mock SAP application, the way
// the hosts do, and gives tests a call(op, args) that goes through the real
// JSON line protocol.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CORE = path.resolve(here, "..");
const require = createRequire(import.meta.url);
export const { createMockSap } = require("./mock-sap.cjs");

export const OPS_SRC = fs.readFileSync(path.join(CORE, "js", "ops.js"), "utf8");

export function bridge(options = {}, hostKind = "windows") {
  const app = options.app || createMockSap(options);
  const ctx = vm.createContext({});
  vm.runInContext(OPS_SRC, ctx, { filename: "ops.js" });
  const host = {
    kind: hostKind,
    engine: "test",
    sleep() {},
    now: () => Date.now(),
    getApplication: () => {
      if (options.noSapGui) throw new Error("ActiveX component can't create object: 'GetObject'");
      return app;
    },
    resetApplication() {},
  };
  if (options.hostScreenshot) host.screenshot = options.hostScreenshot;
  ctx.SapBridge.init(host);
  let id = 0;
  function raw(line) {
    const out = ctx.SapBridge.handleLine(line);
    if (/[^\x00-\x7f]/.test(out)) throw new Error("bridge output is not pure ASCII: " + out);
    return JSON.parse(out);
  }
  function call(op, args = {}) {
    const res = raw(JSON.stringify({ id: ++id, op, args }));
    if (res.id !== id) throw new Error("response id mismatch");
    return res;
  }
  function ok(op, args) {
    const res = call(op, args);
    if (!res.ok) throw new Error(`${op} failed: ${res.error.code} ${res.error.message}`);
    return res.result;
  }
  return { app, ctx, call, ok, raw, session: () => app.findById("/app/con[0]/ses[0]") };
}
