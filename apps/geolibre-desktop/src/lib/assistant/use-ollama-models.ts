import { useEffect, useState } from "react";
import { fetchOllamaModels } from "./ollama-models";

/**
 * The models an Ollama server actually has.
 *
 * Ollama runs on the user's own machine, so unlike a hosted provider its real
 * model list is knowable — offering the hardcoded suggestions instead names
 * models this machine may never have pulled, and picking one of those produces
 * a profile that fails on first use.
 *
 * A hook rather than inline effects because `AiSectionContent` needs this in
 * two places (the new-profile form and the profile editor) and that file is a
 * large upstream component: every line of ours in it is a line an upstream
 * change can collide with. It keeps one call site each; the logic lives here.
 *
 * @param provider - The selected provider id. Anything but `ollama` resolves to
 *   the suggestions unchanged.
 * @param baseUrl - The configured `OLLAMA_BASE_URL`, or empty for the default.
 *   Re-read when it changes: it decides which server answers.
 * @param suggested - The provider's hardcoded model list, used when this is not
 *   Ollama or the server did not answer.
 * @returns `models` to offer, and `installed` — empty when the server did not
 *   answer, which is what tells a caller to say so.
 */
export function useOllamaModels(
  provider: string,
  baseUrl: string,
  suggested: readonly string[],
): { models: readonly string[]; installed: readonly string[] } {
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    if (provider !== "ollama") {
      setModels([]);
      return;
    }
    const controller = new AbortController();
    void fetchOllamaModels(baseUrl, controller.signal).then(
      (names) => {
        if (!controller.signal.aborted) setModels(names);
      },
      () => {
        // Aborted or unreachable. Left empty on purpose: the caller's
        // suggestion list stands in, so a stopped Ollama shows a usable field
        // rather than an empty one.
      },
    );
    return () => controller.abort();
  }, [provider, baseUrl]);

  return { models: models.length > 0 ? models : suggested, installed: models };
}
