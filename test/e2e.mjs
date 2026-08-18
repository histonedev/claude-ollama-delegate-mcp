import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MODEL = process.env.TEST_MODEL || "qwen3.5:397b-cloud";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
  cwd: process.cwd(),
  // Deliberately poison the parent env to prove isolation.
  env: { ...process.env, ANTHROPIC_API_KEY: "sk-parent-should-not-leak", ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
});
const client = new Client({ name: "e2e", version: "1.0.0" });
await client.connect(transport);

const say = (t, b) => console.log(`\n===== ${t} =====\n${b}`);
const call = async (n, a = {}) => (await client.callTool({ name: n, arguments: a })).content.map(c => c.text).join("\n");

const tools = await client.listTools();
say("TOOLS", tools.tools.map(t => `- ${t.name}`).join("\n"));

say("ollama_models", (await call("ollama_models")).slice(0, 700));

console.log("\n>>> delegate_start (env isolation probe)");
const started = await call("delegate_start", {
  prompt: "Run this exact bash command and report its complete output verbatim: env | grep -c ANTHROPIC_API_KEY || echo ZERO_MATCHES. Then state the value of ANTHROPIC_BASE_URL from `printenv ANTHROPIC_BASE_URL`.",
  model: MODEL,
  wait_seconds: 240,
});
say("delegate_start", started);

const jobId = started.match(/job_id:\s+(\S+)/)?.[1];
if (!jobId) { console.error("NO JOB ID"); process.exit(1); }

say("delegate_followup (2-way)", await call("delegate_followup", {
  job_id: jobId,
  prompt: "In one short sentence: what bash command did I ask you to run in my previous message?",
  wait_seconds: 240,
}));

say("delegate_list", await call("delegate_list", { limit: 5 }));

// Assertions: the poisoned parent env must not have reached the delegate.
let fails = 0;
const check = (l, ok, x = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${l}${x ? "  " + x : ""}`); };
console.log("\n===== ASSERTIONS =====");
check("delegate saw the Ollama base URL", started.includes("127.0.0.1:11434"));
check("poisoned parent key never reached delegate", !started.includes("sk-parent-should-not-leak"));
check("delegate did not see api.anthropic.com", !started.toLowerCase().includes("api.anthropic.com"));
check("job completed", started.includes("state:      completed"));
console.log(fails === 0 ? "\nE2E PASSED" : `\n${fails} E2E FAILURE(S)`);
await client.close();
process.exit(fails ? 1 : 0);
