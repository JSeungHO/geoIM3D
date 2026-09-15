/**
 * Saved 3D object placements.
 *
 * Getting an object onto the right spot takes a longitude, a latitude, an
 * altitude, a scale and three rotations, found by trial. Losing that on every
 * reload is the difference between a map you can show someone and one you
 * rebuild first, so the numbers are kept beside the file they belong to.
 *
 * Only the **source** is stored, never the readable URL: a `blob:` is dead the
 * moment the page reloads, and an `asset:` URL is meaningless without the path
 * behind it. A desktop path survives because Tauri's persisted-scope plugin
 * keeps a file the user picked authorized across restarts.
 */

import type { ObjectKind, ObjectTransform } from "./geoim3d-objects";

const STORAGE_KEY = "geoim3d.object-presets";

/** A file plus where it sits. */
export interface ObjectPreset {
  /** Stable id, so a rename or an edit does not create a second entry. */
  id: string;
  /** What to call it in the menu. Defaults to the file name. */
  name: string;
  /** The URL or absolute path to load. Never a blob: or asset: URL. */
  source: string;
  kind: ObjectKind;
  transform: ObjectTransform;
  /**
   * A 3D Tiles `tileset.json` showing the same site, if one was built.
   *
   * The splat renderer draws into the 2D map only, so the Cesium globe shows
   * nothing for a splat preset. A tileset is the one 3D form that globe can
   * render, and this is where a preset says it has one.
   */
  tileset?: string;
  /**
   * Where the tileset sits, when it needs different numbers from the splat.
   *
   * It does: a splat's origin is wherever the scan started and its scale is in
   * arbitrary units, while a tileset is centred on its own bounding box and
   * built in metres. One set of numbers cannot place both.
   */
  tilesetTransform?: ObjectTransform;
}

/**
 * Whether a source can be reloaded in a later session.
 *
 * A `blob:` URL cannot: it belongs to the page that made it. That is every
 * browser file pick, so those objects can be placed but not saved.
 *
 * @param source - The source recorded for an object.
 * @returns True when saving it is worth anything.
 */
export function isDurableSource(source: string): boolean {
  return !/^(blob|asset):/i.test(source) && source.trim().length > 0;
}

/**
 * Reads presets out of stored JSON, dropping anything malformed.
 *
 * Tolerant on purpose: this is user-local storage that an older or newer build
 * may have written, and losing one bad entry beats throwing away the list.
 *
 * @param raw - The stored string, or null when nothing is stored.
 * @returns The presets that parsed.
 */
export function parsePresets(raw: string | null): ObjectPreset[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isPreset);
}

/**
 * Reads an optional transform out of manifest JSON.
 *
 * @param value - The raw entry.
 * @returns The transform, or undefined when it is absent or incomplete.
 */
function readTransform(value: unknown): ObjectTransform | undefined {
  const raw = value as Partial<ObjectTransform> | null;
  if (!raw) return undefined;
  const numbers = [raw.longitude, raw.latitude, raw.altitude, raw.scale];
  if (!numbers.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    return undefined;
  }
  const rotation = raw.rotation;
  if (!Array.isArray(rotation) || rotation.length !== 3) return undefined;
  if (!rotation.every((angle) => typeof angle === "number")) return undefined;
  return {
    longitude: raw.longitude as number,
    latitude: raw.latitude as number,
    altitude: raw.altitude as number,
    scale: raw.scale as number,
    rotation: [rotation[0], rotation[1], rotation[2]],
  };
}

function isPreset(value: unknown): value is ObjectPreset {
  const entry = value as Partial<ObjectPreset> | null;
  const transform = entry?.transform as Partial<ObjectTransform> | undefined;
  return (
    typeof entry?.id === "string" &&
    typeof entry.name === "string" &&
    typeof entry.source === "string" &&
    (entry.kind === "splat" || entry.kind === "model") &&
    typeof transform?.longitude === "number" &&
    typeof transform.latitude === "number" &&
    typeof transform.altitude === "number" &&
    typeof transform.scale === "number" &&
    Array.isArray(transform.rotation) &&
    transform.rotation.length === 3 &&
    transform.rotation.every((angle) => typeof angle === "number")
  );
}

