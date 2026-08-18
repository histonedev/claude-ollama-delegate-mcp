import type { DelegationMode } from "./settings.js";

/**
 * Tool descriptions are the only lever that steers how eagerly an orchestrator
 * reaches for a tool, so the delegation mode is expressed here rather than as a
 * runtime check. "ondemand" tells the caller to wait to be asked; "auto" tells
 * it to judge for itself and gives it the criteria to judge by.
 */

function modelLine(allowed: string[], def: string): string {
  const parts: string[] = [];
  if (allowed.length) parts.push(`Allowed models: ${allowed.join(", ")} (any other model is rejected).`);
  if (def) parts.push(`Default: ${def}.`);
  return parts.length ? `\n\n${parts.join(" ")}` : "";
}

const ONDEMAND_POLICY = `
WHEN TO USE — ON EXPLICIT REQUEST ONLY. Delegation mode is "ondemand". Call this \
only when the user actually asks for it: "delegate this", "use ollama", "ask qwen", \
"run this on a local model", or when they name an Ollama model. If the user has not \
asked for delegation, do the work yourself and do not offer this tool unprompted.

This policy is set by the user and is not yours to change. If it is getting in the way, say so and let the user run \`ollama-mcp-config\`; do not edit config files to widen it.`;

const AUTO_POLICY = `
WHEN TO USE — PROACTIVELY, YOUR CALL. Delegation mode is "auto". Delegate work that \
is self-contained, cheaply verifiable, and context-hungry: bulk file summarisation, \
first-pass searches across many files, mechanical refactors, boilerplate and test \
scaffolding, log or diff triage, and drafts you intend to review. Offloading these \
keeps your own context free for work that needs it.

KEEP FOR YOURSELF: architecture and design decisions, security-sensitive changes, \
anything with ambiguous requirements, and the final review of delegated output.

VERIFY RESULTS. Ollama models are weaker than you and will sometimes answer without \
actually running the tools they claim to have run. If a result asserts something about \
the repository, confirm the backing tool calls via delegate_status, or spot-check it.

This policy is set by the user and is not yours to change. If it is getting in the way, say so and let the user run \`ollama-mcp-config\`; do not edit config files to widen it.`;

function policy(mode: DelegationMode): string {
  return mode === "auto" ? AUTO_POLICY : ONDEMAND_POLICY;
}

export function buildDescriptions(
  mode: DelegationMode,
  allowedModels: string[],
  defaultModel: string,
): Record<string, string> {
  const models = modelLine(allowedModels, defaultModel);

  return {
    ollama_models:
      "List the Ollama models available for delegation, the current delegation mode and allowed-model " +
      "policy, and the environment variables a delegated session receives. Use this to pick a `model`, " +
      "or to report the current configuration when the user asks about it.\n\n" +
      "These settings are user-controlled. There is no tool to change them: if the user wants a " +
      "different delegation mode or model policy, tell them to run `ollama-mcp-config` in a terminal " +
      "and restart the session. Do not edit the config files yourself." +
      models,

    delegate_start:
      "Start a headless Claude Code session backed by an Ollama model and return immediately with a " +
      "job_id. It runs in its own process with its own environment, so your Anthropic credentials and " +
      "model settings are untouched. Poll with delegate_status, collect with delegate_result, and " +
      "continue the conversation with delegate_followup. Pass `prompt_file` for long prompts." +
      models +
      "\n" +
      policy(mode),

    delegate_followup:
      "Send another message to an existing delegated session, resuming its full conversation history. " +
      "Identify it by job_id (any turn) or session_id. Returns a new job_id for this turn while keeping " +
      "the same session_id, so you can go back and forth with the Ollama model." +
      (mode === "ondemand"
        ? "\n\nOnly continue conversations the user asked you to start."
        : "\n\nPrefer a follow-up over a fresh delegate_start when the delegate already has the relevant " +
          "context loaded — it is much cheaper than re-establishing it."),

    delegate_status:
      "Report whether a delegated job is still running, plus a tail of what the Ollama session has been " +
      "doing — its actual tool calls and partial text. Optionally block until it finishes. Use the tool-call " +
      "trace to check that a delegate really did the work it claims.",

    delegate_result:
      "Return the final text produced by a delegated Ollama session, plus its session_id for follow-ups. " +
      "Blocks until the job finishes if you pass wait_seconds.",

    delegate_cancel: "Terminate a running delegated Ollama session and everything it started.",

    delegate_list:
      "Show delegated jobs from this server's lifetime, newest first, grouped by conversation.",
  };
}

/** Shown when someone calls a delegate tool while delegation is off. */
export const OFF_NOTICE =
  'Delegation is disabled (delegationMode = "off"). This is a user setting and you cannot ' +
  "change it. Tell the user to run `ollama-mcp-config --mode ondemand` (or `auto`) in a " +
  "terminal and restart the session, then do the work yourself in the meantime.";
