import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  VWORLD_BASE_MAPS,
  VWORLD_MIN_ZOOM,
  vworldCoverageView,
  VWORLD_THEMATIC_LAYERS,
  VWorldError,
  hasVWorldApiKey,
  resolveVWorldProtocolUrl,
  setVWorldApiKey,
  setVWorldDomain,
  vworldFeatureInfo,
  vworldBuildings,
  buildingHeight,
  formatAttribute,
  narrowToClicked,
  pointInGeometry,
  isSecondaryAttribute,
  VWORLD_PRIMARY_ATTRIBUTES,
  ASSUMED_STOREY_HEIGHT_M,
  VWORLD_HEIGHT_PROPERTY,
  VWORLD_WFS_MAX_FEATURES,
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
      // supply a string (see setVWorldTransport). A string payload is passed
      // through raw so a test can feed a non-JSON body — VWorld's OGC endpoints
      // report failure as an XML ServiceExceptionReport.
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
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
    await assert.rejects(
      () => vworldSearch("서울"),
      (error: VWorldError) => error.kind === "no-key",
    );
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
    stubFetch({
      response: { status: "ERROR", error: { code: "INVALID_KEY" } },
    });
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
    assert.equal(resolved, `https://api.vworld.kr/req/wmts/1.0.0/${TEST_KEY}/Base/10/300/800.png`);
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
    const calls = stubFetch({
      response: { status: "OK", result: { items: [] } },
    });
    await vworldSearch("서울", "DISTRICT");
    assert.equal(new URL(calls[0]).searchParams.get("category"), "L4");
  });

  it("omits the parameter for types that take none", async () => {
    const calls = stubFetch({
      response: { status: "OK", result: { items: [] } },
    });
    await vworldSearch("서울시청", "PLACE");
    assert.equal(new URL(calls[0]).searchParams.has("category"), false);
  });

  it("lets a caller choose another administrative level", async () => {
    const calls = stubFetch({
      response: { status: "OK", result: { items: [] } },
    });
    await vworldSearch("서울", "DISTRICT", { category: "L2" });
    assert.equal(new URL(calls[0]).searchParams.get("category"), "L2");
  });
});

describe("thematic feature lookup", () => {
  it("sends the registered domain, which WFS refuses to work without", () => {
    // The trap this pins: WFS answers INCORRECT_KEY ("인증키 정보가 올바르지
    // 않습니다") when no registered domain is named — which reads as an unusable
    // key rather than a missing parameter. The tile and search endpoints have no
    // such requirement, so it is easy to lose.
    setVWorldDomain("http://localhost:5173");
    const calls = stubFetch({ type: "FeatureCollection", features: [] });
    return vworldFeatureInfo(
      [{ id: "building", typename: "lt_c_bldginfo" }],
      126.978,
      37.5665,
    ).then(() => {
      const url = new URL(calls[0]);
      assert.equal(url.searchParams.get("domain"), "http://localhost:5173");
      assert.equal(url.searchParams.get("REQUEST"), "GetFeature");
      assert.equal(url.searchParams.get("TYPENAME"), "lt_c_bldginfo");
    });
  });

  it("builds the bbox in WFS 1.1.0 lat/lon order", async () => {
    // WFS 1.1.0 with an EPSG:4326 SRS takes lat before lon. Reversed, the query
    // lands in the ocean off Somalia and quietly returns nothing.
    setVWorldDomain("http://localhost:5173");
    const calls = stubFetch({ type: "FeatureCollection", features: [] });
    await vworldFeatureInfo([{ id: "building", typename: "lt_c_bldginfo" }], 126.978, 37.5665);
    const bbox = new URL(calls[0]).searchParams.get("BBOX") ?? "";
    const [south, west, north, east] = bbox.split(",").map(Number);
    assert.ok(south > 37 && south < 38, `south ${south}`);
    assert.ok(west > 126 && west < 127, `west ${west}`);
    assert.ok(north > south && east > west);
  });

  it("returns each matched feature with its geometry and layer", async () => {
    setVWorldDomain("http://localhost:5173");
    stubFetch({
      type: "FeatureCollection",
      features: [
        {
          id: "lt_c_bldginfo.1",
          geometry: { type: "MultiPolygon", coordinates: [] },
          properties: { pnu: "1114010300100310000", grnd_flr: 13 },
        },
      ],
    });
    const found = await vworldFeatureInfo(
      [{ id: "building", typename: "lt_c_bldginfo" }],
      126.978,
      37.5665,
    );
    assert.equal(found.length, 1);
    assert.equal(found[0].layerId, "building");
    assert.equal(found[0].featureId, "lt_c_bldginfo.1");
    assert.equal(found[0].properties.grnd_flr, 13);
    // The geometry is what makes "add as layer" possible at all.
    assert.ok(found[0].geometry);
  });

  it("reads an XML service exception rather than reporting a parse failure", async () => {
    // WFS reports failure as a ServiceExceptionReport, not the JSON status
    // field the other endpoints use, so the code has to be dug out of the XML.
    stubFetch(
      '<?xml version="1.0"?><ServiceExceptionReport><ServiceException code="INCORRECT_KEY">' +
        "인증키 정보가 올바르지 않습니다.</ServiceException></ServiceExceptionReport>",
    );
    await assert.rejects(
      () => vworldFeatureInfo([{ id: "building", typename: "lt_c_bldginfo" }], 126.978, 37.5665),
      (error: VWorldError) => error.kind === "invalid-key",
    );
  });

  it("makes no request when no thematic layer is on the map", async () => {
    const calls = stubFetch({ type: "FeatureCollection", features: [] });
    assert.deepEqual(await vworldFeatureInfo([], 126.978, 37.5665), []);
    assert.equal(calls.length, 0);
  });

  it("reports an empty result rather than failing", async () => {
    // Clicking a road inside a cadastral layer is a legitimate miss.
    setVWorldDomain("http://localhost:5173");
    stubFetch({ type: "FeatureCollection", features: [] });
    assert.deepEqual(
      await vworldFeatureInfo([{ id: "building", typename: "lt_c_bldginfo" }], 126.978, 37.5665),
      [],
    );
  });
});

