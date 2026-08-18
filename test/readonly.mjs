import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const CFG = process.env.CFG_PATH, CWD = process.env.CFG_CWD;
const boot = async () => {
  const t = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))], cwd: CWD, env: { ...process.env, OLLAMA_MCP_CONFIG: CFG } });
  const c = new Client({ name: "ro", version: "1.0.0" }); await c.connect(t); return c;
};
let fails = 0;
const check = (l, ok, x = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${l}${x ? "  " + x : ""}`); };

let c = await boot();
let tools = (await c.listTools()).tools;
console.log("tools exposed:", tools.map(t => t.name).join(", "));
check("no config tool exposed", !tools.some(t => /config|settings/i.test(t.name)), tools.map(t=>t.name).join(","));
// No tool anywhere accepts a parameter that could rewrite policy.
const WRITE_PARAMS = ["delegation_mode", "allowed_models", "default_model", "default_permission_mode", "scope"];
const offenders = tools.flatMap(t => WRITE_PARAMS.filter(pn => Object.keys(t.inputSchema?.properties ?? {}).includes(pn)).map(pn => `${t.name}.${pn}`));
check("no tool accepts a policy-writing parameter", offenders.length === 0, offenders.join(",") || "none");
const d = tools.find(t => t.name === "delegate_start").description;
check("default still ondemand", d.includes("ON EXPLICIT REQUEST ONLY"));
check("description forbids self-modification", d.includes("not yours to change"));
check("ollama_models states read-only", tools.find(t => t.name === "ollama_models").description.includes("no tool to change them"));
await c.close();

// CLI is the only writer; verify a change takes effect on the next boot.
const { execFileSync } = await import("node:child_process");
execFileSync(process.execPath, ["dist/cli.js", "--mode", "auto"], { env: { ...process.env, OLLAMA_MCP_CONFIG: CFG } });
check("CLI persisted the change", JSON.parse(fs.readFileSync(CFG, "utf8")).delegationMode === "auto");
c = await boot();
const d2 = (await c.listTools()).tools.find(t => t.name === "delegate_start").description;
check("new session picks up auto policy", d2.includes("PROACTIVELY, YOUR CALL"));
await c.close();

execFileSync(process.execPath, ["dist/cli.js", "--mode", "off"], { env: { ...process.env, OLLAMA_MCP_CONFIG: CFG } });
c = await boot();
const names = (await c.listTools()).tools.map(t => t.name);
check("off hides delegate tools", !names.includes("delegate_start"), names.join(","));
check("but leaves ollama_models to report state", names.includes("ollama_models"));
await c.close();
console.log(fails === 0 ? "\nALL READ-ONLY TESTS PASSED" : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
