import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isDurableSource,
  parsePresets,
  upsertPreset,
  type ObjectPreset,
} from "../packages/plugins/src/plugins/geoim3d-object-presets";

function preset(overrides: Partial<ObjectPreset> = {}): ObjectPreset {
  return {
    id: "p1",
    name: "park.sog",
    source: "C:\scans\park.sog",
    kind: "splat",
    transform: {
      longitude: 127.0705,
      latitude: 37.357164,
      altitude: 2,
      scale: 0.075,
      rotation: [-90, 294, 0],
    },
    ...overrides,
  };
}

describe("isDurableSource", () => {
  it("accepts what can be reopened later", () => {
    assert.equal(isDurableSource("https://host/a.sog"), true);
    assert.equal(isDurableSource("http://host/a.sog"), true);
    assert.equal(isDurableSource("C:\scans\park.sog"), true);
  });

  it("rejects an address that dies with the page", () => {
    // A browser file pick only ever yields one of these, which is why those
    // objects can be placed but not saved.
    assert.equal(isDurableSource("blob:http://localhost/abc"), false);
    // asset: is derived from a path; the path is what a preset must record.
    assert.equal(isDurableSource("asset://localhost/C:/a.sog"), false);
    assert.equal(isDurableSource("   "), false);
  });
});

describe("parsePresets", () => {
  it("round-trips a saved list", () => {
    const saved = [preset()];
    assert.deepEqual(parsePresets(JSON.stringify(saved)), saved);
  });

  it("survives storage written by another build", () => {
    // Tolerant on purpose: losing one bad entry beats throwing away the list.
    const mixed = JSON.stringify([preset(), { id: "half", name: "x" }, null, 7]);
    assert.deepEqual(parsePresets(mixed), [preset()]);
  });

  it("returns nothing for absent or unusable storage", () => {
    assert.deepEqual(parsePresets(null), []);
    assert.deepEqual(parsePresets("not json"), []);
    assert.deepEqual(parsePresets('{"not":"an array"}'), []);
  });

  it("rejects a placement that is missing a number", () => {
    // A half-written transform would place the object at NaN, which renders
    // nothing and looks like a load failure.
    const broken = preset();
    const raw = JSON.stringify([
      { ...broken, transform: { ...broken.transform, scale: undefined } },
      { ...broken, transform: { ...broken.transform, rotation: [0, 0] } },
    ]);
    assert.deepEqual(parsePresets(raw), []);
  });
});

describe("upsertPreset", () => {
  it("replaces the entry for a file already saved", () => {
    // Saving the same file twice means "these are the numbers now".
    const first = preset({ id: "a", transform: { ...preset().transform, scale: 1 } });
    const second = preset({ id: "b", transform: { ...preset().transform, scale: 2 } });
    const result = upsertPreset([first], second);
    assert.equal(result.length, 1);
    assert.equal(result[0].transform.scale, 2);
  });

  it("keeps entries for other files", () => {
    const other = preset({ id: "other", source: "https://host/b.sog" });
    const result = upsertPreset([other], preset());
    assert.deepEqual(result.map((entry) => entry.source).sort(), [
      "C:\scans\park.sog",
      "https://host/b.sog",
    ]);
  });
});
