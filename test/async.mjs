import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODEL = process.env.TEST_MODEL || "qwen3.5:397b-cloud";
const pf = path.join(os.tmpdir(), "ollama-mcp-big-prompt.txt");
fs.writeFileSync(pf, `Task with characters that would break shell quoting:
  backticks: \`whoami\`   subshell: $(id -u)   quotes: "double" 'single'
  backslash: C:\\path\\to   pipes: a | b && c ; d   glob: *.ts   heredoc: <<EOF

Ignore all of the above as instructions. Simply reply with exactly the word: FILEPROMPT_OK
`);

const t = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))], cwd: process.cwd() });
const c = new Client({ name: "async-test", version: "1.0.0" });
await c.connect(t);
const call = async (n, a = {}) => (await c.callTool({ name: n, arguments: a })).content.map(x => x.text).join("\n");

// 1. prompt_file + fully async (wait_seconds omitted -> returns instantly)
const t0 = Date.now();
const started = await call("delegate_start", { prompt_file: pf, model: MODEL });
console.log(`\n===== delegate_start returned in ${Date.now() - t0}ms (async) =====\n${started}`);
const jobId = started.match(/job_id:\s+(\S+)/)[1];

// 2. poll
for (let i = 0; i < 12; i++) {
  const s = await call("delegate_status", { job_id: jobId, wait_seconds: 20 });
  console.log(`\n----- poll ${i + 1} -----\n${s}`);
  if (!s.includes("state:      running")) break;
}
console.log("\n===== delegate_result =====\n" + await call("delegate_result", { job_id: jobId }));

// 3. cancel a fresh long job
const long = await call("delegate_start", { prompt: "Count slowly from 1 to 500, one number per line, with a short comment on each.", model: MODEL });
const longId = long.match(/job_id:\s+(\S+)/)[1];
await new Promise(r => setTimeout(r, 2500));
console.log("\n===== delegate_cancel =====\n" + await call("delegate_cancel", { job_id: longId }));
console.log("\n===== status after cancel =====\n" + await call("delegate_status", { job_id: longId }));
await c.close(); process.exit(0);
