import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cesiumSplitDirectionFor,
  cesiumSwipeSides,
  getCesiumSwipeState,
  setCesiumSwipeState,
} from "../packages/map/src/geoim3d-cesium-swipe";

function layer(id: string, nativeLayerIds?: string[]) {
  return { id, metadata: nativeLayerIds ? { nativeLayerIds } : {} } as never;
}

describe("cesiumSwipeSides", () => {
  const layers = [layer("cog-1"), layer("vec-2"), layer("arc-3", ["arcgis-hosted-9"])];

  it("matches a row that is the store layer id", () => {
    // The deck.gl rasters the provider contributes are listed by store id.
    const sides = cesiumSwipeSides(layers, ["cog-1"], []);
    assert.equal(sides.get("cog-1"), "left");
    assert.equal(sides.get("vec-2"), undefined);
  });

  it("matches the style layers one store layer draws as", () => {
    // The control reads MapLibre's style, where one layer is `<id>-fill`,
    // `<id>-line`, and so on.
    const sides = cesiumSwipeSides(layers, [], ["vec-2-fill", "vec-2-line"]);
    assert.equal(sides.get("vec-2"), "right");
  });

  it("matches an explicitly recorded native id", () => {
    const sides = cesiumSwipeSides(layers, ["arcgis-hosted-9"], []);
    assert.equal(sides.get("arc-3"), "left");
  });

  it("gives a layer on both lists to the right, as the control draws it", () => {
    const sides = cesiumSwipeSides(layers, ["cog-1"], ["cog-1"]);
    assert.equal(sides.get("cog-1"), "right");
  });

  it("leaves an unlisted layer out, which reads as both sides", () => {
    const sides = cesiumSwipeSides(layers, ["cog-1"], []);
    assert.equal(sides.has("vec-2"), false);
  });
});

describe("cesiumSplitDirectionFor", () => {
  it("maps a side to Cesium's split direction, and no swipe to none", () => {
    setCesiumSwipeState(null);
    assert.equal(cesiumSplitDirectionFor("cog-1"), 0);

    setCesiumSwipeState({
      position: 0.25,
      sides: new Map([
        ["cog-1", "left"],
        ["cog-2", "right"],
        ["cog-3", "both"],
      ] as const),
    });
    assert.equal(getCesiumSwipeState()?.position, 0.25);
    assert.equal(cesiumSplitDirectionFor("cog-1"), -1);
    assert.equal(cesiumSplitDirectionFor("cog-2"), 1);
    // `both` and an unknown layer are Cesium's NONE — drawn either side of the
    // split rather than clipped away.
    assert.equal(cesiumSplitDirectionFor("cog-3"), 0);
    assert.equal(cesiumSplitDirectionFor("missing"), 0);
    setCesiumSwipeState(null);
  });
});
