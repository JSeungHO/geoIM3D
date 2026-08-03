/**
 * Lists the models an Ollama server actually has.
 *
 * `PROVIDER_MODELS.ollama` is a hardcoded suggestion list, which for a local
 * server is a guess that is usually wrong: the user's machine has whatever they
 * pulled, and picking a name that is not installed fails at send time with a
 * bare `404 model 'x' not found`. Ollama publishes the real list, so ask it.
 *
 * Failure is not an error state here — the server may simply not be running
 * yet, and the caller falls back to the suggestion list.
 */

/** Ollama's default listen address, used when no base URL is configured yet. */
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

/** Short enough that a wrong or dead base URL does not stall the Settings UI. */
const REQUEST_TIMEOUT_MS = 3_000;

/**
 * Fetches the installed model names from an Ollama server.
 *
 * @param baseUrl - The server base URL; falsy values fall back to the default.
 * @param signal - Optional abort signal, so a re-render can cancel a stale read.
 * @returns The model names (e.g. `llama3.2:latest`), or an empty array when the
 *   server cannot be reached or answers with anything unexpected.
 */
export async function fetchOllamaModels(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const base = (baseUrl.trim() || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
  // The OpenAI-compatible path is /v1; the model list lives on Ollama's own API,
  // so strip a trailing /v1 the user may have pasted from another client.
  const root = base.replace(/\/v1$/, "");

  let payload: unknown;
  try {
    const response = await fetch(`${root}/api/tags`, {
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    payload = await response.json();
  } catch {
    // Not running, wrong URL, or blocked by CORS. The caller shows the
    // suggestion list instead of an error: nothing is broken yet.
    return [];
  }

  const models = (payload as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  const names = models
    .map((entry) => (entry as { name?: unknown })?.name)
    .filter((name): name is string => typeof name === "string" && name.trim() !== "")
    .map((name) => name.trim());
  // Ollama can list the same model under several tags; keep the order it gave
  // (most recently pulled first) and drop repeats.
  return [...new Set(names)];
}

/**
 * Whether a chosen model is present in a fetched list.
 *
 * Ollama resolves a bare name to its `:latest` tag, so `llama3.2` matches an
 * installed `llama3.2:latest`. Without that, a perfectly valid saved profile
 * would be flagged as missing.
 *
 * @param modelId - The model id saved on the profile.
 * @param installed - Model names from {@link fetchOllamaModels}.
 * @returns True when the model is installed, or when the list is unknown.
 */
export function isOllamaModelInstalled(modelId: string, installed: readonly string[]): boolean {
  const wanted = modelId.trim();
  // An empty list means "could not ask", not "nothing installed" — do not warn.
  if (!wanted || installed.length === 0) return true;
  return installed.some((name) => name === wanted || name === `${wanted}:latest`);
}
