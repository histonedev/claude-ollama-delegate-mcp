#!/usr/bin/env node
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { listModels, resolveModel, assertReachable } from "./models.js";
import { describeOllamaEnv } from "./env.js";
import { buildDescriptions, OFF_NOTICE } from "./descriptions.js";
import {
  startJob,
  getJob,
  listJobs,
  findBySession,
  cancelJob,
  waitForJob,
  type Job,
} from "./jobs.js";
import {
  SETTINGS,
  OLLAMA_BASE_URL,
  MAX_INLINE_CHARS,
  DEFAULT_WAIT_SECONDS,
  STATE_DIR,
} from "./config.js";
import {
  describeSources,
  isModelAllowed,
  USER_CONFIG_PATH,
  PROJECT_CONFIG_PATH,
  type PermissionMode,
} from "./settings.js";

const PERMISSION_MODES = [
  "auto",
  "acceptEdits",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
] as const;

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

function fail(body: string) {
  return { content: [{ type: "text" as const, text: body }], isError: true };
}

/** Accept a prompt inline or as a file path; exactly one must be supplied. */
function readPrompt(prompt?: string, promptFile?: string): string {
  if (promptFile) {
    const resolved = path.resolve(promptFile);
    if (!fs.existsSync(resolved)) throw new Error(`prompt_file does not exist: ${resolved}`);
    const body = fs.readFileSync(resolved, "utf8");
    if (!body.trim()) throw new Error(`prompt_file is empty: ${resolved}`);
    return body;
  }
  if (prompt?.trim()) return prompt;
  throw new Error("Provide either `prompt` or `prompt_file`.");
}

function resolveCwd(cwd?: string): string {
  const target = path.resolve(cwd ?? process.cwd());
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error(`cwd is not an existing directory: ${target}`);
  }
  return target;
}

function elapsed(job: Job): string {
  const ms = (job.endedAt ?? Date.now()) - job.startedAt;
  return `${(ms / 1000).toFixed(1)}s`;
}

function summarise(job: Job): string {
  const lines = [
    `job_id:     ${job.id}`,
    `session_id: ${job.sessionId}   (turn ${job.turn})`,
    `state:      ${job.state}`,
    `model:      ${job.model}`,
    `cwd:        ${job.cwd}`,
    `elapsed:    ${elapsed(job)}`,
  ];
  if (job.usage?.inputTokens !== undefined || job.usage?.outputTokens !== undefined) {
    lines.push(
      `tokens:     in ${job.usage.inputTokens ?? "?"} / out ${job.usage.outputTokens ?? "?"}` +
        (job.usage.numTurns !== undefined ? `  (${job.usage.numTurns} turns)` : ""),
    );
  }
  const toolCalls = job.progress.filter((p) => p.kind === "tool").length;
  if (job.state !== "running") {
    lines.push(
      `tool calls: ${toolCalls}` +
        (toolCalls === 0
          ? "   <- answered without using any tools; treat factual claims as unverified"
          : ""),
    );
  }
  if (job.errorText) lines.push(`error:      ${job.errorText}`);
  return lines.join("\n");
}

function progressTail(job: Job, limit: number): string {
  const items = job.progress.filter((p) => p.kind !== "thinking").slice(-limit);
  if (items.length === 0) return "(no activity recorded yet)";
  return items.map((p) => `  [${p.kind}] ${p.detail.replace(/\s+/g, " ").trim()}`).join("\n");
}

function resultBody(job: Job): string {
  const body = job.resultText ?? "";
  if (body.length <= MAX_INLINE_CHARS) return body || "(delegated session produced no text output)";
  return (
    body.slice(0, MAX_INLINE_CHARS) +
    `\n\n... [truncated at ${MAX_INLINE_CHARS} chars; full output: ${path.join(job.dir, "result.txt")}]`
  );
}

