import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendDiagnostic, clearDiagnostics, getDiagnosticsSnapshot } from "../apps/geolibre-desktop/src/lib/diagnostics";

/**
 * Records one diagnostic and returns it.
 *
 * The redaction happens on write, so reading the stored record is the only way
 * to assert what an exported diagnostics bundle would actually contain.
 */
function record(input: Parameters<typeof appendDiagnostic>[0]) {
  clearDiagnostics();
  appendDiagnostic(input);
  return getDiagnosticsSnapshot().records[0];
}

describe("diagnostics credential redaction", () => {
  it("redacts the data.go.kr service key", () => {
    // The KMA services name their credential `serviceKey`; a failed request
    // would otherwise put the whole key in the panel and its JSON export.
    const stored = record({
      category: "network",
      level: "error",
      message: "request failed",
      url: "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst?nx=60&serviceKey=SUPERSECRETKEYVALUE",
    });
    assert.ok(!stored.url?.includes("SUPERSECRETKEYVALUE"), stored.url);
    assert.ok(stored.url?.includes("serviceKey=%5BREDACTED%5D"), stored.url);
    // Non-credential parameters stay readable, or the record loses its value.
    assert.ok(stored.url?.includes("nx=60"));
  });

  it("redacts a VWorld key carried in the URL path", () => {
    // VWorld's WMTS endpoint puts the key in a path segment, which query-string
    // redaction cannot reach.
    const stored = record({
      category: "network",
      level: "error",
      message: "tile failed",
      url: "https://api.vworld.kr/req/wmts/1.0.0/SUPERSECRETKEYVALUE/Base/10/300/800.png",
    });
    assert.ok(!stored.url?.includes("SUPERSECRETKEYVALUE"), stored.url);
    assert.ok(stored.url?.includes("/req/wmts/1.0.0/[REDACTED]/Base/"), stored.url);
  });

  it("redacts credentials embedded in an error detail, not just the url field", () => {
    const stored = record({
      category: "network",
      level: "error",
      message: "failed",
      detail:
        "GET https://apis.data.go.kr/x?serviceKey=SUPERSECRETKEYVALUE returned 403",
    });
    assert.ok(!stored.detail?.includes("SUPERSECRETKEYVALUE"), stored.detail);
  });

  it("keeps redacting the parameter names it already covered", () => {
    for (const param of ["api_key", "apikey", "key", "token", "access_token"]) {
      const stored = record({
        category: "network",
        level: "error",
        message: "failed",
        url: `https://example.com/tiles?${param}=SUPERSECRETKEYVALUE`,
      });
      assert.ok(!stored.url?.includes("SUPERSECRETKEYVALUE"), `${param}: ${stored.url}`);
    }
  });
});
