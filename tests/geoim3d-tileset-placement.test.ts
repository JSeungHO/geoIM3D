import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  geodeticToEcef,
  readTilesetPlacement,
  tilesetPlacementMatrix,
} from "../packages/map/src/geoim3d-tileset-placement";

const CHEONGNA = {
  longitude: 126.612968,
  latitude: 37.5486,
  rotation: [0, 220.5, 0] as [number, number, number],
  scale: 1,
  height: 83,
};

describe("readTilesetPlacement", () => {
  it("reads a complete placement", () => {
    assert.deepEqual(readTilesetPlacement({ placement: CHEONGNA }), CHEONGNA);
  });

  it("refuses anything that would move a tileset somewhere unasked", () => {
    // A half-filled placement is worse than none: the tileset would leave the
    // spot the tiler put it for a coordinate nobody chose.
    assert.equal(readTilesetPlacement({}), null);
    assert.equal(readTilesetPlacement({ placement: { ...CHEONGNA, latitude: undefined } }), null);
    assert.equal(readTilesetPlacement({ placement: { ...CHEONGNA, rotation: [0, NaN, 0] } }), null);
    assert.equal(readTilesetPlacement({ placement: { ...CHEONGNA, rotation: [0, 1] } }), null);
    assert.equal(readTilesetPlacement({ placement: { ...CHEONGNA, scale: 0 } }), null);
    assert.equal(readTilesetPlacement({ placement: { ...CHEONGNA, height: undefined } }), null);
  });
});

describe("geodeticToEcef", () => {
  it("puts the ellipsoid origin on the x axis", () => {
    const [x, y, z] = geodeticToEcef(0, 0, 0);
    assert.ok(Math.abs(y) < 1e-6 && Math.abs(z) < 1e-6);
    assert.ok(Math.abs(x - 6378137) < 1e-6);
  });

  it("adds height along the surface normal", () => {
    const surface = geodeticToEcef(126.612968, 37.5486, 0);
    const raised = geodeticToEcef(126.612968, 37.5486, 20);
    const gap = Math.hypot(...raised.map((value, i) => value - surface[i]));
    assert.ok(Math.abs(gap - 20) < 1e-6);
  });
});

describe("tilesetPlacementMatrix", () => {
  it("is a plain east-north-up frame with no heading and unit scale", () => {
    const m = tilesetPlacementMatrix({ ...CHEONGNA, rotation: [0, 0, 0] });
    const rad = Math.PI / 180;
    const lon = CHEONGNA.longitude * rad;
    const lat = CHEONGNA.latitude * rad;
    const expected = [
      [-Math.sin(lon), Math.cos(lon), 0],
      [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)],
      [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)],
    ];
    for (const [column, axis] of expected.entries()) {
      for (const [row, value] of axis.entries()) {
        assert.ok(Math.abs(m[column * 4 + row] - value) < 1e-12, `col ${column} row ${row}`);
      }
    }
    assert.deepEqual([m[3], m[7], m[11], m[15]], [0, 0, 0, 1]);
  });

  it("places the origin at the requested coordinate and height", () => {
    const m = tilesetPlacementMatrix(CHEONGNA);
    assert.deepEqual([m[12], m[13], m[14]], geodeticToEcef(126.612968, 37.5486, 83));
  });

  it("turns about up, keeping the axes orthonormal and up untouched", () => {
    const turned = tilesetPlacementMatrix(CHEONGNA);
    const flat = tilesetPlacementMatrix({ ...CHEONGNA, rotation: [0, 0, 0] });
    const column = (m: number[], i: number) => [m[i * 4], m[i * 4 + 1], m[i * 4 + 2]];
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

    // Up is the rotation axis, so it must come through unchanged.
    for (const [i, value] of column(flat, 2).entries()) {
      assert.ok(Math.abs(column(turned, 2)[i] - value) < 1e-12);
    }
    // The heading really turned the horizontal axes by 220.5°.
    assert.ok(
      Math.abs(dot(column(turned, 0), column(flat, 0)) - Math.cos(220.5 * (Math.PI / 180))) < 1e-12,
    );
    for (const i of [0, 1, 2]) {
      assert.ok(Math.abs(dot(column(turned, i), column(turned, i)) - 1) < 1e-12, `unit ${i}`);
    }
    assert.ok(Math.abs(dot(column(turned, 0), column(turned, 1))) < 1e-12);
  });

  it("keeps a zero offset at the height it is given", () => {
    // The offset is applied by the caller, which adds it to the tileset's own
    // height; the matrix itself only ever sees an absolute.
    const m = tilesetPlacementMatrix(CHEONGNA);
    assert.deepEqual([m[12], m[13], m[14]], geodeticToEcef(126.612968, 37.5486, 83));
    const raised = tilesetPlacementMatrix(CHEONGNA, 83 + 20);
    assert.ok(Math.hypot(raised[12] - m[12], raised[13] - m[13], raised[14] - m[14]) - 20 < 1e-6);
  });

  it("tilts about east and north as well, so every box moves the tileset", () => {
    // The first and third boxes were ignored once; a rotation that leaves the
    // matrix untouched is the bug this guards.
    const flat = tilesetPlacementMatrix({ ...CHEONGNA, rotation: [0, 0, 0] });
    for (const rotation of [
      [30, 0, 0],
      [0, 0, 30],
    ] as [number, number, number][]) {
      const tilted = tilesetPlacementMatrix({ ...CHEONGNA, rotation });
      assert.notDeepEqual(tilted.slice(0, 11), flat.slice(0, 11), `rotation ${rotation}`);
      // Still a rigid frame: orthonormal columns.
      for (const column of [0, 1, 2]) {
        const c = [tilted[column * 4], tilted[column * 4 + 1], tilted[column * 4 + 2]];
        assert.ok(Math.abs(Math.hypot(...c) - 1) < 1e-12, `unit ${column}`);
      }
    }
  });

  it("scales every axis and leaves the origin where it is", () => {
    const scaled = tilesetPlacementMatrix({ ...CHEONGNA, scale: 1.728 });
    const unit = tilesetPlacementMatrix(CHEONGNA);
    for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) {
      assert.ok(Math.abs(scaled[i] - unit[i] * 1.728) < 1e-12, `element ${i}`);
    }
    assert.deepEqual([scaled[12], scaled[13], scaled[14]], [unit[12], unit[13], unit[14]]);
  });
});
