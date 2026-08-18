import { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildOllamaEnv } from "./env.js";
import { CLAUDE_BIN, STATE_DIR, JOB_TIMEOUT_MS } from "./config.js";
import { resolveClaudeBin, spawnClaude, killTree } from "./platform.js";
import type { PermissionMode as PermMode } from "./settings.js";

/** Resolved once: on Windows this turns "claude" into a concrete .exe/.cmd path. */
const CLAUDE_EXECUTABLE = resolveClaudeBin(CLAUDE_BIN);

export type JobState = "running" | "completed" | "failed" | "cancelled";

export type { PermissionMode } from "./settings.js";

export interface ProgressEvent {
  at: number;
  kind: "tool" | "text" | "thinking" | "error";
  detail: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
  durationMs?: number;
}

export interface Job {
  id: string;
  sessionId: string;
  /** Conversation turn number; 1 for a fresh delegate, 2+ for follow-ups. */
  turn: number;
  parentJobId?: string;
  model: string;
  cwd: string;
  permissionMode: PermMode;
  state: JobState;
  startedAt: number;
  endedAt?: number;
  dir: string;
  promptFile: string;
  streamFile: string;
  prompt: string;
  progress: ProgressEvent[];
  resultText?: string;
  errorText?: string;
  isError?: boolean;
  usage?: Usage;
  exitCode?: number | null;
  proc?: ChildProcess;
  waiters: Array<() => void>;
  timer?: NodeJS.Timeout;
}

const jobs = new Map<string, Job>();
const MAX_PROGRESS = 200;

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Find the newest job carrying this Claude Code session id. */
export function findBySession(sessionId: string): Job | undefined {
  return listJobs().find((j) => j.sessionId === sessionId);
}

export interface StartOptions {
  prompt: string;
  model: string;
  cwd: string;
  permissionMode: PermMode;
  /** Resume an existing Claude Code session instead of starting a new one. */
  resumeSessionId?: string;
  parentJobId?: string;
  turn: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  appendSystemPrompt?: string;
  maxTurns?: number;
  addDirs?: string[];
}

function record(job: Job, kind: ProgressEvent["kind"], detail: string): void {
  job.progress.push({ at: Date.now(), kind, detail });
  if (job.progress.length > MAX_PROGRESS) job.progress.splice(0, job.progress.length - MAX_PROGRESS);
}

function settle(job: Job, state: JobState): void {
  if (job.state !== "running") return;
  job.state = state;
  job.endedAt = Date.now();
  if (job.timer) clearTimeout(job.timer);
  job.proc = undefined;

  try {
    fs.writeFileSync(
      path.join(job.dir, "result.json"),
      JSON.stringify(
        {
          id: job.id,
          sessionId: job.sessionId,
          turn: job.turn,
          model: job.model,
          cwd: job.cwd,
          state: job.state,
          isError: job.isError,
          usage: job.usage,
          exitCode: job.exitCode,
          errorText: job.errorText,
          startedAt: job.startedAt,
          endedAt: job.endedAt,
        },
        null,
        2,
      ),
    );
    if (job.resultText !== undefined) {
      fs.writeFileSync(path.join(job.dir, "result.txt"), job.resultText);
    }
  } catch {
    // Persistence is best-effort; an unwritable state dir must not fail the job.
  }

  for (const wake of job.waiters.splice(0)) wake();
}

/** Interpret one line of Claude Code's stream-json output. */
function handleEvent(job: Job, evt: any, streamOut: fs.WriteStream): void {
  streamOut.write(JSON.stringify(evt) + "\n");

  if (typeof evt?.session_id === "string" && evt.session_id) {
    job.sessionId = evt.session_id;
  }

  if (evt?.type === "assistant" && Array.isArray(evt?.message?.content)) {
    for (const block of evt.message.content) {
      if (block?.type === "tool_use") {
        const input = block.input ?? {};
        const hint =
          input.command ?? input.file_path ?? input.pattern ?? input.path ?? input.description ?? "";
        record(job, "tool", `${block.name}${hint ? `: ${String(hint).slice(0, 160)}` : ""}`);
      } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        record(job, "text", block.text.slice(0, 400));
      } else if (block?.type === "thinking") {
        record(job, "thinking", "(thinking)");
      }
    }
  }

  if (evt?.type === "result") {
    job.isError = Boolean(evt.is_error) || evt.subtype !== "success";
    if (typeof evt.result === "string") job.resultText = evt.result;
    job.usage = {
      inputTokens: evt?.usage?.input_tokens,
      outputTokens: evt?.usage?.output_tokens,
      numTurns: evt?.num_turns,
      durationMs: evt?.duration_ms,
    };
    if (job.isError && !job.errorText) {
      job.errorText = evt.api_error_status || evt.subtype || "delegated session reported an error";
    }
  }
}

