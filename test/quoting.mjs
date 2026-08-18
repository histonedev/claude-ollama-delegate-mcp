import { argvQuote, cmdEscape, assertCmdSafe } from "../dist/platform.js";
let fail = 0;
const eq = (label, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};
// MSVCRT argv quoting rules
eq("plain",              argvQuote("simple"),        "simple");
eq("space",              argvQuote("has space"),     '"has space"');
eq("embedded quote",     argvQuote('say "hi"'),      '"say \\"hi\\""');
eq("windows path",       argvQuote("C:\\Program"),   "C:\\Program");
eq("path w/ space",      argvQuote("C:\\Pro gram\\"), '"C:\\Pro gram\\\\"');
eq("empty",              argvQuote(""),              '""');
eq("backslash+quote",    argvQuote('a\\"b'),         '"a\\\\\\"b"');
// cmd.exe metacharacter escaping (the command-injection layer)
eq("cmd metachars",      cmdEscape('a&b|c>d<e^f"g'), 'a^&b^|c^>d^<e^^f^"g');
eq("cmd percent/bang",   cmdEscape("%PATH% !x!"),    "^%PATH^% ^!x^!");
// combined: a malicious tool name cannot break out
const evil = 'x" & calc.exe & "';
const combined = cmdEscape(argvQuote(evil));
console.log(`\nINJECTION probe\n  raw      ${JSON.stringify(evil)}\n  shipped  ${JSON.stringify(combined)}`);
const unescaped = combined.replace(/\^(.)/g, "$1");   // what cmd.exe hands onward
eq("survives cmd layer", unescaped, argvQuote(evil));
console.log(`  no bare '&' left for cmd: ${/(?<!\^)&/.test(combined) ? "NO -- INJECTABLE" : "yes"}`);
// newline guard
try { assertCmdSafe(["ok", "two\nlines"], "claude.cmd"); console.log("FAIL  newline guard did not throw"); fail++; }
catch (e) { console.log(`PASS  newline guard: ${e.message.slice(0, 60)}...`); }
console.log(fail === 0 ? "\nALL QUOTING TESTS PASSED" : `\n${fail} FAILURE(S)`);
process.exit(fail ? 1 : 0);
