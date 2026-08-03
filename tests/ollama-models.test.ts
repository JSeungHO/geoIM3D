import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_OLLAMA_BASE_URL,
  fetchOllamaModels,
  isOllamaModelInstalled,
} from "../apps/geolibre-desktop/src/lib/assistant/ollama-models";

const originalFetch = globalThis.fetch;

function stubFetch(payload: unknown, options: { ok?: boolean; throws?: boolean } = {}) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (options.throws) throw new TypeError("Failed to fetch");
    return {
      ok: options.ok ?? true,
      json: async () => payload,
    } as Response;
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchOllamaModels", () => {
  it("reads the installed model names", async () => {
    const calls = stubFetch({
      models: [{ name: "llama3.2:latest" }, { name: "qwen3:8b" }, { name: "gemma3:latest" }],
    });
    const models = await fetchOllamaModels("http://localhost:11434");
    assert.deepEqual(models, ["llama3.2:latest", "qwen3:8b", "gemma3:latest"]);
    assert.equal(calls[0], "http://localhost:11434/api/tags");
  });

  it("falls back to the default address when no base URL is set", async () => {
    const calls = stubFetch({ models: [] });
    await fetchOllamaModels("   ");
    assert.equal(calls[0], `${DEFAULT_OLLAMA_BASE_URL}/api/tags`);
  });

  it("strips a trailing slash and an OpenAI-compatible /v1 suffix", async () => {
    // Users paste the /v1 base URL from other clients; the model list lives on
    // Ollama's own API, so /v1/api/tags would 404 and show an empty list.
    const calls = stubFetch({ models: [] });
    await fetchOllamaModels("http://localhost:11434/v1/");
    assert.equal(calls[0], "http://localhost:11434/api/tags");
  });

  it("returns an empty list when the server cannot be reached", async () => {
    stubFetch(null, { throws: true });
    assert.deepEqual(await fetchOllamaModels("http://localhost:11434"), []);
  });

  it("returns an empty list on a non-OK response", async () => {
    stubFetch({ models: [{ name: "x" }] }, { ok: false });
    assert.deepEqual(await fetchOllamaModels("http://localhost:11434"), []);
  });

  it("ignores a malformed payload rather than throwing", async () => {
    stubFetch({ models: "not-an-array" });
    assert.deepEqual(await fetchOllamaModels("http://localhost:11434"), []);
    stubFetch({ models: [{ noName: 1 }, { name: "" }, { name: "ok" }] });
    assert.deepEqual(await fetchOllamaModels("http://localhost:11434"), ["ok"]);
  });

  it("drops duplicate names", async () => {
    stubFetch({ models: [{ name: "llama3.2:latest" }, { name: "llama3.2:latest" }] });
    assert.deepEqual(await fetchOllamaModels("http://localhost:11434"), ["llama3.2:latest"]);
  });
});

describe("isOllamaModelInstalled", () => {
  const installed = ["llama3.2:latest", "qwen3:8b"];

  it("matches a bare name against its :latest tag", () => {
    // Ollama resolves `llama3.2` to `llama3.2:latest`, so a saved profile using
    // the bare name is valid and must not be flagged as missing.
    assert.equal(isOllamaModelInstalled("llama3.2", installed), true);
    assert.equal(isOllamaModelInstalled("llama3.2:latest", installed), true);
    assert.equal(isOllamaModelInstalled("qwen3:8b", installed), true);
  });

  it("flags a model that is not installed", () => {
    assert.equal(isOllamaModelInstalled("llama4", installed), false);
    assert.equal(isOllamaModelInstalled("gemma4", installed), false);
  });

  it("does not warn when the list could not be read", () => {
    // An empty list means "could not ask", not "nothing installed" — warning
    // there would flag every model whenever Ollama is simply stopped.
    assert.equal(isOllamaModelInstalled("llama3.2", []), true);
  });

  it("does not warn when no model is chosen yet", () => {
    assert.equal(isOllamaModelInstalled("", installed), true);
  });
});
