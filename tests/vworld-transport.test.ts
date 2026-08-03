import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  setVWorldApiKey,
  setVWorldTransport,
  vworldSearch,
} from "../packages/plugins/src/plugins/vworld-api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setVWorldTransport(null);
  setVWorldApiKey("");
});

/** A transport that records the URLs it is handed and replays a fixed body. */
function recordingTransport(body: unknown) {
  const urls: string[] = [];
  setVWorldTransport(async (url) => {
    urls.push(url);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  });
  return urls;
}

describe("VWorld transport injection", () => {
  it("routes requests through the installed transport instead of fetch", async () => {
    // The point of the seam: VWorld sends no CORS headers on its JSON endpoints,
    // so the browser's fetch can make the request but never read the answer. A
    // host substitutes a native or proxied transport.
    setVWorldApiKey("test-key");
    globalThis.fetch = (() => {
      throw new Error("fetch must not be used once a transport is installed");
    }) as typeof fetch;

    const urls = recordingTransport({
      response: {
        status: "OK",
        record: { total: "1" },
        page: { current: "1" },
        result: {
          items: [{ id: "1", title: "서울특별시", point: { x: "126.9", y: "37.5" } }],
        },
      },
    });

    const result = await vworldSearch("서울", "DISTRICT");
    assert.equal(result.results.length, 1);
    assert.equal(urls.length, 1);
    assert.ok(urls[0].startsWith("https://api.vworld.kr/req/search"), urls[0]);
  });

  it("still hands the transport a fully built URL, key included", async () => {
    setVWorldApiKey("test-key");
    const urls = recordingTransport({ response: { status: "OK", result: { items: [] } } });
    await vworldSearch("서울", "PLACE");
    // The transport is a pipe, not a URL builder: proxying must not require the
    // host to know how VWorld requests are assembled.
    const url = new URL(urls[0]);
    assert.equal(url.searchParams.get("key"), "test-key");
    assert.equal(url.searchParams.get("request"), "search");
  });

  it("restores the browser default when cleared", async () => {
    setVWorldApiKey("test-key");
    recordingTransport({ response: { status: "OK", result: { items: [] } } });
    setVWorldTransport(null);

    let used = false;
    globalThis.fetch = (async () => {
      used = true;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ response: { status: "OK", result: { items: [] } } }),
      } as unknown as Response;
    }) as typeof fetch;

    await vworldSearch("서울", "PLACE");
    assert.equal(used, true);
  });

  it("maps a transport failure to a network error, not a crash", async () => {
    setVWorldApiKey("test-key");
    setVWorldTransport(async () => {
      throw new TypeError("Failed to fetch");
    });
    await assert.rejects(
      () => vworldSearch("서울", "PLACE"),
      (error: Error & { kind?: string }) => error.kind === "network",
    );
  });
});
