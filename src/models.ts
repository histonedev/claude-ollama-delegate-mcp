import { OLLAMA_BASE_URL, SETTINGS } from "./config.js";
import { isModelAllowed } from "./settings.js";

export interface OllamaModel {
  id: string;
  cloud: boolean;
  /** False when an allowlist is configured and excludes this model. */
  allowed: boolean;
}

/** Ask the Ollama server which models it can serve. */
export async function listModels(): Promise<OllamaModel[]> {
  const res = await fetch(`${OLLAMA_BASE_URL}/v1/models`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Ollama at ${OLLAMA_BASE_URL} returned HTTP ${res.status} for /v1/models`);
  }
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? [])
    .map((m) => String(m.id ?? ""))
    .filter(Boolean)
    .map((id) => ({
      id,
      cloud: id.endsWith(":cloud") || id.includes("-cloud"),
      allowed: isModelAllowed(id, SETTINGS.allowedModels),
    }));
}

let cachedDefault: string | null = null;

/** Invalidated whenever the allowlist or default model changes at runtime. */
export function clearModelCache(): void {
  cachedDefault = null;
}

/**
 * Resolve the model for a delegate call: explicit argument, then the configured
 * default, then the first allowed cloud model, then the first allowed model.
 * An explicit model outside the allowlist is rejected rather than silently
 * swapped, so the caller learns why.
 */
export async function resolveModel(requested?: string): Promise<string> {
  const allowed = SETTINGS.allowedModels;
  const explicit = requested?.trim();

  if (explicit) {
    if (!isModelAllowed(explicit, allowed)) {
      throw new Error(
        `Model "${explicit}" is not in the allowed list. Allowed: ${allowed.join(", ")}. ` +
          `The user can change this with \`ollama-mcp-config --allow <models>\`.`,
      );
    }
    return explicit;
  }

  if (SETTINGS.defaultModel) {
    if (!isModelAllowed(SETTINGS.defaultModel, allowed)) {
      throw new Error(
        `Configured default model "${SETTINGS.defaultModel}" is not in the allowed list ` +
          `(${allowed.join(", ")}). The user can fix this with \`ollama-mcp-config\`.`,
      );
    }
    return SETTINGS.defaultModel;
  }

  if (cachedDefault) return cachedDefault;

  const models = (await listModels()).filter((m) => m.allowed);
  if (models.length === 0) {
    throw new Error(
      allowed.length
        ? `None of the allowed models (${allowed.join(", ")}) are available from Ollama at ${OLLAMA_BASE_URL}.`
        : `No models available from Ollama at ${OLLAMA_BASE_URL}. Pull one with \`ollama pull <model>\`.`,
    );
  }
  cachedDefault = (models.find((m) => m.cloud) ?? models[0]).id;
  return cachedDefault;
}

/** Confirm the Ollama server is reachable, with a helpful error if not. */
export async function assertReachable(): Promise<void> {
  try {
    await fetch(`${OLLAMA_BASE_URL}/api/version`, { signal: AbortSignal.timeout(5_000) });
  } catch (err) {
    throw new Error(
      `Cannot reach Ollama at ${OLLAMA_BASE_URL}. Is \`ollama serve\` running? (${(err as Error).message})`,
    );
  }
}
