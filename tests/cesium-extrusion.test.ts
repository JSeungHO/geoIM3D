import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extrusionHeightOf } from "../packages/map/src/cesium-layer-sync";

/** A stand-in for a Cesium entity's property bag. */
function properties(bag: Record<string, unknown>) {
  return { getValue: () => bag };
}

describe("extrusionHeightOf", () => {
  it("reads the property the style names", () => {
    assert.equal(
      extrusionHeightOf(properties({ extrude_height_m: 39 }), {
        extrusionHeightProperty: "extrude_height_m",
      }),
      39,
    );
  });

  it("applies the height scale", () => {
    assert.equal(
      extrusionHeightOf(properties({ levels: 13 }), {
        extrusionHeightProperty: "levels",
        extrusionHeightScale: 3,
      }),
      39,
    );
  });

  it("parses a numeric string, as GeoJSON properties often carry", () => {
    assert.equal(
      extrusionHeightOf(properties({ height: "42.5" }), { extrusionHeightProperty: "height" }),
      42.5,
    );
  });

  it("defaults to the `height` property", () => {
    assert.equal(extrusionHeightOf(properties({ height: 12 }), {}), 12);
  });

  it("returns 0 for a feature with no usable height", () => {
    // The caller leaves those flat rather than standing them at an invented
    // height — a building drawn at a made-up size reads as data.
    assert.equal(extrusionHeightOf(properties({}), { extrusionHeightProperty: "height" }), 0);
    assert.equal(extrusionHeightOf(properties({ height: null }), {}), 0);
    assert.equal(extrusionHeightOf(properties({ height: "없음" }), {}), 0);
    assert.equal(extrusionHeightOf(properties({ height: 0 }), {}), 0);
    assert.equal(extrusionHeightOf(properties({ height: -5 }), {}), 0);
  });

  it("survives an entity with no properties at all", () => {
    assert.equal(extrusionHeightOf(undefined, {}), 0);
    assert.equal(extrusionHeightOf({}, {}), 0);
  });
});
