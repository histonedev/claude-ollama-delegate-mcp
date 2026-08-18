import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DelegationMode = "off" | "ondemand" | "auto";

export type PermissionMode =
  | "auto"
  | "acceptEdits"
  | "bypassPermissions"
  | "manual"
  | "dontAsk"
  | "plan";

export interface Settings {
  baseUrl: string;
  /** Model used when a call omits one. Empty means "first allowed cloud model". */
  defaultModel: string;
  /** Models delegation may use. Empty means every model the server offers. */
  allowedModels: string[];
  /** How eagerly the orchestrator should reach for delegation. */
  delegationMode: DelegationMode;
  defaultPermissionMode: PermissionMode;
  claudeBin: string;
  stateDir: string;
  jobTimeoutMs: number;
  maxInlineChars: number;
}

export const USER_CONFIG_PATH =
  process.env.OLLAMA_MCP_CONFIG || path.join(os.homedir(), ".ollama-mcp", "config.json");

/** Project-level overrides, looked for in the directory the server was started in. */
export const PROJECT_CONFIG_PATH = path.resolve("ollama-mcp.config.json");

const DEFAULTS: Settings = {
  baseUrl: "http://127.0.0.1:11434",
  defaultModel: "",
  allowedModels: [],
  delegationMode: "ondemand",
  defaultPermissionMode: "auto",
  claudeBin: "claude",
  stateDir: path.join(os.homedir(), ".ollama-mcp", "jobs"),
  jobTimeoutMs: 30 * 60_000,
  maxInlineChars: 60_000,
};

/** Normalise "host:port", "http://host" or a bare host into a full URL. */
export function normaliseHost(raw: string): string {
  const v = raw.trim().replace(/\/+$/, "");
  if (!v) return DEFAULTS.baseUrl;
  return /^https?:\/\//i.test(v) ? v : `http://${v}`;
}

export function isDelegationMode(v: unknown): v is DelegationMode {
  return v === "off" || v === "ondemand" || v === "auto";
}

const PERMISSION_MODES: PermissionMode[] = [
  "auto",
  "acceptEdits",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
];

export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === "string" && (PERMISSION_MODES as string[]).includes(v);
}

function readJson(file: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    // A malformed config must not take the server down; warn on stderr, which
    // the MCP client surfaces in its logs, and fall through to defaults.
    process.stderr.write(`[ollama-mcp] ignoring unreadable config ${file}: ${(err as Error).message}\n`);
    return {};
  }
}

function applyFile(base: Settings, raw: Record<string, unknown>): Settings {
  const out = { ...base };
  if (typeof raw.baseUrl === "string") out.baseUrl = normaliseHost(raw.baseUrl);
  if (typeof raw.defaultModel === "string") out.defaultModel = raw.defaultModel.trim();
  if (Array.isArray(raw.allowedModels)) {
    out.allowedModels = raw.allowedModels.filter((m): m is string => typeof m === "string").map((m) => m.trim()).filter(Boolean);
  }
  if (isDelegationMode(raw.delegationMode)) out.delegationMode = raw.delegationMode;
  if (isPermissionMode(raw.defaultPermissionMode)) out.defaultPermissionMode = raw.defaultPermissionMode;
  if (typeof raw.claudeBin === "string" && raw.claudeBin.trim()) out.claudeBin = raw.claudeBin.trim();
  if (typeof raw.stateDir === "string" && raw.stateDir.trim()) out.stateDir = raw.stateDir.trim();
  if (Number.isFinite(raw.jobTimeoutMs)) out.jobTimeoutMs = Number(raw.jobTimeoutMs);
  if (Number.isFinite(raw.maxInlineChars)) out.maxInlineChars = Number(raw.maxInlineChars);
  return out;
}

function applyEnv(base: Settings): Settings {
  const out = { ...base };
  const e = process.env;
  if (e.OLLAMA_MCP_BASE_URL || e.OLLAMA_HOST) out.baseUrl = normaliseHost(e.OLLAMA_MCP_BASE_URL || e.OLLAMA_HOST!);
  if (e.OLLAMA_MCP_DEFAULT_MODEL?.trim()) out.defaultModel = e.OLLAMA_MCP_DEFAULT_MODEL.trim();
  if (e.OLLAMA_MCP_ALLOWED_MODELS?.trim()) {
    out.allowedModels = e.OLLAMA_MCP_ALLOWED_MODELS.split(",").map((m) => m.trim()).filter(Boolean);
  }
  if (isDelegationMode(e.OLLAMA_MCP_DELEGATION_MODE)) out.delegationMode = e.OLLAMA_MCP_DELEGATION_MODE;
  if (isPermissionMode(e.OLLAMA_MCP_PERMISSION_MODE)) out.defaultPermissionMode = e.OLLAMA_MCP_PERMISSION_MODE;
  if (e.OLLAMA_MCP_CLAUDE_BIN?.trim()) out.claudeBin = e.OLLAMA_MCP_CLAUDE_BIN.trim();
  if (e.OLLAMA_MCP_STATE_DIR?.trim()) out.stateDir = e.OLLAMA_MCP_STATE_DIR.trim();
  if (e.OLLAMA_MCP_JOB_TIMEOUT_MS && Number.isFinite(Number(e.OLLAMA_MCP_JOB_TIMEOUT_MS))) {
    out.jobTimeoutMs = Number(e.OLLAMA_MCP_JOB_TIMEOUT_MS);
  }
  if (e.OLLAMA_MCP_MAX_INLINE_CHARS && Number.isFinite(Number(e.OLLAMA_MCP_MAX_INLINE_CHARS))) {
    out.maxInlineChars = Number(e.OLLAMA_MCP_MAX_INLINE_CHARS);
  }
  return out;
}

/** Precedence, lowest to highest: defaults, user file, project file, environment. */
export function loadSettings(): Settings {
  let s = { ...DEFAULTS };
  s = applyFile(s, readJson(USER_CONFIG_PATH));
  s = applyFile(s, readJson(PROJECT_CONFIG_PATH));
  s = applyEnv(s);
  return s;
}

/** Which layers are actually present, for display in diagnostics. */
export function describeSources(): string[] {
  const out: string[] = ["built-in defaults"];
  if (fs.existsSync(USER_CONFIG_PATH)) out.push(`user config (${USER_CONFIG_PATH})`);
  if (fs.existsSync(PROJECT_CONFIG_PATH)) out.push(`project config (${PROJECT_CONFIG_PATH})`);
  const envKeys = Object.keys(process.env).filter((k) => k.startsWith("OLLAMA_MCP_") || k === "OLLAMA_HOST");
  if (envKeys.length) out.push(`environment (${envKeys.join(", ")})`);
  return out;
}

/**
 * Persist a patch to one of the config files, merging with whatever is already
 * there so unrelated keys survive.
 */
export function saveSettings(patch: Record<string, unknown>, scope: "user" | "project"): string {
  const file = scope === "project" ? PROJECT_CONFIG_PATH : USER_CONFIG_PATH;
  const existing = readJson(file);
  const merged = { ...existing, ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  return file;
}

/** An allowlist of [] means "no restriction". */
export function isModelAllowed(model: string, allowed: string[]): boolean {
  return allowed.length === 0 || allowed.includes(model);
}
