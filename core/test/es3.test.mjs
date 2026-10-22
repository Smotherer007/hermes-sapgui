// The bridge must run in Windows Script Host's JScript (ES3 plus a few
// extensions) and in SAP GUI for Java's Rhino. Parse it as ES3 and reject the
// built-ins JScript does not have.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "acorn";
import { CORE } from "./harness.mjs";

const FILES = ["ops.js", "host-windows.js", "host-java.js"];

const FORBIDDEN = [
  [/\.forEach\(/, "Array.prototype.forEach"],
  [/\.map\(/, "Array.prototype.map"],
  [/\.filter\(/, "Array.prototype.filter"],
  [/\.reduce\(/, "Array.prototype.reduce"],
  [/\.some\(/, "Array.prototype.some"],
  [/\.every\(/, "Array.prototype.every"],
  [/\.trim\(\)/, "String.prototype.trim"],
  [/Object\.keys/, "Object.keys"],
  [/Object\.create/, "Object.create"],
  [/Object\.defineProperty/, "Object.defineProperty"],
  [/Array\.isArray/, "Array.isArray"],
  [/Date\.now/, "Date.now"],
  [/\bJSON\.(parse|stringify)/, "native JSON (use SapBridge.encode/decode)"],
  [/\blet\s|\bconst\s/, "let/const"],
  [/=>/, "arrow functions"],
  [/`/, "template literals"],
];

// ES3 reserved words that JScript rejects as dotted property names.
const RESERVED = ["abstract", "boolean", "byte", "char", "class", "const", "debugger", "default", "delete", "double",
  "enum", "export", "extends", "final", "float", "goto", "implements", "import", "in", "instanceof", "int",
  "interface", "long", "native", "new", "package", "private", "protected", "public", "short", "static", "super",
  "synchronized", "throws", "transient", "volatile", "typeof", "void", "with", "catch", "finally", "throw", "try",
  "case", "switch", "do", "while", "for", "if", "else", "return", "var", "function", "this", "null", "true", "false",
  "break", "continue"];

function stripStringsAndComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

for (const f of FILES) {
  const src = fs.readFileSync(path.join(CORE, "js", f), "utf8");

  test(`${f} is pure ASCII (cscript reads scripts in the ANSI code page)`, () => {
    assert.doesNotMatch(src, /[^\x00-\x7f]/);
  });

  test(`${f} parses as ECMAScript 3`, () => {
    parse(src, { ecmaVersion: 3, sourceType: "script", allowReserved: false });
  });

  test(`${f} uses no built-in JScript lacks`, () => {
    const code = stripStringsAndComments(src);
    for (const [re, what] of FORBIDDEN) {
      if (f === "host-java.js" && what.startsWith("native JSON")) continue;
      assert.doesNotMatch(code, re, `${f} uses ${what}`);
    }
  });

  test(`${f} has no reserved word as a dotted property`, () => {
    const code = stripStringsAndComments(src);
    for (const w of RESERVED) {
      assert.doesNotMatch(code, new RegExp(`\\.${w}\\b(?!\\s*:)`), `${f} uses .${w}`);
    }
  });

  test(`${f} has no trailing commas in literals`, () => {
    const code = stripStringsAndComments(src);
    assert.doesNotMatch(code, /,\s*[}\]]/, `${f} has a trailing comma`);
  });
}

test("ops.js does not use Array.prototype.indexOf on arrays", () => {
  const code = stripStringsAndComments(fs.readFileSync(path.join(CORE, "js", "ops.js"), "utf8"));
  // .indexOf( is fine on strings; arrays go through the indexOf(arr, v) helper.
  for (const m of code.matchAll(/(\w+)\.indexOf\(/g)) {
    const receiver = m[1];
    assert.ok(!/^(arr|list|kids|items|keys|cols|ids|elements|buttons|out|parts)$/.test(receiver), `array indexOf on ${receiver}`);
  }
});