/** Refuse delegate calls while the mode is "off". */
function offGuard() {
  return SETTINGS.delegationMode === "off" ? fail(OFF_NOTICE) : null;
}

const server = new McpServer({ name: "ollama-mcp", version: "1.1.0" });

const descriptions = buildDescriptions(
  SETTINGS.delegationMode,
  SETTINGS.allowedModels,
  SETTINGS.defaultModel,
);

// ---------------------------------------------------------------- ollama_models

server.registerTool(
  "ollama_models",
  { title: "List Ollama models", description: descriptions.ollama_models, inputSchema: {} },
  async () => {
    try {
      await assertReachable();
      const models = await listModels();
      const def = await resolveModel().catch((e) => `(unresolved: ${(e as Error).message})`);
      const rows = models.map(
        (m) =>
          `  ${m.allowed ? "  " : "x "}${m.id}${m.cloud ? "   [cloud]" : "   [local]"}` +
          (m.allowed ? "" : "   BLOCKED by allowedModels"),
      );
      return text(
        [
          `Ollama endpoint: ${OLLAMA_BASE_URL}`,
          `Delegation mode: ${SETTINGS.delegationMode}`,
          `Allowed models:  ${SETTINGS.allowedModels.length ? SETTINGS.allowedModels.join(", ") : "(all)"}`,
          `Default model:   ${def}`,
          `Permission mode: ${SETTINGS.defaultPermissionMode}`,
          "",
          "Available models:",
          rows.length ? rows.join("\n") : "  (none)",
          "",
          "Environment injected into delegated sessions (parent session untouched):",
          ...Object.entries(describeOllamaEnv(typeof def === "string" ? def : "")).map(
            ([k, v]) => `  ${k}=${v}`,
          ),
          "",
          "Config layers (later wins):",
          ...describeSources().map((x) => `  ${x}`),
          `  user config:    ${USER_CONFIG_PATH}`,
          `  project config: ${PROJECT_CONFIG_PATH}`,
          "",
          "These settings are user-controlled and read-only from here. To change them the",
          "user runs, in a terminal:",
          "  ollama-mcp-config --mode <off|ondemand|auto>",
          "  ollama-mcp-config --allow <model1,model2|all>",
          "then restarts the session.",
        ].join("\n"),
      );
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

// -------------------------------------------------------------- delegate tools

const delegateTools: Record<string, RegisteredTool> = {};

delegateTools.delegate_start = server.registerTool(
  "delegate_start",
  {
    title: "Delegate a task to an Ollama model",
    description: descriptions.delegate_start,
    inputSchema: {
      prompt: z.string().optional().describe("The task for the Ollama-backed session. Use prompt_file for long prompts."),
      prompt_file: z
        .string()
        .optional()
        .describe("Path to a file holding the prompt. Preferred for long or special-character-heavy prompts."),
      model: z.string().optional().describe("Ollama model id. Must be in the allowed list. Defaults to the configured default."),
      cwd: z.string().optional().describe("Working directory for the delegated session. Defaults to the server's cwd."),
      permission_mode: z.enum(PERMISSION_MODES).optional().describe("Permission mode for the delegate. Defaults to the configured default."),
      allowed_tools: z.array(z.string()).optional().describe("Tool allowlist, e.g. ['Read','Grep','Bash(git *)']."),
      disallowed_tools: z.array(z.string()).optional().describe("Tool denylist, e.g. ['Write','Edit']."),
      append_system_prompt: z.string().optional().describe("Extra instructions appended to the delegate's system prompt."),
      max_turns: z.number().int().positive().optional().describe("Cap the delegate's agentic turns."),
      add_dirs: z.array(z.string()).optional().describe("Additional directories the delegate may access."),
      wait_seconds: z.number().min(0).max(600).optional().describe("Block up to this many seconds for completion. Default 0."),
    },
  },
  async (args) => {
    const blocked = offGuard();
    if (blocked) return blocked;
    try {
      await assertReachable();
      const prompt = readPrompt(args.prompt, args.prompt_file);
      const model = await resolveModel(args.model);
      const cwd = resolveCwd(args.cwd);

      const job = startJob({
        prompt,
        model,
        cwd,
        permissionMode: (args.permission_mode ?? SETTINGS.defaultPermissionMode) as PermissionMode,
        turn: 1,
        allowedTools: args.allowed_tools,
        disallowedTools: args.disallowed_tools,
        appendSystemPrompt: args.append_system_prompt,
        maxTurns: args.max_turns,
        addDirs: args.add_dirs,
      });

      await waitForJob(job, args.wait_seconds ?? DEFAULT_WAIT_SECONDS);

      if (job.state === "running") {
        return text(
          `Delegated task started.\n\n${summarise(job)}\n\n` +
            `Still running. Poll with delegate_status({ job_id: "${job.id}" }).`,
        );
      }
      return text(
        `${summarise(job)}\n\n--- output ---\n${resultBody(job)}\n\n` +
          `Continue this conversation with delegate_followup({ job_id: "${job.id}", prompt: "..." }).`,
      );
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

delegateTools.delegate_followup = server.registerTool(
  "delegate_followup",
  {
    title: "Continue a delegated conversation",
    description: descriptions.delegate_followup,
    inputSchema: {
      job_id: z.string().optional().describe("A job_id from any earlier turn of the conversation."),
      session_id: z.string().optional().describe("The Claude Code session id, as an alternative to job_id."),
      prompt: z.string().optional().describe("The next message. Use prompt_file for long prompts."),
      prompt_file: z.string().optional().describe("Path to a file holding the next message."),
      permission_mode: z.enum(PERMISSION_MODES).optional().describe("Override the permission mode for this turn."),
      max_turns: z.number().int().positive().optional().describe("Cap the delegate's agentic turns for this turn."),
      wait_seconds: z.number().min(0).max(600).optional().describe("Block up to this many seconds before returning."),
    },
  },
  async (args) => {
    const blocked = offGuard();
    if (blocked) return blocked;
    try {
      const prior = args.job_id
        ? getJob(args.job_id)
        : args.session_id
          ? findBySession(args.session_id)
          : undefined;
      if (!prior) return fail("Unknown job_id/session_id. Use delegate_list to see active conversations.");
      if (prior.state === "running") {
        return fail(
          `Turn ${prior.turn} of this conversation is still running (job ${prior.id}). ` +
            `Wait for it to finish or cancel it before sending a follow-up.`,
        );
      }
      if (!isModelAllowed(prior.model, SETTINGS.allowedModels)) {
        return fail(
          `This conversation runs on "${prior.model}", which is no longer in the allowed list ` +
            `(${SETTINGS.allowedModels.join(", ")}).`,
        );
      }

      const prompt = readPrompt(args.prompt, args.prompt_file);
      const job = startJob({
        prompt,
        model: prior.model,
        cwd: prior.cwd,
        permissionMode: (args.permission_mode ?? prior.permissionMode) as PermissionMode,
        resumeSessionId: prior.sessionId,
        parentJobId: prior.id,
        turn: prior.turn + 1,
        maxTurns: args.max_turns,
      });

      await waitForJob(job, args.wait_seconds ?? DEFAULT_WAIT_SECONDS);

      if (job.state === "running") {
        return text(
          `Follow-up sent (turn ${job.turn}).\n\n${summarise(job)}\n\n` +
            `Poll with delegate_status({ job_id: "${job.id}" }).`,
        );
      }
      return text(`${summarise(job)}\n\n--- output ---\n${resultBody(job)}`);
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

delegateTools.delegate_status = server.registerTool(
  "delegate_status",
  {
    title: "Check a delegated task",
    description: descriptions.delegate_status,
    inputSchema: {
      job_id: z.string().describe("The job_id returned by delegate_start or delegate_followup."),
      wait_seconds: z.number().min(0).max(600).optional().describe("Block up to this many seconds waiting for completion."),
      progress_limit: z.number().int().min(1).max(100).optional().describe("How many recent activity lines to show. Default 15."),
    },
  },
  async (args) => {
    const job = getJob(args.job_id);
    if (!job) return fail(`Unknown job_id: ${args.job_id}`);
    await waitForJob(job, args.wait_seconds ?? 0);
    const body = [summarise(job), "", "recent activity:", progressTail(job, args.progress_limit ?? 15)];
    body.push(
      "",
      job.state === "running"
        ? `Still running. Call delegate_result({ job_id: "${job.id}" }) once it completes.`
        : `Finished. Get output with delegate_result({ job_id: "${job.id}" }).`,
    );
    return text(body.join("\n"));
  },
);

delegateTools.delegate_result = server.registerTool(
  "delegate_result",
  {
    title: "Get a delegated task's output",
    description: descriptions.delegate_result,
    inputSchema: {
      job_id: z.string().describe("The job_id to collect."),
      wait_seconds: z.number().min(0).max(600).optional().describe("Block up to this many seconds for the job to finish."),
    },
  },
  async (args) => {
    const job = getJob(args.job_id);
    if (!job) return fail(`Unknown job_id: ${args.job_id}`);
    await waitForJob(job, args.wait_seconds ?? 0);
    if (job.state === "running") {
      return text(
        `${summarise(job)}\n\nStill running -- no result yet.\n\nrecent activity:\n${progressTail(job, 15)}`,
      );
    }
    if (job.state !== "completed") {
      return fail(`${summarise(job)}\n\n--- partial output ---\n${resultBody(job)}`);
    }
    return text(
      `${summarise(job)}\n\n--- output ---\n${resultBody(job)}\n\n` +
        `Continue with delegate_followup({ job_id: "${job.id}", prompt: "..." }).`,
    );
  },
);

delegateTools.delegate_cancel = server.registerTool(
  "delegate_cancel",
  {
    title: "Cancel a delegated task",
    description: descriptions.delegate_cancel,
    inputSchema: { job_id: z.string().describe("The job_id to cancel.") },
  },
  async (args) => {
    const job = getJob(args.job_id);
    if (!job) return fail(`Unknown job_id: ${args.job_id}`);
    if (!cancelJob(job)) return text(`Job ${job.id} was already ${job.state}; nothing to cancel.`);
    return text(`Cancelled job ${job.id}.\n\n${summarise(job)}`);
  },
);

delegateTools.delegate_list = server.registerTool(
  "delegate_list",
  {
    title: "List delegated tasks",
    description: descriptions.delegate_list,
    inputSchema: {
      state: z.enum(["running", "completed", "failed", "cancelled"]).optional().describe("Filter by state."),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum jobs to list. Default 20."),
    },
  },
  async (args) => {
    let all = listJobs();
    if (args.state) all = all.filter((j) => j.state === args.state);
    all = all.slice(0, args.limit ?? 20);
    if (all.length === 0) return text("No delegated jobs recorded.");
    const rows = all.map((j) => {
      const head = j.prompt.replace(/\s+/g, " ").slice(0, 70);
      return (
        `${j.state.padEnd(9)} turn ${String(j.turn).padEnd(3)} ${elapsed(j).padStart(8)}  ${j.model}\n` +
        `  job ${j.id}\n  session ${j.sessionId}\n  "${head}${j.prompt.length > 70 ? "..." : ""}"`
      );
    });
    return text(`State dir: ${STATE_DIR}\n\n${rows.join("\n\n")}`);
  },
);

// Hide the delegate tools entirely when delegation is off.
if (SETTINGS.delegationMode === "off") {
  for (const tool of Object.values(delegateTools)) tool.disable();
}

const transport = new StdioServerTransport();
await server.connect(transport);
