/**
 * Saved 3D object placements. Only the **source** is stored, never a
 * readable URL — `blob:`/`asset:` die with the page or need reauthorizing.
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
  /** A 3D Tiles `tileset.json` for the same site — the one form the Cesium globe can show. */
  tileset?: string;
  /** The tileset's own placement; its origin/scale differ from the splat's. */
  tilesetTransform?: ObjectTransform;
}

/** Whether a source can be reloaded later — false for any `blob:`/`asset:` pick. */
export function isDurableSource(source: string): boolean {
  return !/^(blob|asset):/i.test(source) && source.trim().length > 0;
}

/** Reads presets out of stored JSON, dropping anything malformed rather than the whole list. */
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

/** Reads an optional transform out of manifest JSON; undefined if absent or incomplete. */
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

/** Adds a preset, replacing one with the same source (saving twice means "these are the numbers now"). */
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

/** Loads the saved presets, or an empty list where there is no storage. */
export function loadPresets(): ObjectPreset[] {
  if (typeof localStorage === "undefined") return [];
  try {
    return parsePresets(localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

/** Writes the presets back. */
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

/** Where the sample objects are listed — a remote file server, not the app bundle. */
export const BUNDLED_OBJECTS_MANIFEST =
  "http://remote.ejbt.co.kr:45673/files/objects/manifest.json";

/** Marks a preset that ships with the app, so the UI does not offer to delete it. */
export const BUNDLED_PRESET_ID_PREFIX = "bundled:";

/** Whether a preset came from the shipped manifest rather than the user. */
export function isBundledPreset(preset: ObjectPreset): boolean {
  return preset.id.startsWith(BUNDLED_PRESET_ID_PREFIX);
}

/** A URL that already names its own host is left alone. */
function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

/** Resolves a manifest entry's `file`/`tileset` against the manifest's base, unless it's already a full URL. */
function resolveAsset(value: string, root: string): string {
  return isAbsoluteUrl(value) ? value : new URL(value, root).href;
}

/** Turns the shipped manifest into presets, validated the same way a stored preset is. */
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

  // `baseUrl` points at a file server; relative to the app when absent.
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
 * The style's own `fill-extrusion` buildings (not the user's, e.g. VWorld's
 * 3D layer) — ownership by native id, not by name.
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

// ponytail: a guess (no library API reports a loaded splat's real bounding box);
// compute from the mesh if one is ever exposed.
const PLACEMENT_RADIUS_M = 150;

/** A small box around an object's placement, so the layer panel's zoom button has bounds. */
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
