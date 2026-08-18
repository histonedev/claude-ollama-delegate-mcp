import { loadSettings, type Settings } from "./settings.js";

/**
 * Settings are resolved once at startup and never mutated at runtime. Nothing
 * reachable by the model can change them: delegation policy is edited by the
 * user via the ollama-mcp-config CLI (or the config files) and takes effect on
 * the next server start.
 */
export const SETTINGS: Settings = loadSettings();

export const OLLAMA_BASE_URL = SETTINGS.baseUrl;
export const CLAUDE_BIN = SETTINGS.claudeBin;
export const STATE_DIR = SETTINGS.stateDir;
export const JOB_TIMEOUT_MS = SETTINGS.jobTimeoutMs;
export const MAX_INLINE_CHARS = SETTINGS.maxInlineChars;

/** Default seconds a wait-enabled tool call blocks before returning "still running". */
export const DEFAULT_WAIT_SECONDS = Number(process.env.OLLAMA_MCP_DEFAULT_WAIT || 0);
