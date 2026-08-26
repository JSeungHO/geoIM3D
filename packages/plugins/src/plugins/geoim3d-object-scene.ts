/**
 * Direct access to the 3D objects `maplibre-gl-splat` has already loaded.
 *
 * The control's public surface is `load` / `removeSplat` / `removeModel` and
 * nothing else, so the panel used to move an object by removing it and loading
 * it again. That is what made a few dozen position tweaks end in
 * `RangeError: Array buffer allocation failed` inside the SOG unpack worker:
 * every Apply re-unpacked the whole file, and the control never disposes what
 * it drops (`removeSplat` detaches the group from the scene and returns — there
 * is not one `dispose` call in the library). The heap fills and the object
 * silently stops rendering.
 *
 * Both paths below reach the control's private layer maps. That is deliberate:
 * the objects held there are ordinary three.js nodes, so moving one is a
 * transform write rather than a reload, and freeing one is a `dispose` call.
 * Every reach is guarded and reports failure to the caller, which falls back to
 * the reload path — so a rename upstream costs the optimisation, not the
 * feature.
 */

/** The three.js surface used here, structurally — `three` stays out of the graph. */
interface SceneNode {
  position: { set: (x: number, y: number, z: number) => void };
  rotation: { set: (x: number, y: number, z: number) => void };
  scale: {
    set: (x: number, y: number, z: number) => void;
    setScalar?: (v: number) => void;
  };
  traverse?: (visit: (node: DisposableNode) => void) => void;
}

interface DisposableNode {
  dispose?: () => void;
  geometry?: { dispose?: () => void };
  material?: { dispose?: () => void } | Array<{ dispose?: () => void }>;
}

/** What a control's private layer map holds, for either object kind. */
interface RendererEntry {
  rtcGroup?: SceneNode;
  /** The splat mesh (splat layers) or the glTF scene (model layers). */
  mesh?: SceneNode & DisposableNode;
  scene?: SceneNode & DisposableNode;
}

type ObjectKind = "splat" | "model";

/** Placement in map terms: degrees, metres, and a uniform scale factor. */
export interface ScenePlacement {
  longitude: number;
  latitude: number;
  /** Metres above the ellipsoid. */
  altitude: number;
  scale: number;
  /** XYZ Euler rotation in degrees. */
  rotation: readonly [number, number, number];
}

const EARTH_RADIUS_M = 6371008.8;
const CIRCUMFERENCE_M = 2 * Math.PI * EARTH_RADIUS_M;
// The plugin's world is mercator scaled to 1024000 units around the equator.
const UNITS_PER_CIRCUMFERENCE = 1024000 / CIRCUMFERENCE_M;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Scene-graph position for a placement.
 *
 * Mirrors `SceneTransform.lngLatToVector3` in `@dvt3d/maplibre-three-plugin`,
 * which is what `createMercatorRTCGroup` uses to seat a group. Reimplemented
 * rather than imported because that package is a transitive dependency reached
 * only through the splat control; a direct import would make this plugin depend
 * on a package it never installs.
 *
 * @param longitude - Degrees east.
 * @param latitude - Degrees north.
 * @param altitude - Metres above the ellipsoid.
 * @returns The `[x, y, z]` the group's position takes.
 */
export function scenePosition(
  longitude: number,
  latitude: number,
  altitude: number,
): [number, number, number] {
  const x = -EARTH_RADIUS_M * DEG_TO_RAD * longitude * UNITS_PER_CIRCUMFERENCE;
  const y =
    -EARTH_RADIUS_M *
    Math.log(Math.tan(Math.PI / 4 + 0.5 * DEG_TO_RAD * latitude)) *
    UNITS_PER_CIRCUMFERENCE;
  // Longitude degrees shrink towards the poles and so do the units a metre
  // spans; the floor keeps the altitude finite where cos() runs to zero.
  const cos = Math.max(Math.abs(Math.cos(DEG_TO_RAD * latitude)), 1e-6);
  return [x, y, altitude * (UNITS_PER_CIRCUMFERENCE / cos)];
}

/**
 * Reads a loaded object's entry out of the control's private layer maps.
 *
 * @param control - The `GaussianSplatControl`.
 * @param loaderId - The id `load` returned.
 * @returns The entry, or null when the control does not hold it.
 */
function entryOf(control: unknown, loaderId: string): RendererEntry | null {
  const maps = control as {
    _splatLayers?: Map<string, RendererEntry>;
    _modelLayers?: Map<string, RendererEntry>;
  };
  const entry = maps?._splatLayers?.get(loaderId) ?? maps?._modelLayers?.get(loaderId);
  return entry ?? null;
}

/**
 * Moves, turns and resizes an already-loaded object in place.
 *
 * @param control - The `GaussianSplatControl`.
 * @param loaderId - The id `load` returned.
 * @param kind - Which flip the child needs; a model is authored Y-up.
 * @param placement - Where the object should sit.
 * @returns True when it was applied; false when the caller must reload instead.
 */
export function placeLoadedObject(
  control: unknown,
  loaderId: string,
  kind: ObjectKind,
  placement: ScenePlacement,
): boolean {
  const entry = entryOf(control, loaderId);
  const group = entry?.rtcGroup;
  const child = entry?.mesh ?? entry?.scene;
  if (!group || !child) return false;

  const [x, y, z] = scenePosition(placement.longitude, placement.latitude, placement.altitude);
  group.position.set(x, y, z);
  group.rotation.set(
    placement.rotation[0] * DEG_TO_RAD,
    placement.rotation[1] * DEG_TO_RAD,
    placement.rotation[2] * DEG_TO_RAD,
  );
  // The group's own scale stays as loaded. `createMercatorRTCGroup` types its
  // scale as a vector and the control hands it a number, so `scale[0]` reads
  // undefined and the group is left at 1 — the size the user sees comes from
  // the child alone, and that is what has to change here.
  const { scale } = placement;
  if (kind === "model") child.scale.set(scale, -scale, scale);
  else if (child.scale.setScalar) child.scale.setScalar(scale);
  else child.scale.set(scale, scale, scale);
  return true;
}

/**
 * Frees the GPU and heap buffers behind a loaded object.
 *
 * Call before handing the id to `removeSplat` / `removeModel`, which drop the
 * group without disposing anything.
 *
 * @param control - The `GaussianSplatControl`.
 * @param loaderId - The id `load` returned.
 */
export function disposeLoadedObject(control: unknown, loaderId: string): void {
  const entry = entryOf(control, loaderId);
  const root = entry?.mesh ?? entry?.scene;
  if (!root) return;
  const free = (node: DisposableNode) => {
    node.dispose?.();
    node.geometry?.dispose?.();
    const { material } = node;
    if (Array.isArray(material)) for (const slot of material) slot.dispose?.();
    else material?.dispose?.();
  };
  // A splat mesh owns its buffers directly; a glTF scene holds them on the
  // meshes below it.
  if (root.traverse) root.traverse(free);
  else free(root);
}