describe("building extrusion height", () => {
  it("prefers a measured height over the storey estimate", () => {
    assert.equal(buildingHeight({ height: "42.5", grnd_flr: 13 }), 42.5);
  });

  it("estimates from storeys when no height is recorded", () => {
    // Most VWorld records carry storeys but no measured height, so the estimate
    // is the normal path rather than a fallback.
    assert.equal(buildingHeight({ height: 0, grnd_flr: 13 }), 13 * ASSUMED_STOREY_HEIGHT_M);
    assert.equal(buildingHeight({ grnd_flr: "3" }), 3 * ASSUMED_STOREY_HEIGHT_M);
  });

  it("gives a building with neither a visible height", () => {
    // A zero would flatten it into the ground plane, reading as missing data
    // rather than an unrecorded height.
    assert.equal(buildingHeight({}), ASSUMED_STOREY_HEIGHT_M);
    assert.equal(buildingHeight({ height: "0", grnd_flr: "0" }), ASSUMED_STOREY_HEIGHT_M);
  });

  it("writes the height onto every feature and reports truncation", async () => {
    setVWorldDomain("http://localhost:5173");
    const features = Array.from({ length: VWORLD_WFS_MAX_FEATURES }, (_, index) => ({
      id: `lt_c_bldginfo.${index}`,
      geometry: { type: "Polygon", coordinates: [] },
      properties: { grnd_flr: 5 },
    }));
    stubFetch({ type: "FeatureCollection", features });

    const result = await vworldBuildings([126.97, 37.56, 126.98, 37.57]);
    assert.equal(result.geojson.features.length, VWORLD_WFS_MAX_FEATURES);
    assert.equal(
      result.geojson.features[0].properties[VWORLD_HEIGHT_PROPERTY],
      5 * ASSUMED_STOREY_HEIGHT_M,
    );
    // A full page means the view was cut off, and a partial city that looks
    // complete is worse than one the user knows is partial.
    assert.equal(result.truncated, true);
  });

  it("does not claim truncation on a short page", async () => {
    setVWorldDomain("http://localhost:5173");
    stubFetch({
      type: "FeatureCollection",
      features: [
        {
          geometry: { type: "Polygon", coordinates: [] },
          properties: { grnd_flr: 2 },
        },
      ],
    });
    const result = await vworldBuildings([126.97, 37.56, 126.98, 37.57]);
    assert.equal(result.truncated, false);
  });

  it("drops features with no geometry rather than adding empty shapes", async () => {
    setVWorldDomain("http://localhost:5173");
    stubFetch({
      type: "FeatureCollection",
      features: [
        { geometry: null, properties: { grnd_flr: 2 } },
        {
          geometry: { type: "Polygon", coordinates: [] },
          properties: { grnd_flr: 2 },
        },
      ],
    });
    const result = await vworldBuildings([126.97, 37.56, 126.98, 37.57]);
    assert.equal(result.geojson.features.length, 1);
  });
});

