import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, serializeProject, useAppStore } from "@geolibre/core";
import { strToU8, zipSync } from "fflate";
import {
  gaussianSplatPlacementAtMapCenter,
  isGaussianSplatPlyFileName,
  isGaussianSplatSogZip,
  partitionGaussianSplatFiles,
  partitionGaussianSplatPaths,
  partitionGaussianSplatPlyFiles,
  selectGaussianSplatRenderingWorkspace,
} from "../apps/geolibre-desktop/src/lib/gaussian-splat-drop";
// Moved with the loader that uses them: local files are opened by the geoIM3D
// object plugin now, not by a second copy inside the Components plugin.
import {
  MAX_LOCAL_OBJECT_BYTES,
  validateLocalObjectFile,
} from "../packages/plugins/src/plugins/geoim3d-objects";

describe("local Gaussian Splat file drop", () => {
  it("converts the current map center into Gaussian Splat placement options", () => {
    assert.deepEqual(gaussianSplatPlacementAtMapCenter([126.978, 37.5665]), {
      longitude: 126.978,
      latitude: 37.5665,
    });
  });

  it("accepts PLY files case-insensitively without treating archives as PLY", () => {
    assert.equal(isGaussianSplatPlyFileName("scene.ply"), true);
    assert.equal(isGaussianSplatPlyFileName("SCENE.PLY"), true);
    assert.equal(isGaussianSplatPlyFileName("scene.ply.zip"), false);
    assert.equal(isGaussianSplatPlyFileName("points.las"), false);
  });

  it("enforces the same 2 GB ceiling for browser local splats", () => {
    assert.doesNotThrow(() =>
      validateLocalObjectFile({
        name: "limit.ply",
        size: MAX_LOCAL_OBJECT_BYTES,
      }),
    );
    assert.throws(
      () =>
        validateLocalObjectFile({
          name: "too-large.ply",
          size: MAX_LOCAL_OBJECT_BYTES + 1,
        }),
      /too large to open in the app/,
    );
  });

  it("partitions splat PLY files away from the generic vector/raster pipeline", () => {
    const files = [{ name: "building.geojson" }, { name: "capture.PLY" }, { name: "terrain.tif" }];

    const result = partitionGaussianSplatPlyFiles(files);

    assert.deepEqual(
      result.splatFiles.map((file) => file.name),
      ["capture.PLY"],
    );
    assert.deepEqual(
      result.otherFiles.map((file) => file.name),
      ["building.geojson", "terrain.tif"],
    );
  });

  it("recognizes a zipped SOG archive from bounded meta.json inspection", async () => {
    const archive = zipSync({
      "scene/meta.json": strToU8(
        JSON.stringify({
          version: 2,
          means: { files: ["means.bin"], mins: [0, 0, 0], maxs: [1, 1, 1] },
          scales: { files: ["scales.bin"], codebook: [0] },
          quats: { files: ["quats.bin"] },
          sh0: { files: ["sh0.bin"], codebook: [0] },
        }),
      ),
      "scene/means.bin": new Uint8Array([1]),
    });
    const file = new File([archive], "scene.zip", { type: "application/zip" });

    assert.equal(await isGaussianSplatSogZip(file), true);
    const result = await partitionGaussianSplatFiles([file]);
    assert.deepEqual(result.splatFiles, [file]);
    assert.deepEqual(result.otherFiles, []);
  });

  it("leaves ordinary ZIP files on the existing import path", async () => {
    const archive = zipSync({ "roads.geojson": strToU8('{"type":"FeatureCollection"}') });
    const file = new File([archive], "vectors.zip", { type: "application/zip" });

    assert.equal(await isGaussianSplatSogZip(file), false);
    const result = await partitionGaussianSplatFiles([file]);
    assert.deepEqual(result.splatFiles, []);
    assert.deepEqual(result.otherFiles, [file]);
  });

  it("partitions Tauri native PLY/SOG paths before DuckDB vector import", async () => {
    const reads: string[] = [];
    const result = await partitionGaussianSplatPaths(
      ["C:\\data\\goduck.sog", "C:\\data\\capture.PLY", "C:\\data\\roads.geojson"],
      async (path, name) => {
        reads.push(path);
        return new File([new Uint8Array([1, 2, 3])], name);
      },
      async () => false,
    );

    assert.deepEqual(
      result.splatFiles.map((file) => file.name),
      ["goduck.sog", "capture.PLY"],
    );
    assert.deepEqual(result.otherPaths, ["C:\\data\\roads.geojson"]);
    assert.deepEqual(reads, ["C:\\data\\goduck.sog", "C:\\data\\capture.PLY"]);
  });

  it("streams native ZIP metadata before reading a validated SOG payload", async () => {
    const reads: string[] = [];
    const inspections: string[] = [];
    const result = await partitionGaussianSplatPaths(
      ["C:\\data\\scene.zip", "C:\\data\\vectors.zip"],
      async (path, name) => {
        reads.push(path);
        return new File([new Uint8Array([1, 2, 3])], name);
      },
      async (path) => {
        inspections.push(path);
        return path.endsWith("scene.zip");
      },
    );

    assert.deepEqual(inspections, ["C:\\data\\scene.zip", "C:\\data\\vectors.zip"]);
    assert.deepEqual(reads, ["C:\\data\\scene.zip"]);
    assert.deepEqual(
      result.splatFiles.map((file) => file.name),
      ["scene.zip"],
    );
    assert.deepEqual(result.otherPaths, ["C:\\data\\vectors.zip"]);
  });

  it("isolates a failed native splat while continuing later files", async () => {
    const result = await partitionGaussianSplatPaths(
      ["C:\\data\\broken.ply", "C:\\data\\valid.sog", "C:\\data\\roads.geojson"],
      async (path, name) => {
        if (path.endsWith("broken.ply")) throw new Error("read failed");
        return new File([new Uint8Array([1])], name);
      },
      async () => false,
    );

    assert.deepEqual(
      result.splatFiles.map((file) => file.name),
      ["valid.sog"],
    );
    assert.deepEqual(result.otherPaths, ["C:\\data\\roads.geojson"]);
    assert.equal(result.splatFailures.length, 1);
    assert.equal(result.splatFailures[0]?.path, "C:\\data\\broken.ply");
  });

  it("grants the Tauri stream commands required by native Splat reads", () => {
    const capability = JSON.parse(
      readFileSync(
        new URL("../apps/geolibre-desktop/src-tauri/capabilities/default.json", import.meta.url),
        "utf8",
      ),
    ) as { permissions: Array<string | Record<string, unknown>> };
    const commandPermissions = capability.permissions.filter(
      (permission): permission is string => typeof permission === "string",
    );

    assert.ok(commandPermissions.includes("fs:allow-open"));
    assert.ok(commandPermissions.includes("fs:allow-read"));
  });

  it("wires the Tauri native drop handler through splat partitioning before DuckDB", () => {
    const shell = readFileSync(
      new URL("../apps/geolibre-desktop/src/hooks/desktop-shell/useFileDrop.ts", import.meta.url),
      "utf8",
    );
    const nativeStart = shell.indexOf(".onDragDropEvent(async (event)");
    const browserStart = shell.indexOf("const handleDragEnter", nativeStart);
    const nativeHandler = shell.slice(nativeStart, browserStart);
    const partitionIndex = nativeHandler.indexOf("partitionGaussianSplatPaths(");
    const duckDbIndex = nativeHandler.indexOf("loadDroppedVectorPaths(containers.remaining");

    assert.ok(nativeStart >= 0 && browserStart > nativeStart);
    assert.ok(partitionIndex >= 0, "native handler must partition SOG/PLY paths");
    assert.ok(duckDbIndex > partitionIndex, "DuckDB must receive only remaining paths");
    assert.match(nativeHandler, /splatFiles\.length === 0/);
  });

  it("selects MapLibre only when a local splat will be rendered", () => {
    const selectedTabs: string[] = [];
    assert.equal(
      selectGaussianSplatRenderingWorkspace(0, (tab) => selectedTabs.push(tab)),
      false,
    );
    assert.equal(
      selectGaussianSplatRenderingWorkspace(2, (tab) => selectedTabs.push(tab)),
      true,
    );
    assert.deepEqual(selectedTabs, ["maplibre"]);
  });

  it("passes the current shared map center to browser and native splat loads", () => {
    const shell = readFileSync(
      new URL("../apps/geolibre-desktop/src/hooks/desktop-shell/useFileDrop.ts", import.meta.url),
      "utf8",
    );

    assert.match(
      shell,
      /gaussianSplatPlacementAtMapCenter\(\s*useAppStore\.getState\(\)\.mapView\.center\s*,?\s*\)/,
    );
    assert.equal(
      shell.match(/addDroppedObject\([^;]+splatPlacement\s*,?\s*\)/g)?.length,
      2,
      "both native and browser drop paths must use the captured map-center placement",
    );

    // The loader lives with the object plugin now, not in a second copy inside
    // the Components plugin.
    const plugin = readFileSync(
      new URL("../packages/plugins/src/plugins/geoim3d-objects.ts", import.meta.url),
      "utf8",
    );
    assert.match(plugin, /export async function addDroppedObject/);
  });

  it("does not persist session-only Blob-backed splat layers in a project", () => {
    const project = {
      version: "0.2.0",
      name: "Local splat",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: "https://example.com/style.json",
      basemapVisible: true,
      basemapOpacity: 1,
      selectedLayerId: "splat-0",
      layers: [
        {
          id: "splat-0",
          name: "capture",
          type: "gaussian-splat",
          source: { type: "gaussian-splat", url: "blob:https://app.example/local" },
          visible: true,
          opacity: 1,
          style: {},
          metadata: { sourceKind: "splatting-local-file" },
        },
      ],
      styles: {},
      preferences: {},
      secondaryMapViews: [
        {
          id: "pane-1",
          view: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
          layerVisibility: { "splat-0": false },
        },
      ],
    };

    const serialized = JSON.parse(serializeProject(project as never)) as {
      layers: unknown[];
      selectedLayerId: string | null;
      secondaryMapViews: Array<{ layerVisibility: Record<string, boolean> }>;
    };
    assert.deepEqual(serialized.layers, []);
    assert.equal(serialized.selectedLayerId, null);
    assert.deepEqual(serialized.secondaryMapViews[0]?.layerVisibility, {});
    assert.doesNotMatch(JSON.stringify(serialized), /blob:/);
  });

  it("keeps local Blob-backed splats out of undo history and project dirty state", () => {
    useAppStore.getState().newProject({ name: "Local splat history" });
    useAppStore.temporal.getState().clear();
    useAppStore.getState().markSaved();
    useAppStore.getState().addLayer({
      id: "local-splat-history",
      name: "capture",
      type: "gaussian-splat",
      source: { type: "gaussian-splat", url: "blob:history-probe" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: { sourceKind: "splatting-local-file" },
    });
    assert.equal(useAppStore.getState().isDirty, false);
    useAppStore.getState().setLayerVisibility("local-splat-history", false);
    assert.equal(useAppStore.getState().isDirty, false);

    const history = JSON.stringify(useAppStore.temporal.getState());
    assert.doesNotMatch(history, /local-splat-history|blob:history-probe/);
    useAppStore.getState().removeLayer("local-splat-history");
    assert.equal(useAppStore.getState().isDirty, false);
  });
});
