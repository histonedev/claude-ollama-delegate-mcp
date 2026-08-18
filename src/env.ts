import { OLLAMA_BASE_URL } from "./config.js";
import { IS_WINDOWS } from "./platform.js";

/**
 * Variables copied from the parent process. Everything else is dropped, so the
 * delegated session starts from a blank slate rather than inheriting whatever
 * credentials or Claude Code state the calling session happens to hold.
 */
const POSIX_PRESERVE = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  // Some Linux setups put the CLI's config and runtime state here.
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
];

/**
 * Windows needs considerably more than POSIX. SystemRoot and windir in
 * particular are not optional: strip them and Winsock fails to initialise, so
 * the child cannot open a socket even to localhost.
 */
const WINDOWS_PRESERVE = [
  "SystemRoot",
  "windir",
  "SystemDrive",
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "TEMP",
  "TMP",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "PUBLIC",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "PSMODULEPATH",
];

/** Platform-neutral entries appended to whichever list applies. */
const COMMON_PRESERVE = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  // TLS / proxy plumbing the CLI needs to reach the network at all.
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

const PRESERVE = [...(IS_WINDOWS ? WINDOWS_PRESERVE : POSIX_PRESERVE), ...COMMON_PRESERVE];

/**
 * Prefixes that must never reach the child even if someone adds them to
 * PRESERVE by accident. These are the vars that would otherwise point the
 * delegated session back at Anthropic (or at a third-party provider) and
 * silently bill the wrong account.
 */
const FORBIDDEN_PREFIXES = [
  "ANTHROPIC_",
  "CLAUDE_",
  "CLAUDECODE",
  "AWS_",
  "GOOGLE_",
  "GCLOUD_",
  "VERTEX_",
  "AZURE_",
  "OPENAI_",
  "BEDROCK_",
];

function isForbidden(key: string): boolean {
  return FORBIDDEN_PREFIXES.some((p) => key.toUpperCase().startsWith(p));
}

/**
 * Build the environment for a delegated Claude Code session.
 *
 * The parent session's own environment is never mutated: this returns a fresh
 * object that is handed to spawn(), so Anthropic-backed and Ollama-backed
 * sessions can run side by side in the same shell.
 */
export function buildOllamaEnv(model: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.create(null);

  // Match case-insensitively but copy the parent's original spelling: Windows
  // treats names case-insensitively, and some tools look for exact casing.
  const wanted = new Set(PRESERVE.map((k) => k.toUpperCase()));
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (!wanted.has(key.toUpperCase())) continue;
    if (isForbidden(key)) continue;
    env[key] = value;
  }

  // Point Claude Code at Ollama's Anthropic-compatible endpoint.
  env.ANTHROPIC_BASE_URL = OLLAMA_BASE_URL;
  env.ANTHROPIC_AUTH_TOKEN = "ollama";

  // Every model slot maps to the requested Ollama model, so aliases like
  // "opus" or "haiku" and any subagent spawned inside the delegate all resolve
  // to the same local model instead of falling back to an Anthropic default.
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  env.CLAUDE_CODE_SUBAGENT_MODEL = model;

  // Quality-of-life flags that `ollama launch claude` also sets.
  env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
  env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY = "1";
  env.DISABLE_FEEDBACK_COMMAND = "1";
  env.DISABLE_AUTOUPDATER = "1";

  return env;
}

/** The Ollama-specific variables, for display in diagnostics. */
export function describeOllamaEnv(model: string): Record<string, string> {
  const env = buildOllamaEnv(model);
  return Object.fromEntries(
    Object.entries(env)
      .filter(([k]) => k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE_") || k.startsWith("DISABLE_"))
      .map(([k, v]) => [k, String(v)]),
  );
}