describe("attribute formatting", () => {
  it("blanks an unmeasured area or ratio rather than printing 0", () => {
    // VWorld writes 0 for a figure it does not hold. "0 ㎡" states a fact the
    // record does not contain, which is worse than showing nothing.
    assert.equal(formatAttribute(0, "area"), "");
    assert.equal(formatAttribute("0", "ratio"), "");
    assert.equal(formatAttribute(0, "number"), "0");
  });

  it("keeps a genuine zero floor count", () => {
    // A building with no basement really has 0 underground floors, so the
    // blanking rule must not reach the counted columns.
    assert.equal(formatAttribute("0", "number"), "0");
  });

  it("groups thousands so a floor area is readable at a glance", () => {
    assert.equal(formatAttribute("138156.25", "area"), "138,156.25");
    assert.equal(formatAttribute(49468.97, "area"), "49,468.97");
  });

  it("formats a compact date", () => {
    assert.equal(formatAttribute("20051130", "date"), "2005-11-30");
    // Anything not in the expected shape is passed through, not mangled.
    assert.equal(formatAttribute("2005", "date"), "2005");
  });

  it("treats the service's empty markers as absent", () => {
    for (const empty of [null, undefined, "", "None", "null"]) {
      assert.equal(formatAttribute(empty), "", `${String(empty)} should render as empty`);
    }
  });

  it("separates the readable attributes from the internal keys", () => {
    // The schema's opaque identifiers are what push the useful values off the
    // first screen.
    for (const field of ["grnd_flr", "totalarea", "pnu", "useapr_day"]) {
      assert.equal(isSecondaryAttribute(field), false, `${field} should lead`);
    }
    for (const field of ["ufid", "geoidn", "sgg_oid", "col_adm_se", "strct_cd"]) {
      assert.equal(isSecondaryAttribute(field), true, `${field} should be folded away`);
    }
  });

  it("lists the primary attributes in reading order", () => {
    const fields = VWORLD_PRIMARY_ATTRIBUTES.map((spec) => spec.field);
    // Name and size before the registry keys.
    assert.ok(fields.indexOf("bld_nm") < fields.indexOf("pnu"));
    assert.ok(fields.indexOf("grnd_flr") < fields.indexOf("bd_mgt_sn"));
    assert.equal(new Set(fields).size, fields.length);
  });
});

/* -------------------------------------------------------------------------- */
describe("narrowing a click to one feature", () => {
  /* Narrowing a click to one feature                                             */
  /* -------------------------------------------------------------------------- */

  /** A unit square from (0,0) to (1,1). */
  const SQUARE = {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ],
  };

  /** The same square with a hole from (0.4,0.4) to (0.6,0.6). */
  const SQUARE_WITH_COURTYARD = {
    type: "Polygon",
    coordinates: [
      SQUARE.coordinates[0],
      [
        [0.4, 0.4],
        [0.6, 0.4],
        [0.6, 0.6],
        [0.4, 0.6],
        [0.4, 0.4],
      ],
    ],
  };

  function feature(id: string, geometry: unknown, layerId = "building") {
    return { layerId, featureId: id, properties: {}, geometry };
  }

  it("pointInGeometry accepts a point inside and rejects one outside", () => {
    assert.equal(pointInGeometry(0.5, 0.5, SQUARE), true);
    assert.equal(pointInGeometry(1.5, 0.5, SQUARE), false);
    assert.equal(pointInGeometry(0.5, 1.5, SQUARE), false);
  });

  it("pointInGeometry treats a hole as outside", () => {
    assert.equal(pointInGeometry(0.5, 0.5, SQUARE_WITH_COURTYARD), false);
    assert.equal(pointInGeometry(0.2, 0.2, SQUARE_WITH_COURTYARD), true);
  });

  it("pointInGeometry handles MultiPolygon parts", () => {
    const multi = {
      type: "MultiPolygon",
      coordinates: [
        SQUARE.coordinates,
        [
          [
            [5, 5],
            [6, 5],
            [6, 6],
            [5, 6],
            [5, 5],
          ],
        ],
      ],
    };
    assert.equal(pointInGeometry(5.5, 5.5, multi), true);
    assert.equal(pointInGeometry(3, 3, multi), false);
  });

  it("pointInGeometry rejects geometry it cannot test", () => {
    assert.equal(pointInGeometry(0, 0, null), false);
    assert.equal(pointInGeometry(0, 0, { type: "Point", coordinates: [0, 0] }), false);
  });

  it("narrowToClicked keeps only the feature under the pointer", () => {
    const neighbour = {
      type: "Polygon",
      coordinates: [
        [
          [2, 0],
          [3, 0],
          [3, 1],
          [2, 1],
          [2, 0],
        ],
      ],
    };
    const narrowed = narrowToClicked([feature("a", SQUARE), feature("b", neighbour)], 0.5, 0.5);
    assert.deepEqual(
      narrowed.map((info) => info.featureId),
      ["a"],
    );
  });

  it("narrowToClicked falls back to the nearest when a click lands in a gap", () => {
    const far = {
      type: "Polygon",
      coordinates: [
        [
          [10, 10],
          [11, 10],
          [11, 11],
          [10, 11],
          [10, 10],
        ],
      ],
    };
    // (1.1, 0.5) is just outside the unit square and nowhere near the far one.
    const narrowed = narrowToClicked([feature("far", far), feature("near", SQUARE)], 1.1, 0.5);
    assert.deepEqual(
      narrowed.map((info) => info.featureId),
      ["near"],
    );
  });

  it("narrowToClicked keeps one hit per layer", () => {
    // A click can legitimately match a parcel and the building on it.
    const narrowed = narrowToClicked(
      [feature("bld", SQUARE, "building"), feature("lot", SQUARE, "cadastral")],
      0.5,
      0.5,
    );
    assert.deepEqual(narrowed.map((info) => info.layerId).sort(), ["building", "cadastral"]);
  });

  it("narrowToClicked leaves a single result alone", () => {
    // Even when the click is outside it: one hit is the answer either way.
    const narrowed = narrowToClicked([feature("only", SQUARE)], 9, 9);
    assert.equal(narrowed.length, 1);
  });
});