/**
 * Adds a preset, replacing one with the same source.
 *
 * Keyed by source rather than appended: saving the same file twice means "these
 * are the numbers now", not "keep both".
 *
 * @param presets - The current list.
 * @param preset - The preset to store.
 * @returns The new list.
 */
export function upsertPreset(
  presets: readonly ObjectPreset[],
  preset: ObjectPreset,
): ObjectPreset[] {
  const rest = presets.filter((entry) => entry.source !== preset.source);
  return [...rest, preset];
}

/* -------------------------------------------------------------------------- */
/* Storage                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Loads the saved presets.
 *
 * @returns The presets, or an empty list where there is no storage.
 */
export function loadPresets(): ObjectPreset[] {
  if (typeof localStorage === "undefined") return [];
  try {
    return parsePresets(localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

/**
 * Writes the presets back.
 *
 * @param presets - The list to store.
 */
export function savePresets(presets: readonly ObjectPreset[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // Quota or a disabled store: the objects on the map are unaffected, and
    // failing the save loudly would interrupt work it cannot rescue.
  }
}

/* -------------------------------------------------------------------------- */
/* Bundled objects                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Where the sample objects and their placements are listed.
 *
 * Points at geoIM3D's own file server rather than `public/objects/` in the
 * app bundle — the samples are tens of megabytes each, and hosting them
 * remotely keeps the installer from carrying that weight. The manifest
 * itself still names a `baseUrl` for its entries' files/tilesets (see
 * `parseBundledManifest`); this constant only says where the manifest is.
 */
export const BUNDLED_OBJECTS_MANIFEST =
  "http://remote.ejbt.co.kr:45673/files/objects/manifest.json";

/** Marks a preset that ships with the app, so the UI does not offer to delete it. */
export const BUNDLED_PRESET_ID_PREFIX = "bundled:";

/**
 * Whether a preset came from the shipped manifest rather than the user.
 *
 * @param preset - The preset to test.
 * @returns True when it ships with the app.
 */
export function isBundledPreset(preset: ObjectPreset): boolean {
  return preset.id.startsWith(BUNDLED_PRESET_ID_PREFIX);
}

/**
 * Turns the shipped manifest into presets.
 *
 * The manifest names a file and where it sits; the URL is built from the app's
 * own base, so the object is same-origin — no picker, no native fetch, and
 * nothing for the CSP to refuse, on the desktop and in a browser alike.
 *
 * Each entry is validated the same way a stored preset is: a placement missing
 * a number would put the object at NaN, which renders nothing and reads as a
 * broken file rather than a broken manifest.
 *
 * @param raw - The manifest's contents.
 * @param baseUrl - The app's base URL, for resolving each file.
 * @returns The presets the manifest describes.
 */
/** A URL that already names its own host is left alone. */
function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

/**
 * Where one of a manifest entry's files actually is.
 *
 * An entry may name a bare file (resolved against the manifest's base, which is
 * either the app's `objects/` folder or a file server) or a full URL of its
 * own, for the odd object that lives somewhere else.
 *
 * @param value - The `file` or `tileset` the entry names.
 * @param root - The manifest's base, already ending in a slash.
 * @returns The absolute URL to load.
 */
function resolveAsset(value: string, root: string): string {
  return isAbsoluteUrl(value) ? value : new URL(value, root).href;
}

export function parseBundledManifest(raw: string, baseUrl: string): ObjectPreset[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const document = parsed as { objects?: unknown; baseUrl?: unknown } | null;
  const entries = document?.objects;
  if (!Array.isArray(entries)) return [];

  // Where the binaries live. They are tens of megabytes each and gitignored, so
  // an installer carried to another machine either bloats by that much or
  // arrives without them; `baseUrl` points the whole manifest at a file server
  // instead, and the app ships only this file. Relative to the app when absent,
  // which is the bundled layout.
  const root =
    typeof document?.baseUrl === "string" && document.baseUrl.trim()
      ? withTrailingSlash(document.baseUrl.trim())
      : new URL("objects/", baseUrl).href;

  const presets: ObjectPreset[] = [];
  for (const entry of entries) {
    const item = entry as Record<string, unknown> | null;
    const file = typeof item?.file === "string" ? item.file.trim() : "";
    if (!file) continue;
    const source = resolveAsset(file, root);
    const candidate = {
      id: `${BUNDLED_PRESET_ID_PREFIX}${file}`,
      name: typeof item?.name === "string" && item.name ? item.name : file,
      source,
      // Read from the file name, so the manifest cannot disagree with the file
      // about what it is.
      kind: /\.(glb|gltf)$/i.test(file) ? "model" : "splat",
      transform: {
        longitude: item?.longitude,
        latitude: item?.latitude,
        altitude: item?.altitude ?? 0,
        scale: item?.scale ?? 1,
        rotation: item?.rotation,
      },
      // Resolved like `file`: against the manifest's own base.
      tileset:
        typeof item?.tileset === "string" && item.tileset.trim()
          ? resolveAsset(item.tileset.trim(), root)
          : undefined,
      tilesetTransform: readTransform(item?.tilesetTransform),
    };
    if (isPreset(candidate)) presets.push(candidate);
  }
  return presets;
}

/* -------------------------------------------------------------------------- */
/* Basemap building extrusions                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The style's own 3D buildings, which are not any layer of ours.
 *
 * A basemap style draws buildings with `fill-extrusion`, and at street level
 * they stand in front of an uploaded scan and hide it. Turning them off has to
 * spare the user's own extrusions — the VWorld 3D building layer is a
 * `fill-extrusion` too, and hiding that along with the basemap's would be a
 * different bug wearing the same clothes.
 *
 * The test is ownership, not naming: every layer GeoLibre puts on the map
 * records its native ids, so anything extruded that is not among them belongs
 * to the style.
 *
 * @param styleLayerIds - Ids and types from `map.getStyle().layers`.
 * @param ownedNativeIds - Native layer ids claimed by the app's own layers.
 * @returns The style's extrusion layer ids.
 */
export function basemapExtrusionLayerIds(
  styleLayerIds: ReadonlyArray<{ id: string; type: string }>,
  ownedNativeIds: ReadonlySet<string>,
): string[] {
  return styleLayerIds
    .filter((layer) => layer.type === "fill-extrusion" && !ownedNativeIds.has(layer.id))
    .map((layer) => layer.id);
}

/* -------------------------------------------------------------------------- */
/* Placement bounds                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Half-width of the box an object claims on the map, in metres.
 *
 * ponytail: a guess, because the real extent is not knowable from here — the
 * scale is a multiplier on the source file's own size, and nothing public on a
 * loaded splat reports its bounding box. 150 m suits the site scans this is
 * built for (a park, a building and its grounds) and puts the zoom button
 * somewhere near where the object was loaded. Compute it from the mesh if the
 * library ever exposes one.
 */
const PLACEMENT_RADIUS_M = 150;

/**
 * A small box around an object's placement.
 *
 * The layer panel's zoom button needs bounds; without them it looks up the
 * layer, finds nothing, and returns — the button did nothing at all for a 3D
 * object.
 *
 * @param longitude - Placement longitude.
 * @param latitude - Placement latitude.
 * @param radiusMetres - Half-width of the box. Defaults to {@link PLACEMENT_RADIUS_M}.
 * @returns `[west, south, east, north]`.
 */
export function placementBounds(
  longitude: number,
  latitude: number,
  radiusMetres: number = PLACEMENT_RADIUS_M,
): [number, number, number, number] {
  const latDelta = radiusMetres / 111_320;
  // Longitude degrees shrink towards the poles; the floor keeps the box from
  // exploding near them, where cos() runs to zero.
  const cos = Math.max(Math.cos((latitude * Math.PI) / 180), 0.01);
  const lonDelta = latDelta / cos;
  return [longitude - lonDelta, latitude - latDelta, longitude + lonDelta, latitude + latDelta];
}
