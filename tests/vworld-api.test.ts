import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  VWORLD_BASE_MAPS,
  VWORLD_THEMATIC_LAYERS,
  VWorldError,
  hasVWorldApiKey,
  resolveVWorldProtocolUrl,
  setVWorldApiKey,
  defaultSearchCategory,
  vworldErrorKind,
  vworldGeocode,
  vworldReverseGeocode,
  vworldSearch,
  vworldTileTemplate,
} from "../packages/plugins/src/plugins/vworld-api";

const TEST_KEY = "test-vworld-key";

/** Captures the URLs the client requests so assertions can inspect them. */
function stubFetch(payload: unknown, options: { ok?: boolean; status?: number } = {}) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return {
      ok: options.ok ?? true,
      status: options.status ?? 200,
      // The client reads text and parses it itself, so a transport only has to
      // supply a string (see setVWorldTransport).
      text: async () => JSON.stringify(payload),
    } as Response;
  }) as typeof fetch;
  return calls;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  setVWorldApiKey(TEST_KEY);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setVWorldApiKey("");
});

describe("VWorld API key handling", () => {
  it("reports configured state without exposing the value", () => {
    setVWorldApiKey("  spaced-key  ");
    assert.equal(hasVWorldApiKey(), true);
    // The module exports no getter at all — the only read path is the
    // request-time injection inside the module.
    setVWorldApiKey("");
    assert.equal(hasVWorldApiKey(), false);
  });

  it("refuses every request when no key is set", async () => {
    setVWorldApiKey("");
    await assert.rejects(() => vworldSearch("서울"), (error: VWorldError) => error.kind === "no-key");
    await assert.rejects(
      () => vworldGeocode("세종대로 110"),
      (error: VWorldError) => error.kind === "no-key",
    );
    await assert.rejects(
      () => vworldReverseGeocode(126.97, 37.56),
      (error: VWorldError) => error.kind === "no-key",
    );
    assert.throws(
      () => resolveVWorldProtocolUrl("vworld://wmts/Base/10/300/800.png"),
      (error: VWorldError) => error.kind === "no-key",
    );
  });
});

describe("vworldErrorKind", () => {
  it("separates the documented failure classes", () => {
    // Level 2 key problems are distinct from the daily quota: one needs a new
    // key, the other needs the user to wait.
    assert.equal(vworldErrorKind("INVALID_KEY"), "invalid-key");
    assert.equal(vworldErrorKind("INCORRECT_KEY"), "invalid-key");
    assert.equal(vworldErrorKind("UNAVAILABLE_KEY"), "invalid-key");
    assert.equal(vworldErrorKind("OVER_REQUEST_LIMIT"), "rate-limit");
    assert.equal(vworldErrorKind("PARAM_REQUIRED"), "invalid-request");
    assert.equal(vworldErrorKind("INVALID_RANGE"), "invalid-request");
    assert.equal(vworldErrorKind("SYSTEM_ERROR"), "server");
    assert.equal(vworldErrorKind("NOT_FOUND"), "not-found");
    assert.equal(vworldErrorKind("something-else"), "unknown");
  });

  it("carries no key or request URL on the error itself", async () => {
    stubFetch({ response: { status: "ERROR", error: { code: "INVALID_KEY" } } });
    await assert.rejects(
      () => vworldSearch("서울"),
      (error: VWorldError) => {
        assert.equal(error.kind, "invalid-key");
        assert.ok(!error.message.includes(TEST_KEY));
        assert.ok(!error.message.includes("api.vworld.kr"));
        return true;
      },
    );
  });
});

