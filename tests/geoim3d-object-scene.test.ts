import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  disposeLoadedObject,
  placeLoadedObject,
  scenePosition,
} from "../packages/plugins/src/plugins/geoim3d-object-scene";

/** A stand-in for the three.js nodes the renderer holds. */
function node() {
  const vec = () => {
    const value = {
      x: 0,
      y: 0,
      z: 0,
      set: (x: number, y: number, z: number) => {},
      setScalar: (v: number) => {},
    };
    value.set = (x, y, z) => {
      value.x = x;
      value.y = y;
      value.z = z;
    };
    value.setScalar = (v) => value.set(v, v, v);
    return value;
  };
  return { position: vec(), rotation: vec(), scale: vec() };
}

function control(kind: "splat" | "model", child: Record<string, unknown>, group = node()) {
  const entry =
    kind === "splat" ? { rtcGroup: group, mesh: child } : { rtcGroup: group, scene: child };
  const map = new Map([["id-1", entry]]);
  return kind === "splat" ? { _splatLayers: map } : { _modelLayers: map };
}

describe("scenePosition", () => {
  it("puts the origin at zero and keeps the axes signed", () => {
    const [ox, oy, oz] = scenePosition(0, 0, 0);
    for (const axis of [ox, oy, oz]) assert.ok(Math.abs(axis) < 1e-9);
    // East is -x and north is -y in this scene, matching the plugin's own
    // mercator transform; a sign flip here would mirror every object.
    const [x, y] = scenePosition(10, 10, 0);
    assert.ok(x < 0 && y < 0);
  });

  it("converts altitude to the same units per metre as the horizontal axes", () => {
    const lat = 37.5486;
    // One metre north, measured on the y axis, must equal one metre of altitude
    // on the z axis — otherwise the altitude field is not in metres.
    const metreInDegrees = 1 / 111_320;
    const [, yBase] = scenePosition(0, lat, 0);
    const [, yNorth] = scenePosition(0, lat + metreInDegrees, 0);
    const [, , zUp] = scenePosition(0, lat, 1);
    assert.ok(Math.abs(Math.abs(yNorth - yBase) - zUp) / zUp < 0.01);
  });
});

describe("placeLoadedObject", () => {
  it("writes the placement onto the group and scales the splat mesh", () => {
    const group = node();
    const mesh = node();
    const applied = placeLoadedObject(control("splat", mesh, group), "id-1", "splat", {
      longitude: 126.6,
      latitude: 37.5,
      altitude: -20,
      scale: 0.05,
      rotation: [270, 221, 0],
    });

    assert.equal(applied, true);
    assert.deepEqual(scenePosition(126.6, 37.5, -20), [
      group.position.x,
      group.position.y,
      group.position.z,
    ]);
    assert.ok(Math.abs(group.rotation.x - (270 * Math.PI) / 180) < 1e-12);
    // Uniform on a splat: the library scales the mesh, never the group.
    assert.deepEqual([mesh.scale.x, mesh.scale.y, mesh.scale.z], [0.05, 0.05, 0.05]);
    assert.deepEqual([group.scale.x, group.scale.y, group.scale.z], [0, 0, 0]);
  });

  it("flips Y on a model, as the loader does", () => {
    const scene = node();
    placeLoadedObject(control("model", scene), "id-1", "model", {
      longitude: 0,
      latitude: 0,
      altitude: 0,
      scale: 2,
      rotation: [0, 0, 0],
    });
    assert.deepEqual([scene.scale.x, scene.scale.y, scene.scale.z], [2, -2, 2]);
  });

  it("reports failure when the renderer's layer maps cannot be read", () => {
    const placement = {
      longitude: 0,
      latitude: 0,
      altitude: 0,
      scale: 1,
      rotation: [0, 0, 0] as const,
    };
    // A rename upstream must cost the optimisation, not the feature: the caller
    // falls back to a reload on false.
    assert.equal(placeLoadedObject({}, "id-1", "splat", placement), false);
    assert.equal(placeLoadedObject(control("splat", node()), "other", "splat", placement), false);
    assert.equal(
      placeLoadedObject({ _splatLayers: new Map([["id-1", {}]]) }, "id-1", "splat", placement),
      false,
    );
  });
});

describe("disposeLoadedObject", () => {
  it("frees a splat mesh's own buffers", () => {
    let freed = 0;
    const mesh = { ...node(), dispose: () => (freed += 1) };
    disposeLoadedObject(control("splat", mesh), "id-1");
    assert.equal(freed, 1);
  });

  it("walks a model scene and frees geometry and every material slot", () => {
    const freed: string[] = [];
    const child = {
      geometry: { dispose: () => freed.push("geometry") },
      material: [
        { dispose: () => freed.push("material-0") },
        { dispose: () => freed.push("material-1") },
      ],
    };
    const scene = {
      ...node(),
      traverse: (visit: (n: typeof child) => void) => visit(child),
    };
    disposeLoadedObject(control("model", scene), "id-1");
    assert.deepEqual(freed, ["geometry", "material-0", "material-1"]);
  });

  it("does nothing when the object is not held", () => {
    assert.doesNotThrow(() => disposeLoadedObject({}, "id-1"));
  });
});

describe("scenePosition against the renderer's own transform", () => {
  it("matches @dvt3d/maplibre-three-plugin, which seats the group", async () => {
    // `scenePosition` mirrors that package's `lngLatToVector3`. The package is
    // reached only through the splat control, so the plugin cannot import it —
    // but the test can, which turns a silent mirror into a checked one. If it
    // ever stops resolving, say so rather than passing quietly.
    let SceneTransform: { lngLatToVector3: (v: number[]) => { x: number; y: number; z: number } };
    try {
      ({ SceneTransform } = await import("@dvt3d/maplibre-three-plugin"));
    } catch {
      assert.fail(
        "@dvt3d/maplibre-three-plugin did not resolve; scenePosition's mirror is unchecked",
      );
    }

    for (const [lng, lat, alt] of [
      [126.6, 37.5, -20],
      [0, 0, 0],
      [-122.4, 47.6, 250],
    ]) {
      const expected = SceneTransform.lngLatToVector3([lng, lat, alt]);
      const [x, y, z] = scenePosition(lng, lat, alt);
      assert.ok(Math.abs(x - expected.x) < 1e-6, `x at ${lng},${lat}`);
      assert.ok(Math.abs(y - expected.y) < 1e-6, `y at ${lng},${lat}`);
      assert.ok(Math.abs(z - expected.z) < 1e-9, `z at ${lng},${lat},${alt}`);
    }
  });
});