export function startJob(opts: StartOptions): Job {
  const id = randomUUID();
  const dir = path.join(STATE_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const promptFile = path.join(dir, "prompt.txt");
  const streamFile = path.join(dir, "stream.jsonl");
  // The prompt is written to disk and fed to the CLI over stdin, so arbitrary
  // content -- quotes, backticks, $(...), newlines -- is passed through
  // verbatim with no shell or argv escaping involved.
  fs.writeFileSync(promptFile, opts.prompt, "utf8");

  const sessionId = opts.resumeSessionId ?? randomUUID();

  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    // No MCP servers in the delegate: keeps startup fast and stops it from
    // recursively calling this server.
    "--strict-mcp-config",
    "--permission-mode",
    opts.permissionMode,
  ];

  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  else args.push("--session-id", sessionId);

  if (opts.allowedTools?.length) args.push("--allowed-tools", ...opts.allowedTools);
  if (opts.disallowedTools?.length) args.push("--disallowed-tools", ...opts.disallowedTools);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts.maxTurns !== undefined) args.push("--max-turns", String(opts.maxTurns));
  for (const d of opts.addDirs ?? []) args.push("--add-dir", d);

  const job: Job = {
    id,
    sessionId,
    turn: opts.turn,
    parentJobId: opts.parentJobId,
    model: opts.model,
    cwd: opts.cwd,
    permissionMode: opts.permissionMode,
    state: "running",
    startedAt: Date.now(),
    dir,
    promptFile,
    streamFile,
    prompt: opts.prompt,
    progress: [],
    waiters: [],
  };
  jobs.set(id, job);

  const stdinFd = fs.openSync(promptFile, "r");
  const streamOut = fs.createWriteStream(streamFile);

  let proc: ChildProcess;
  try {
    proc = spawnClaude(CLAUDE_EXECUTABLE, args, {
      cwd: opts.cwd,
      // Explicit env object -- the parent session's variables are never mutated
      // and never inherited.
      env: buildOllamaEnv(opts.model),
      stdio: [stdinFd, "pipe", "pipe"],
    });
  } catch (err) {
    fs.closeSync(stdinFd);
    job.errorText = `Failed to launch ${CLAUDE_EXECUTABLE}: ${(err as Error).message}`;
    job.isError = true;
    settle(job, "failed");
    return job;
  }

  job.proc = proc;
  proc.on("spawn", () => {
    try {
      fs.closeSync(stdinFd);
    } catch {
      // Already closed by the child.
    }
  });

  let buffer = "";
  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        handleEvent(job, JSON.parse(line), streamOut);
      } catch {
        // Non-JSON noise on stdout (e.g. warnings) is not fatal.
      }
    }
  });

  let stderr = "";
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
  });

  proc.on("error", (err) => {
    job.errorText = `${CLAUDE_EXECUTABLE} failed: ${err.message}`;
    job.isError = true;
    record(job, "error", err.message);
    streamOut.end();
    settle(job, "failed");
  });

  proc.on("close", (code) => {
    job.exitCode = code;
    streamOut.end();
    if (job.state !== "running") return; // cancelled or already failed
    if (code === 0 && !job.isError) {
      settle(job, "completed");
    } else {
      job.isError = true;
      job.errorText ||= stderr.trim() || `claude exited with code ${code}`;
      settle(job, "failed");
    }
  });

  job.timer = setTimeout(() => {
    if (job.state !== "running") return;
    job.errorText = `Timed out after ${Math.round(JOB_TIMEOUT_MS / 1000)}s`;
    job.isError = true;
    killTree(proc, "SIGKILL");
    settle(job, "failed");
  }, JOB_TIMEOUT_MS);

  return job;
}

export function cancelJob(job: Job): boolean {
  if (job.state !== "running") return false;
  const proc = job.proc;
  if (proc) {
    killTree(proc, "SIGTERM");
    // Escalate if the tree is still up shortly after.
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) killTree(proc, "SIGKILL");
    }, 3_000).unref?.();
  }
  job.errorText = "Cancelled by caller";
  settle(job, "cancelled");
  return true;
}

/** Resolve once the job settles, or after `seconds` elapse -- whichever is first. */
export function waitForJob(job: Job, seconds: number): Promise<void> {
  if (job.state !== "running" || seconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, seconds * 1000);
    job.waiters.push(finish);
  });
}


/**
 * Detached children survive their parent by design, so the server must take its
 * delegates down with it rather than leaving orphaned CLI processes behind.
 */
function killAllRunning(): void {
  for (const job of jobs.values()) {
    if (job.state === "running" && job.proc) killTree(job.proc, "SIGKILL");
  }
}

for (const signal of ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    killAllRunning();
    if (signal !== "exit") process.exit(0);
  });
}
