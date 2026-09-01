import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  basemapExtrusionLayerIds,
  isBundledPreset,
  isDurableSource,
  parseBundledManifest,
  placementBounds,
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

describe("parseBundledManifest", () => {
  const BASE = "http://localhost:5173/";

  it("resolves a shipped file against the app's own base", () => {
    // Same-origin, so it needs neither the picker nor the native fetcher.
    const raw = JSON.stringify({
      objects: [
        {
          file: "park.sog",
          name: "고기리공원",
          longitude: 127.0705,
          latitude: 37.357164,
          altitude: 2,
          scale: 0.075,
          rotation: [-90, 294, 0],
        },
      ],
    });
    const [preset] = parseBundledManifest(raw, BASE);
    assert.equal(preset.source, "http://localhost:5173/objects/park.sog");
    assert.equal(preset.name, "고기리공원");
    assert.equal(preset.transform.scale, 0.075);
    assert.ok(isBundledPreset(preset));
  });

  it("reads the kind from the file name, not the manifest", () => {
    const raw = JSON.stringify({
      objects: [
        { file: "a.glb", longitude: 1, latitude: 2, rotation: [0, 0, 0] },
        { file: "b.sog", longitude: 1, latitude: 2, rotation: [0, 0, 0] },
      ],
    });
    assert.deepEqual(
      parseBundledManifest(raw, BASE).map((preset) => preset.kind),
      ["model", "splat"],
    );
  });

  it("defaults altitude and scale but never the rotation", () => {
    // Splats and glTF models use different axis conventions, so a guessed
    // rotation lays one of them on its side — dropping the entry is louder.
    const raw = JSON.stringify({
      objects: [
        { file: "a.sog", longitude: 1, latitude: 2, rotation: [0, 0, 0] },
        { file: "b.sog", longitude: 1, latitude: 2 },
      ],
    });
    const presets = parseBundledManifest(raw, BASE);
    assert.equal(presets.length, 1);
    assert.equal(presets[0].transform.altitude, 0);
    assert.equal(presets[0].transform.scale, 1);
  });

  it("names an entry after its file when the manifest does not", () => {
    const raw = JSON.stringify({
      objects: [{ file: "park.sog", longitude: 1, latitude: 2, rotation: [0, 0, 0] }],
    });
    assert.equal(parseBundledManifest(raw, BASE)[0].name, "park.sog");
  });

  it("returns nothing for an empty, absent or malformed manifest", () => {
    assert.deepEqual(parseBundledManifest('{"objects":[]}', BASE), []);
    assert.deepEqual(parseBundledManifest("not json", BASE), []);
    assert.deepEqual(parseBundledManifest("{}", BASE), []);
    // An entry with no file has nothing to load.
    assert.deepEqual(parseBundledManifest('{"objects":[{"name":"x"}]}', BASE), []);
  });
});

describe("basemapExtrusionLayerIds", () => {
  const STYLE = [
    { id: "water", type: "fill" },
    { id: "building-3d", type: "fill-extrusion" },
    { id: "building-part", type: "fill-extrusion" },
    { id: "roads", type: "line" },
  ];

  it("picks the style's own extrusions", () => {
    assert.deepEqual(basemapExtrusionLayerIds(STYLE, new Set()), ["building-3d", "building-part"]);
  });

  it("spares extrusions the app owns", () => {
    // The VWorld 3D building layer is a fill-extrusion too. Hiding it along
    // with the basemap's would be a different bug wearing the same clothes.
    assert.deepEqual(basemapExtrusionLayerIds(STYLE, new Set(["building-part"])), ["building-3d"]);
    assert.deepEqual(
      basemapExtrusionLayerIds(STYLE, new Set(["building-3d", "building-part"])),
      [],
    );
  });

  it("ignores everything that is not extruded", () => {
    assert.deepEqual(basemapExtrusionLayerIds([{ id: "water", type: "fill" }], new Set()), []);
    assert.deepEqual(basemapExtrusionLayerIds([], new Set()), []);
  });
});

describe("placementBounds", () => {
  it("puts a box around the placement", () => {
    const [west, south, east, north] = placementBounds(127.0705, 37.357164, 150);
    assert.ok(west < 127.0705 && east > 127.0705);
    assert.ok(south < 37.357164 && north > 37.357164);
    // ~150 m north-south, in degrees of latitude.
    assert.ok(Math.abs((north - south) / 2 - 150 / 111320) < 1e-9);
  });

  it("widens the box in longitude as latitude rises", () => {
    // A degree of longitude shrinks towards the poles, so the same distance
    // spans more of them.
    const near = placementBounds(0, 0, 150);
    const far = placementBounds(0, 60, 150);
    assert.ok(far[2] - far[0] > near[2] - near[0]);
  });

  it("stays finite at the pole", () => {
    // cos() runs to zero there; without a floor the box would be the width of
    // the world.
    const [west, , east] = placementBounds(0, 90, 150);
    assert.ok(Number.isFinite(west) && Number.isFinite(east));
    assert.ok(east - west < 1);
  });
});

describe("parseBundledManifest asset locations", () => {
  const entry = {
    file: "park.sog",
    name: "Park",
    longitude: 127,
    latitude: 37,
    altitude: 0,
    scale: 1,
    rotation: [0, 0, 0],
    tileset: "park/tileset.json",
  };

  it("resolves against the app's objects folder by default", () => {
    const [preset] = parseBundledManifest(
      JSON.stringify({ objects: [entry] }),
      "http://localhost:5173/",
    );
    assert.equal(preset?.source, "http://localhost:5173/objects/park.sog");
    assert.equal(preset?.tileset, "http://localhost:5173/objects/park/tileset.json");
  });

  it("resolves against a file server when the manifest names one", () => {
    // The binaries are tens of megabytes and gitignored, so an installer
    // carried to another machine arrives without them unless they are served.
    const [preset] = parseBundledManifest(
      JSON.stringify({ baseUrl: "http://files.example/3d", objects: [entry] }),
      "http://localhost:5173/",
    );
    assert.equal(preset?.source, "http://files.example/3d/park.sog");
    assert.equal(preset?.tileset, "http://files.example/3d/park/tileset.json");
  });

  it("leaves an entry that names its own host alone", () => {
    const [preset] = parseBundledManifest(
      JSON.stringify({
        baseUrl: "http://files.example/3d/",
        objects: [{ ...entry, file: "https://cdn.example/one.sog" }],
      }),
      "http://localhost:5173/",
    );
    assert.equal(preset?.source, "https://cdn.example/one.sog");
  });
});
