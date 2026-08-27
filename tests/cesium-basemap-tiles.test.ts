import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StyleSpecification } from "maplibre-gl";
// The module directly, not the package index: `@geolibre/map` pulls MapLibre's
// stylesheet into the graph, and a `.css` import is a hard error under the Node
// test runner. This file imports only types from Cesium and MapLibre.
import {
  rasterBasemapTiles,
  tilesetOpacityExpression,
  setCesiumTileUrlResolver,
} from "../packages/map/src/cesium-layer-sync";

function style(partial: Partial<StyleSpecification>): StyleSpecification {
  return { version: 8, sources: {}, layers: [], ...partial } as StyleSpecification;
}

describe("rasterBasemapTiles", () => {
  it("reads a raster source's template and zoom range", () => {
    const tiles = rasterBasemapTiles(
      style({
        sources: {
          sat: {
            type: "raster",
            tiles: ["https://host/{z}/{y}/{x}.jpeg"],
            minzoom: 6,
            maxzoom: 19,
          },
        },
        layers: [{ id: "sat", type: "raster", source: "sat" }],
      }),
    );
    assert.deepEqual(tiles, [{ url: "https://host/{z}/{y}/{x}.jpeg", minzoom: 6, maxzoom: 19 }]);
  });

  it("keeps the style's draw order", () => {
    // This is the whole reason it walks `layers` rather than `sources`: the
    // VWorld satellite basemap carries its labels overlay in the same style, and
    // an object key order that put the labels first would bury them under the
    // imagery they annotate.
    const tiles = rasterBasemapTiles(
      style({
        sources: {
          labels: { type: "raster", tiles: ["https://host/labels/{z}/{y}/{x}.png"] },
          imagery: { type: "raster", tiles: ["https://host/sat/{z}/{y}/{x}.jpeg"] },
        },
        layers: [
          { id: "imagery", type: "raster", source: "imagery" },
          { id: "labels", type: "raster", source: "labels" },
        ],
      }),
    );
    assert.deepEqual(
      tiles.map((tile) => tile.url),
      ["https://host/sat/{z}/{y}/{x}.jpeg", "https://host/labels/{z}/{y}/{x}.png"],
    );
  });

  it("skips a source the style never draws", () => {
    const tiles = rasterBasemapTiles(
      style({
        sources: {
          drawn: { type: "raster", tiles: ["https://host/a/{z}/{y}/{x}.png"] },
          unused: { type: "raster", tiles: ["https://host/b/{z}/{y}/{x}.png"] },
        },
        layers: [{ id: "drawn", type: "raster", source: "drawn" }],
      }),
    );
    assert.equal(tiles.length, 1);
    assert.equal(tiles[0]?.url, "https://host/a/{z}/{y}/{x}.png");
  });

  it("yields nothing for a style the globe cannot replay", () => {
    // A vector basemap has no tile images to hand an imagery provider. Returning
    // a partial result would blank the globe's own imagery and draw nothing in
    // its place, so the caller must be able to tell "not replayable" apart from
    // "replayed".
    assert.deepEqual(
      rasterBasemapTiles(
        style({
          sources: { v: { type: "vector", url: "https://host/tiles.json" } },
          layers: [{ id: "water", type: "fill", source: "v", "source-layer": "water" }],
        }),
      ),
      [],
    );
    // A raster layer whose source is missing, or carries no tile template.
    assert.deepEqual(
      rasterBasemapTiles(
        style({
          sources: { r: { type: "raster", url: "https://host/tiles.json" } },
          layers: [
            { id: "r", type: "raster", source: "r" },
            { id: "gone", type: "raster", source: "gone" },
          ],
        }),
      ),
      [],
    );
  });

  it("routes tile templates through the installed resolver", () => {
    // The point of the seam: MapLibre serves `vworld://` through a registered
    // protocol, Cesium hands URLs straight to the browser, so an unresolved
    // scheme renders nothing on the globe and reports no error.
    setCesiumTileUrlResolver((url) => url.replace("vworld://", "https://api.example/req/KEY/"));
    try {
      const tiles = rasterBasemapTiles(
        style({
          sources: { v: { type: "raster", tiles: ["vworld://wmts/Base/{z}/{y}/{x}.png"] } },
          layers: [{ id: "v", type: "raster", source: "v" }],
        }),
      );
      assert.equal(tiles[0]?.url, "https://api.example/req/KEY/wmts/Base/{z}/{y}/{x}.png");
    } finally {
      setCesiumTileUrlResolver(null);
    }
  });

  it("keeps the original URL when the resolver throws", () => {
    // The VWorld resolver throws when no API key is configured. Letting that
    // escape would abort the whole basemap sync; the unresolved URL simply
    // fails to load, exactly as it did before the seam existed.
    setCesiumTileUrlResolver(() => {
      throw new Error("no-key");
    });
    try {
      const tiles = rasterBasemapTiles(
        style({
          sources: { v: { type: "raster", tiles: ["vworld://wmts/Base/{z}/{y}/{x}.png"] } },
          layers: [{ id: "v", type: "raster", source: "v" }],
        }),
      );
      assert.equal(tiles[0]?.url, "vworld://wmts/Base/{z}/{y}/{x}.png");
    } finally {
      setCesiumTileUrlResolver(null);
    }
  });

  it("carries a source's bounds through, so a regional basemap stays regional", () => {
    // VWorld covers Korea from zoom 6. Dropped bounds made Cesium request that
    // level across the whole globe, the service errored outside Korea and the
    // provider failed as a whole — the basemap looked like it never applied.
    const [tile] = rasterBasemapTiles(
      style({
        sources: {
          v: {
            type: "raster",
            tiles: ["https://example/{z}/{y}/{x}.png"],
            bounds: [124.5, 33, 132, 38.7],
            minzoom: 6,
          },
        },
        layers: [{ id: "v", type: "raster", source: "v" }],
      }),
    );
    assert.deepEqual(tile?.bounds, [124.5, 33, 132, 38.7]);
    assert.equal(tile?.minzoom, 6);
  });

  it("drops bounds that are missing, malformed or empty", () => {
    // An empty rectangle draws nothing at all, which is worse than the
    // unbounded default the globe had before.
    const boundsOf = (bounds: unknown) =>
      rasterBasemapTiles(
        style({
          sources: { v: { type: "raster", tiles: ["https://example/{z}/{y}/{x}.png"], bounds } },
          layers: [{ id: "v", type: "raster", source: "v" }],
        }),
      )[0]?.bounds;

    assert.equal(boundsOf(undefined), undefined);
    assert.equal(boundsOf([1, 2, 3]), undefined);
    assert.equal(boundsOf([1, 2, "3", 4]), undefined);
    assert.equal(boundsOf([132, 33, 124.5, 38.7]), undefined);
    assert.equal(boundsOf([124.5, 38.7, 132, 33]), undefined);
  });
});

describe("tilesetOpacityExpression", () => {
  it("leaves a fully opaque tileset unstyled", () => {
    // A style costs a shader variant per tile and buys nothing at alpha 1.
    assert.equal(tilesetOpacityExpression(1), undefined);
    assert.equal(tilesetOpacityExpression(Number.NaN), undefined);
  });

  it("fades to the layer's opacity", () => {
    assert.equal(tilesetOpacityExpression(0.4), "color('#ffffff', 0.4)");
    assert.equal(tilesetOpacityExpression(0), "color('#ffffff', 0)");
  });

  it("clamps out-of-range values instead of passing them to the shader", () => {
    assert.equal(tilesetOpacityExpression(-0.5), "color('#ffffff', 0)");
    assert.equal(tilesetOpacityExpression(2), undefined);
  });
});