describe("vworldCoverageView", () => {
  it("leaves a view already over Korea alone", () => {
    // Switching basemaps must not yank the camera off what the user is looking
    // at when the tiles are right there.
    assert.equal(vworldCoverageView({ longitude: 127.0, latitude: 37.5, zoom: 12 }), null);
  });

  it("moves a world view onto the coverage", () => {
    // VWorld has tiles for Korea from zoom 6 down, so a world view draws
    // nothing — and an empty globe reads as a basemap that failed to load.
    const view = vworldCoverageView({ longitude: -102, latitude: 43, zoom: 1.6 });
    assert.ok(view);
    assert.ok(view.longitude > 124.5 && view.longitude < 132);
    assert.ok(view.latitude > 33 && view.latitude < 38.7);
    assert.ok(view.zoom >= VWORLD_MIN_ZOOM);
  });

  it("moves a view over Korea that is too far out", () => {
    // Inside the box but above the tiles' shallowest zoom is still blank.
    const view = vworldCoverageView({ longitude: 127.0, latitude: 37.5, zoom: 3 });
    assert.ok(view);
    assert.ok(view.zoom >= VWORLD_MIN_ZOOM);
  });

  it("keeps a closer zoom when it has to recentre", () => {
    // Someone looking at a street in Tokyo should arrive at street level in
    // Korea, not be pulled back to a country view.
    const view = vworldCoverageView({ longitude: 139.7, latitude: 35.7, zoom: 17 });
    assert.equal(view?.zoom, 17);
  });

  it("agrees with the base maps' own minimum zoom", () => {
    // The constant mirrors every entry; a new base map with a shallower
    // minzoom would make it wrong.
    assert.equal(Math.min(...VWORLD_BASE_MAPS.map((map) => map.minzoom)), VWORLD_MIN_ZOOM);
  });
});

describe("VWorld base map kinds", () => {
  it("marks only Hybrid as an overlay", () => {
    // Hybrid is transparent annotation — labels, roads, boundaries — with no
    // imagery of its own. Applied as a basemap it replaces the imagery it was
    // drawn to annotate, leaving writing on an empty map, so the two are
    // applied by different paths and this flag is what picks between them.
    const overlays = VWORLD_BASE_MAPS.filter((map) => map.overlay).map((map) => map.id);
    assert.deepEqual(overlays, ["Hybrid"]);
  });

  it("gives every base map a zoom range VWorld actually serves", () => {
    for (const map of VWORLD_BASE_MAPS) {
      assert.ok(map.minzoom >= VWORLD_MIN_ZOOM, `${map.id} claims a zoom below the coverage`);
      assert.ok(map.maxzoom > map.minzoom, `${map.id} has an empty zoom range`);
    }
  });
});
