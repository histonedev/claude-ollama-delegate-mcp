#!/usr/bin/env node
/**
 * Shell front-end for ollama-mcp's settings. This is deliberately the ONLY way
 * to change delegation policy: exposing it as an MCP tool would let the model
 * relax its own guardrail. A running server reads config at startup, so changes
 * here apply to the next session.
 */
import {
  loadSettings,
  saveSettings,
  describeSources,
  isModelAllowed,
  isDelegationMode,
  isPermissionMode,
  USER_CONFIG_PATH,
  PROJECT_CONFIG_PATH,
} from "./settings.js";

const USAGE = `ollama-mcp-config -- read or change ollama-mcp settings

Usage:
  ollama-mcp-config                          Show current settings
  ollama-mcp-config --mode <off|ondemand|auto>
  ollama-mcp-config --allow <m1,m2|all>      Restrict delegation to these models
  ollama-mcp-config --default-model <model|auto>
  ollama-mcp-config --permission-mode <auto|acceptEdits|bypassPermissions|manual|dontAsk|plan>
  ollama-mcp-config --scope <user|project>   Where to write (default: user)

Modes:
  off        delegate_* tools are hidden entirely
  ondemand   delegate only when the user explicitly asks (default)
  auto       the orchestrator decides for itself

Changes apply to the next server start -- restart your Claude Code session
afterwards. This CLI is the only way to change these settings; there is no MCP
tool for it, so the model cannot alter its own delegation policy.`;

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n\n${USAGE}\n`);
  process.exit(1);
}

function value(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) die(`${flag} needs a value`);
  return v;
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(USAGE + "\n");
  process.exit(0);
}

const patch: Record<string, unknown> = {};
let scope: "user" | "project" = "user";

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  switch (arg) {
    case "--mode": {
      const v = value(argv, i++, "--mode");
      if (!isDelegationMode(v)) die(`invalid mode "${v}" (off|ondemand|auto)`);
      patch.delegationMode = v;
      break;
    }
    case "--allow": {
      const v = value(argv, i++, "--allow");
      patch.allowedModels = v === "all" ? [] : v.split(",").map((m) => m.trim()).filter(Boolean);
      break;
    }
    case "--default-model": {
      const v = value(argv, i++, "--default-model");
      patch.defaultModel = v === "auto" ? "" : v.trim();
      break;
    }
    case "--permission-mode": {
      const v = value(argv, i++, "--permission-mode");
      if (!isPermissionMode(v)) die(`invalid permission mode "${v}"`);
      patch.defaultPermissionMode = v;
      break;
    }
    case "--scope": {
      const v = value(argv, i++, "--scope");
      if (v !== "user" && v !== "project") die(`invalid scope "${v}" (user|project)`);
      scope = v;
      break;
    }
    default:
      die(`unknown argument "${arg}"`);
  }
}

const before = loadSettings();

if (Object.keys(patch).length > 0) {
  const allowed = (patch.allowedModels as string[] | undefined) ?? before.allowedModels;
  const def = (patch.defaultModel as string | undefined) ?? before.defaultModel;
  if (def && !isModelAllowed(def, allowed)) {
    die(
      `default model "${def}" is not in the allowed list (${allowed.join(", ")}). ` +
        `Pass --default-model too, or --default-model auto.`,
    );
  }
  const file = saveSettings(patch, scope);
  process.stdout.write(`Wrote ${file}\n\n`);
}

const s = loadSettings();
process.stdout.write(
  [
    "Current settings:",
    `  delegation_mode:         ${s.delegationMode}`,
    `  allowed_models:          ${s.allowedModels.length ? s.allowedModels.join(", ") : "(all)"}`,
    `  default_model:           ${s.defaultModel || "(auto-pick first allowed cloud model)"}`,
    `  default_permission_mode: ${s.defaultPermissionMode}`,
    `  base_url:                ${s.baseUrl}`,
    "",
    "Config layers (later wins):",
    ...describeSources().map((x) => `  ${x}`),
    "",
    `User config:    ${USER_CONFIG_PATH}`,
    `Project config: ${PROJECT_CONFIG_PATH}`,
    "",
    Object.keys(patch).length
      ? "Restart the MCP server (or your Claude Code session) to pick this up."
      : "",
  ]
    .filter(Boolean)
    .join("\n") + "\n",
);
