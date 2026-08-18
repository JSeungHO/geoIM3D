import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OBJECT_EXTENSIONS,
  defaultRotation,
  needsNativeFetch,
  objectKind,
  objectName,
} from "../packages/plugins/src/plugins/geoim3d-objects";

describe("objectKind", () => {
  it("routes glTF and GLB to the model loader", () => {
    assert.equal(objectKind("scene.glb"), "model");
    assert.equal(objectKind("scene.gltf"), "model");
  });

  it("routes every splat format to the splat loader", () => {
    for (const extension of ["splat", "ply", "spz", "ksplat", "sog"]) {
      assert.equal(objectKind(`scene.${extension}`), "splat", extension);
    }
  });

  it("reads the extension off the path, not the query string", () => {
    // A signed URL is the normal way to serve a private object. Matching the
    // whole string would make the extension unrecognizable and refuse a file
    // the loader can read.
    assert.equal(objectKind("https://host/scene.glb?X-Amz-Signature=abc123"), "model");
    assert.equal(objectKind("https://host/a.sog#section"), "splat");
    // ...and a query that itself ends in a known extension must not decide it.
    assert.equal(objectKind("https://host/readme.txt?name=scene.glb"), null);
  });

  it("ignores case", () => {
    assert.equal(objectKind("SCENE.GLB"), "model");
    assert.equal(objectKind("Scene.Ply"), "splat");
  });

  it("declines what the loader cannot read", () => {
    assert.equal(objectKind("scene.obj"), null);
    assert.equal(objectKind("tileset.json"), null);
    assert.equal(objectKind("noextension"), null);
    assert.equal(objectKind(""), null);
  });

  it("classifies every extension the file dialog offers", () => {
    // The dialog filter and the loader must agree, or a user can pick a file
    // that is then refused.
    for (const extension of OBJECT_EXTENSIONS) {
      assert.ok(objectKind(`scene.${extension}`), extension);
    }
  });
});

describe("defaultRotation", () => {
  it("orients splats and models by their own conventions", () => {
    // Authored in different axis conventions: one default would lay the other
    // on its side.
    assert.deepEqual(defaultRotation("splat"), [-90, 90, 0]);
    assert.deepEqual(defaultRotation("model"), [90, 0, 0]);
  });
});

describe("needsNativeFetch", () => {
  const ORIGIN = "http://localhost:5173";

  it("is true for cross-origin plain http", () => {
    assert.equal(needsNativeFetch("http://host/a.glb", ORIGIN), true);
    assert.equal(needsNativeFetch("HTTP://host/a.glb", ORIGIN), true);
  });

  it("leaves the app's own origin alone", () => {
    // An object shipped in public/objects/ is served from the app itself,
    // which is plain http in development. Sending that to a native fetcher the
    // browser build does not have made the shipped sample refuse to load with
    // nothing shown on the map.
    assert.equal(needsNativeFetch(`${ORIGIN}/objects/park.sog`, ORIGIN), false);
    assert.equal(needsNativeFetch(`${ORIGIN}/a.glb`, "HTTP://LOCALHOST:5173"), false);
    // A different port is a different origin.
    assert.equal(needsNativeFetch("http://localhost:4173/a.glb", ORIGIN), true);
  });

  it("assumes the worst when the origin is unknown or the URL is malformed", () => {
    assert.equal(needsNativeFetch("http://host/a.glb", ""), true);
    assert.equal(needsNativeFetch("http://", ORIGIN), true);
  });

  it("leaves everything the webview can already read alone", () => {
    // https streams from the webview; the rest are already local. Sending any
    // of them through the native fetcher would pull the whole file into memory
    // for nothing.
    assert.equal(needsNativeFetch("https://host/a.glb"), false);
    assert.equal(needsNativeFetch("blob:http://localhost/abc"), false);
    assert.equal(needsNativeFetch("asset://localhost/C:/a.glb"), false);
    assert.equal(needsNativeFetch("C:\\models\\a.glb"), false);
  });
});

describe("objectName", () => {
  it("names a file by its last path segment", () => {
    assert.equal(objectName("https://host/models/scene.glb"), "scene.glb");
    assert.equal(objectName("C:\\models\\scene.splat"), "scene.splat");
  });

  it("drops the query string and decodes the name", () => {
    assert.equal(objectName("https://host/my%20scene.glb?token=abc"), "my scene.glb");
  });

  it("falls back to the source when there is no segment", () => {
    assert.equal(objectName("scene.glb"), "scene.glb");
    assert.equal(objectName(""), "");
  });
});