describe("tile and protocol URLs", () => {
  it("builds a key-free tile template so the key never reaches a saved project", () => {
    for (const map of VWORLD_BASE_MAPS) {
      const template = vworldTileTemplate(map);
      assert.ok(!template.includes(TEST_KEY), `${map.id} template leaked the key`);
      assert.ok(template.startsWith("vworld://wmts/"));
      // WMTS orders the path {tileMatrix}/{tileRow}/{tileCol} — z/y/x, not the
      // z/x/y an XYZ service would use. Getting this backwards silently serves
      // the wrong tiles rather than failing.
      assert.ok(template.includes("/{z}/{y}/{x}."), `${map.id} template has the wrong axis order`);
    }
  });

  it("uses the documented per-layer image format", () => {
    const satellite = VWORLD_BASE_MAPS.find((map) => map.id === "Satellite");
    assert.equal(satellite?.extension, "jpeg");
    assert.equal(VWORLD_BASE_MAPS.find((map) => map.id === "Base")?.extension, "png");
  });

  it("keeps each layer's documented zoom range", () => {
    // white/midnight stop at 18; Base/Hybrid/Satellite reach 19. A too-deep
    // maxzoom shows blank tiles instead of overzooming the last good level.
    assert.equal(VWORLD_BASE_MAPS.find((map) => map.id === "white")?.maxzoom, 18);
    assert.equal(VWORLD_BASE_MAPS.find((map) => map.id === "midnight")?.maxzoom, 18);
    for (const id of ["Base", "Hybrid", "Satellite"] as const) {
      assert.equal(VWORLD_BASE_MAPS.find((map) => map.id === id)?.maxzoom, 19);
    }
    for (const map of VWORLD_BASE_MAPS) assert.equal(map.minzoom, 6);
  });

  it("injects the key as a WMTS path segment at request time", () => {
    const resolved = resolveVWorldProtocolUrl("vworld://wmts/Base/10/300/800.png");
    assert.equal(
      resolved,
      `https://api.vworld.kr/req/wmts/1.0.0/${TEST_KEY}/Base/10/300/800.png`,
    );
  });

  it("injects the key as a query parameter for WMS, preserving GetMap params", () => {
    const resolved = resolveVWorldProtocolUrl(
      "vworld://wms?SERVICE=WMS&REQUEST=GetMap&LAYERS=lp_pa_cbnd_bubun&BBOX=1,2,3,4",
    );
    const url = new URL(resolved);
    assert.equal(url.origin + url.pathname, "https://api.vworld.kr/req/wms");
    assert.equal(url.searchParams.get("key"), TEST_KEY);
    assert.equal(url.searchParams.get("LAYERS"), "lp_pa_cbnd_bubun");
    assert.equal(url.searchParams.get("BBOX"), "1,2,3,4");
  });

  it("rejects a URL that is not a VWorld resource", () => {
    assert.throws(
      () => resolveVWorldProtocolUrl("vworld://evil/../../etc/passwd"),
      (error: VWorldError) => error.kind === "invalid-request",
    );
  });
});

describe("thematic layers", () => {
  it("uses the documented VWorld typenames", () => {
    const byId = new Map(VWORLD_THEMATIC_LAYERS.map((layer) => [layer.id, layer.typename]));
    // A typo here yields an empty tile rather than an error, so the identifiers
    // are pinned against the official WMS/WFS reference.
    assert.equal(byId.get("cadastral"), "lp_pa_cbnd_bubun");
    assert.equal(byId.get("cadastral-bonbun"), "lp_pa_cbnd_bonbun");
    assert.equal(byId.get("building"), "lt_c_bldginfo");
    assert.equal(byId.get("zoning-urban"), "lt_c_uq111");
    assert.equal(byId.get("zoning-management"), "lt_c_uq112");
    assert.equal(byId.get("zoning-agriculture"), "lt_c_uq113");
    assert.equal(byId.get("zoning-greenbelt"), "lt_c_ud801");
  });

  it("has no duplicate ids", () => {
    const ids = VWORLD_THEMATIC_LAYERS.map((layer) => layer.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("search category", () => {
  it("sends the category each type requires", () => {
    // Verified against the live service: ADDRESS and DISTRICT are rejected with
    // PARAM_REQUIRED when `category` is absent; PLACE and ROAD take none.
    assert.equal(defaultSearchCategory("ADDRESS"), "PARCEL");
    assert.equal(defaultSearchCategory("DISTRICT"), "L4");
    assert.equal(defaultSearchCategory("PLACE"), "");
    assert.equal(defaultSearchCategory("ROAD"), "");
  });

  it("puts a category on the DISTRICT request", async () => {
    // The regression this guards: a DISTRICT search without `category` fails
    // with PARAM_REQUIRED, which the UI reported as a rejected API key.
    const calls = stubFetch({ response: { status: "OK", result: { items: [] } } });
    await vworldSearch("서울", "DISTRICT");
    assert.equal(new URL(calls[0]).searchParams.get("category"), "L4");
  });

  it("omits the parameter for types that take none", async () => {
    const calls = stubFetch({ response: { status: "OK", result: { items: [] } } });
    await vworldSearch("서울시청", "PLACE");
    assert.equal(new URL(calls[0]).searchParams.has("category"), false);
  });

  it("lets a caller choose another administrative level", async () => {
    const calls = stubFetch({ response: { status: "OK", result: { items: [] } } });
    await vworldSearch("서울", "DISTRICT", { category: "L2" });
    assert.equal(new URL(calls[0]).searchParams.get("category"), "L2");
  });
});
