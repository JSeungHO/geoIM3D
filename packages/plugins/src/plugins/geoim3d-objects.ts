/**
 * geoIM3D 3D object upload.
 *
 * Puts local files and plain-`http://` URLs on the map, which Add Data could
 * not do: the desktop CSP allows `connect-src` to `https:` and localhost only,
 * so a webview request to any other plain-HTTP host is blocked before it is
 * sent, and there was no entry point for a file on disk at all.
 *
 * Nothing here renders anything. `maplibre-gl-splat` already loads `.splat`,
 * `.ply`, `.spz`, `.ksplat`, `.sog` and glTF/GLB, and already places them by
 * longitude/latitude/altitude with a scale and an XYZ rotation — this file is
 * the way in, plus the two shells that a webview cannot reach on its own:
 *
 * - **http URLs** go through {@link setObjectFetcher}, which the desktop app
 *   backs with a native request and hands back a `blob:` URL. That leaves the
 *   CSP untouched, so `tauri.conf.json` — an upstream file — needs no edit and
 *   cannot conflict on a merge.
 * - **local files** go through {@link setLocalObjectPicker}: a native dialog on
 *   the desktop (streamed from disk through the asset protocol) and a file
 *   input in the browser.
 *
 * `https:` skips both and is handed to the loader as-is; there is no reason to
 * pull a few hundred megabytes through memory when the webview can stream it.
 *
 * 3D Tiles are deliberately *not* handled here — a tileset carries its own
 * georeferencing, so position/scale/rotation do not apply to it. The menu
 * points at the existing 3D Tiles panel instead.
 */

import { DEFAULT_LAYER_STYLE, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibrePlugin, GeoLibreToolbarMenuItem } from "../types";
import {
  basemapExtrusionLayerIds,
  BUNDLED_OBJECTS_MANIFEST,
  isBundledPreset,
  isDurableSource,
  loadPresets as loadUserPresets,
  parseBundledManifest,
  placementBounds,
  savePresets,
  upsertPreset,
  type ObjectPreset,
} from "./geoim3d-object-presets";
import { disposeLoadedObject, placeLoadedObject } from "./geoim3d-object-scene";
import { openThreeDTilesLayerPanel } from "./maplibre-3d-tiles";
import {
  acquireMercatorProjectionLock,
  releaseMercatorProjectionLock,
} from "./map-projection-utils";

export const GEOIM3D_OBJECTS_PLUGIN_ID = "geoim3d-objects";
const PANEL_ID = "geoim3d-objects-panel";
const FLOATING_PANEL_ID = `${PANEL_ID}-floating`;
const MENU_ID = "geoim3d-objects-menu";

/**
 * Key for the shared mercator lock.
 *
 * MapLibre's `globe` projection is adaptive: it draws as mercator zoomed in and
 * transitions to a sphere as you pull back. The splat renderer computes its
 * placement for mercator, so crossing that transition made an object that was
 * on the map moments earlier disappear — "it hides when I zoom out". Every
 * other 3D overlay here holds the same lock for the same reason; sharing it
 * means removing our objects does not yank the projection out from under one
 * of theirs.
 */
const PROJECTION_LOCK_KEY = "geoim3d-objects";

/* -------------------------------------------------------------------------- */
/* Formats                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What the loader treats a file as. It routes glTF/GLB through its model path
 * and everything else through its splat path, and the two want different
 * default rotations, so the distinction has to survive up here too.
 */
export type ObjectKind = "splat" | "model";

/** Extensions the splat loader accepts, by kind. */
const SPLAT_EXTENSIONS = ["splat", "ply", "spz", "ksplat", "sog"];
const MODEL_EXTENSIONS = ["glb", "gltf"];

/** Every extension this plugin offers, for a file dialog's filter. */
export const OBJECT_EXTENSIONS: readonly string[] = [...SPLAT_EXTENSIONS, ...MODEL_EXTENSIONS];

/**
 * Classifies a source by its file extension.
 *
 * Parsed off the **path**, not the whole string: a signed URL
 * (`scene.glb?X-Amz-Signature=…`) or a fragment would otherwise make the
 * extension unrecognizable, and the loader would refuse a file it can read.
 * Falls back to splitting on the raw string for a bare Windows path, which is
 * not a URL at all.
 *
 * @param source - A URL or a filesystem path.
 * @returns The kind, or null when the extension is not one this plugin loads.
 */
export function objectKind(source: string): ObjectKind | null {
  const path = source.split(/[?#]/, 1)[0] ?? "";
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (MODEL_EXTENSIONS.includes(extension)) return "model";
  if (SPLAT_EXTENSIONS.includes(extension)) return "splat";
  return null;
}

/**
 * The loader's own default orientation for a kind.
 *
 * Splats and glTF models are authored in different axis conventions, so a
 * single default lays one of them on its side. These mirror the defaults
 * `maplibre-gl-splat` documents for `defaultRotation` and
 * `defaultModelRotation`.
 *
 * @param kind - What the file is.
 * @returns Rotation in degrees, `[x, y, z]`.
 */
export function defaultRotation(kind: ObjectKind): [number, number, number] {
  return kind === "model" ? [90, 0, 0] : [-90, 90, 0];
}

/**
 * A readable name for a source, for the panel's list.
 *
 * @param source - A URL or a filesystem path.
 * @returns The final path segment, or the source itself when it has none.
 */
export function objectName(source: string): string {
  const path = source.split(/[?#]/, 1)[0] ?? source;
  const segment = path.split(/[/\\]/).pop();
  return segment && segment.length > 0 ? decodeURIComponent(segment) : source;
}

/* -------------------------------------------------------------------------- */
/* Host-provided shells                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Fetches a URL the webview may not request itself and returns a URL it can.
 * The desktop app reads the bytes natively and hands back a `blob:` URL.
 */
export type ObjectFetcher = (url: string) => Promise<string>;

/** A file the user picked, already addressable by the loader. */
export interface PickedObject {
  /** A URL the loader can read: an `asset:` URL on the desktop, `blob:` in a browser. */
  url: string;
  /** What to show in the list — the file's own name, not the opaque URL. */
  name: string;
  /** True when `url` is a `blob:` URL this plugin has to revoke. */
  revocable: boolean;
  /**
   * The absolute path behind `url`, where there is one. Recorded so a preset
   * can reopen the file in a later session; a browser pick has none, which is
   * why those objects cannot be saved.
   */
  path?: string;
}

/**
 * How the host reports a 3D Tiles layer's streaming progress.
 *
 * The counts come from the Cesium sync, which lives in `@geolibre/map` —
 * importing that package here would pull MapLibre's stylesheet into this
 * module's graph, which the Node test runner cannot load. Injected instead, the
 * way the fetcher and the view bridge are.
 */
export interface TilesetLoadingSource {
  /** Outstanding tile requests and processing for a layer, or null when idle. */
  progressOf: (layerId: string) => { pending: number; processing: number } | null;
  /** Notifies on every change. */
  subscribe: (listener: () => void) => () => void;
}

let tilesetLoadingSource: TilesetLoadingSource | null = null;

/**
 * Installs the progress source, or clears it.
 *
 * @param source - The host's reporter, or null.
 */
export function setTilesetLoadingSource(source: TilesetLoadingSource | null): void {
  tilesetLoadingSource = source;
}

/** Reopens a file a preset recorded by path. Null when it can no longer be read. */
export type LocalObjectResolver = (path: string) => Promise<PickedObject | null>;

/** Opens a file dialog and resolves what the user chose (empty when cancelled). */
export type LocalObjectPicker = () => Promise<PickedObject[]>;

/**
 * How the host reports and changes which renderer the primary map is showing.
 *
 * Objects are drawn by `maplibre-gl-splat`, a MapLibre control, so they land in
 * the 2D map. A host that can show a globe instead hides that map — and an
 * object loaded from there is loaded correctly and completely invisible, which
 * reads as "the file did not load".
 */
export interface PrimaryViewBridge {
  /** True when the 2D map is hidden behind a globe. */
  isGlobeActive: () => boolean;
  /** Notifies on every change, so the menu can follow the tab. */
  subscribe: (listener: () => void) => () => void;
}

let objectFetcher: ObjectFetcher | null = null;
let localObjectPicker: LocalObjectPicker | null = null;
let localObjectResolver: LocalObjectResolver | null = null;
let primaryViewBridge: PrimaryViewBridge | null = null;

/**
 * Registers (or clears) the host's primary-view bridge.
 *
 * @param bridge - The bridge, or null to unregister.
 */
export function setPrimaryViewBridge(bridge: PrimaryViewBridge | null): void {
  unsubscribePrimaryView?.();
  primaryViewBridge = bridge;
  // The menu is offered only where the objects can be seen, so it has to be
  // rebuilt whenever the view changes.
  unsubscribePrimaryView =
    bridge?.subscribe(() => {
      if (state.app) buildToolbarMenu(state.app);
      rerenderPanel();
    }) ?? null;
  if (state.app) buildToolbarMenu(state.app);
}

let unsubscribePrimaryView: (() => void) | null = null;

/**
 * Registers (or clears) the native fetcher used for plain-HTTP URLs.
 *
 * @param fetcher - The fetcher, or null to unregister.
 */
export function setObjectFetcher(fetcher: ObjectFetcher | null): void {
  objectFetcher = fetcher;
  rerenderPanel();
}

/**
 * Registers (or clears) the local file picker.
 *
 * @param picker - The picker, or null to unregister.
 */
export function setLocalObjectPicker(picker: LocalObjectPicker | null): void {
  localObjectPicker = picker;
  rerenderPanel();
}

/**
 * Registers (or clears) the resolver that reopens a preset's local file.
 *
 * @param resolver - The resolver, or null to unregister.
 */
export function setLocalObjectResolver(resolver: LocalObjectResolver | null): void {
  localObjectResolver = resolver;
  rerenderPanel();
}

/**
 * Whether a source has to go through the native fetcher to be loadable.
 *
 * Only *cross-origin* plain HTTP does. `https:` streams straight from the
 * webview, `blob:`/`asset:`/`file:` are already local, and the app's own origin
 * is reachable by definition — the CSP's `'self'` covers it and no
 * mixed-content rule applies to a page fetching from itself.
 *
 * The same-origin case is not a nicety: an object shipped in `public/objects/`
 * is served from the app, which is plain `http://localhost` in development.
 * Treating that as unreachable sent it to a native fetcher the browser build
 * does not have, and the sample refused to load with no error on the map.
 *
 * @param source - The URL to load.
 * @param origin - The app's own origin. Defaults to the page's; pass one in a
 *   test, where there is no `location`.
 * @returns True when the webview cannot request it directly.
 */
export function needsNativeFetch(source: string, origin?: string): boolean {
  if (!/^http:\/\//i.test(source)) return false;
  const self = origin ?? (typeof location === "undefined" ? "" : location.origin);
  if (!self) return true;
  try {
    return new URL(source).origin.toLowerCase() !== self.toLowerCase();
  } catch {
    return true;
  }
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * User-facing strings. This package is framework-agnostic and cannot call
 * react-i18next's `t()`, so the host pushes translations through
 * {@link setGeoim3dObjectLabels}, as the VWorld and KMA plugins do. Defaults
 * are English.
 */
export interface Geoim3dObjectLabels {
  title: string;
  getTitle?: () => string;
  menuLabel: string;
  openPanel: string;
  openPanelFloating: string;
  addFromUrl: string;
  addFromFile: string;
  threeDTiles: string;
  urlPlaceholder: string;
  load: string;
  loading: string;
  browse: string;
  loaded: string;
  empty: string;
  longitude: string;
  latitude: string;
  altitude: string;
  scale: string;
  rotation: string;
  tilesetBadge: string;
  tilesetLoading: string;
  tilesetHint: string;
  apply: string;
  remove: string;
  hideBasemapBuildings: string;
  savePreset: string;
  presets: string;
  presetsEmpty: string;
  deletePreset: string;
  errorUnsupported: string;
  errorHttpUnavailable: string;
  errorPickerUnavailable: string;
  errorLoadFailed: string;
  errorRendererUnavailable: string;
  /** Shown when the globe is up and the 2D map could not be brought back. */
  errorGlobeActive: string;
  errorEmptyFile: string;
  errorTooLarge: string;
  errorPresetNotSavable: string;
  errorPresetUnavailable: string;
  errorPresetMissing: string;
}

let labels: Geoim3dObjectLabels = {
  title: "3D objects",
  menuLabel: "3D objects",
  openPanel: "Object upload…",
  openPanelFloating: "Object upload (detached)…",
  addFromUrl: "Add from URL…",
  addFromFile: "Add from a file…",
  threeDTiles: "3D Tiles…",
  urlPlaceholder: "https:// or http:// address of a .splat, .ply, .sog or .glb",
  load: "Load",
  loading: "Loading…",
  browse: "Choose a file…",
  loaded: "Loaded objects",
  empty: "Nothing loaded yet.",
  longitude: "Longitude",
  latitude: "Latitude",
  altitude: "Altitude (m)",
  scale: "Scale",
  rotation: "Rotation (°)",
  tilesetBadge: "3D Tiles",
  tilesetLoading: "Loading tiles",
  tilesetHint: "These values place the 3D Tiles version, not the splat.",
  apply: "Apply",
  remove: "Remove",
  hideBasemapBuildings: "Hide the basemap’s 3D buildings",
  savePreset: "Save as a sample",
  presets: "Saved samples",
  presetsEmpty: "Nothing saved yet.",
  deletePreset: "Delete",
  errorUnsupported:
    "Not a format this plugin loads (.splat, .ply, .spz, .ksplat, .sog, .glb, .gltf).",
  errorHttpUnavailable:
    "Plain http:// addresses can only be read by the desktop app. Use https, or a local file.",
  errorPickerUnavailable: "Choosing a file is not available in this build.",
  errorLoadFailed: "The object could not be loaded.",
  errorRendererUnavailable: "The 3D object renderer could not be loaded.",
  errorGlobeActive:
    "3D objects are drawn on the 2D map. Switch the view above the map from Cesium to OSM to see them.",
  errorPresetNotSavable:
    "A file chosen in a browser cannot be saved as a sample — its address only lives as long as this page. Use the desktop app, or load the object from a URL.",
  errorPresetUnavailable: "Reopening a saved local file is only available in the desktop app.",
  errorPresetMissing: "The saved file could not be opened. It may have been moved or deleted.",
  errorEmptyFile: "That file is empty.",
  errorTooLarge:
    "That file is too large to open in the app. Reduce the splat count or export it as .sog, which is far smaller.",
};

/**
 * Replaces some or all of the user-facing strings.
 *
 * @param next - The strings to override.
 */
export function setGeoim3dObjectLabels(next: Partial<Geoim3dObjectLabels>): void {
  labels = { ...labels, ...next };
  rerenderPanel();
  // The menu copies its labels when it is built, so a language change has to
  // rebuild it or it sits in the old one.
  if (state.app) buildToolbarMenu(state.app);
}

/* -------------------------------------------------------------------------- */
/* State                                                                        */
/* -------------------------------------------------------------------------- */

/** Where an object sits and how it is oriented. */
export interface ObjectTransform {
  longitude: number;
  latitude: number;
  altitude: number;
  scale: number;
  rotation: [number, number, number];
}

interface LoadedObject {
  /**
   * This object's id in the layer list. Stable for the object's whole life:
   * the loader mints a new id on every reload, and letting that reach the store
   * would make an Apply look like a delete and a re-add — the layer would jump
   * to the bottom of the list each time a value changed.
   */
  layerId: string;
  /** The loader's own id, which changes on every reload. */
  loaderId: string;
  name: string;
  kind: ObjectKind;
  /** The paired 3D Tiles layer, when the object came from a preset that has one. */
  tilesetLayerId?: string;
  /** Set when there is no splat behind this entry — a tileset added on its own. */
  tilesetOnly?: boolean;
  /**
   * The tileset's own placement, edited by the same panel fields while the
   * globe is up. Separate from `transform` because the two assets do not share
   * an origin, a unit or a height datum.
   */
  tilesetTransform?: ObjectTransform;
  /** What the loader is actually reading: the original URL, or a blob of it. */
  readableUrl: string;
  /** The URL or path the user gave, kept for the layer record and for reloads. */
  source: string;
  /** True when `readableUrl` must be revoked once the object is gone. */
  revocable: boolean;
  transform: ObjectTransform;
}

interface PanelState {
  app: GeoLibreAppAPI | null;
  container: HTMLElement | null;
  /** The `maplibre-gl-splat` control, which does the actual rendering. */
  control: SplatControlLike | null;
  /** Drives visibility/opacity from the layer list. Null until the first load. */
  adapter: SplatAdapterLike | null;
  objects: LoadedObject[];
  urlDraft: string;
  busy: boolean;
  /** What is loading right now, for the progress line. */
  busyName: string;
  /** Whether the basemap's own 3D buildings are hidden. */
  hideBasemapBuildings: boolean;
  status: string;
}

const state: PanelState = {
  app: null,
  container: null,
  control: null,
  adapter: null,
  objects: [],
  urlDraft: "",
  busy: false,
  busyName: "",
  hideBasemapBuildings: false,
  status: "",
};

/**
 * The part of `maplibre-gl-splat`'s control this plugin drives. Typed
 * structurally because the module is imported dynamically — pulling its types
 * in statically would put the whole renderer in the boot graph.
 */
interface SplatControlLike {
  load(
    url: string,
    options?: {
      longitude?: number;
      latitude?: number;
      altitude?: number;
      rotation?: [number, number, number];
      scale?: number;
    },
  ): Promise<string>;
  removeSplat(layerId: string): void;
  removeModel(layerId: string): void;
  collapse(): void;
}

/** The adapter's visibility/opacity surface, keyed by the loader's own ids. */
interface SplatAdapterLike {
  setVisibility(layerId: string, visible: boolean): void;
  setOpacity(layerId: string, opacity: number): void;
  destroy(): void;
}

/**
 * Builds the layer-list record for an object.
 *
 * `gaussian-splat` already exists as a layer type and is what the Components
 * plugin records for the same renderer, so the layer panel, the legend and the
 * swatches all know it. `sourceKind` is ours so the subscription below can tell
 * this plugin's layers from that one's.
 *
 * @param object - The loaded object.
 * @returns The record to put in the store.
 */
function createObjectStoreLayer(object: LoadedObject): GeoLibreLayer {
  return {
    id: object.layerId,
    name: object.name,
    type: "gaussian-splat",
    source: {
      assetType: object.kind,
      // The layer panel's zoom button fits a layer to its bounds and does
      // nothing at all without them.
      bounds: placementBounds(object.transform.longitude, object.transform.latitude),
      sourceId: object.layerId,
      type: "gaussian-splat",
      // The original source, not the blob: a blob URL is dead on the next run,
      // so recording it would only mislead anyone reading the project file.
      url: object.source,
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      assetType: object.kind,
      customLayerType: "gaussian-splat",
      externalNativeLayer: true,
      identifiable: false,
      sourceId: object.layerId,
      sourceKind: GEOIM3D_OBJECT_SOURCE_KIND,
    },
    sourcePath: object.source,
  };
}

/** Marks the layers this plugin owns, so the store watcher ignores everyone else's. */
const GEOIM3D_OBJECT_SOURCE_KIND = "geoim3d-object";

/**
 * Marks a preset's 3D Tiles companion.
 *
 * Deliberately not {@link GEOIM3D_OBJECT_SOURCE_KIND}: this layer has no loaded
 * object behind it, so the store watcher — which maps a layer back to a splat
 * in the renderer — must skip it.
 */
const GEOIM3D_TILESET_SOURCE_KIND = "geoim3d-object-tileset";

/**
 * Whether opening a preset also puts its 3D Tiles version on the map.
 * Was off while the globe had no reachable tab; back on with `primaryRenderer`.
 */
const TILESET_COMPANION_ENABLED = true;

/**
 * The layer record for a preset's 3D Tiles companion.
 *
 * Only what the globe reads: `type` and `source.url` are what
 * `cesium-layer-sync` needs to build a tileset. It carries none of the 3D Tiles
 * *plugin's* metadata on purpose, so that plugin's own control does not adopt
 * it — the 2D map already shows this site as a splat, and two renderings of one
 * building is worse than one.
 *
 * @param preset - The preset that names a tileset.
 * @returns The layer to add.
 */
/**
 * The placement a tileset takes from the panel's transform, field for field.
 *
 * Absolute, not relative: what the panel shows is what the globe applies. The
 * splat renderer reads the same fields in its own units, so a site that has
 * both needs its numbers chosen for one of them — see the panel's altitude and
 * scale, which mean metres and a direct multiplier here.
 *
 * @param transform - The panel's current values.
 * @returns The placement to store on the tileset layer.
 */
function tilesetPlacementFor(transform: ObjectTransform): Record<string, unknown> {
  return {
    longitude: transform.longitude,
    latitude: transform.latitude,
    height: transform.altitude,
    rotation: [...transform.rotation],
    scale: transform.scale,
  };
}

/**
 * The tileset's starting placement.
 *
 * The manifest's own value when it has one. Otherwise the splat's coordinates
 * with the numbers that mean "as built" to a tileset — scale 1 and a height at
 * the ground rather than the splat's eyeballed altitude — which is a place to
 * start editing from, not a guess at the right answer.
 *
 * @param preset - The preset being opened.
 * @returns The transform the tileset layer starts at.
 */
function initialTilesetTransform(preset: ObjectPreset): ObjectTransform {
  return (
    preset.tilesetTransform ?? {
      longitude: preset.transform.longitude,
      latitude: preset.transform.latitude,
      altitude: 0,
      scale: 1,
      rotation: [0, preset.transform.rotation[1], 0],
    }
  );
}

/**
 * Writes a placement onto the object's tileset layer.
 *
 * The Cesium sync turns this into a `modelMatrix` on its next pass, so the
 * globe follows without reloading a tile.
 *
 * @param object - The object whose tileset is being moved.
 * @param transform - The values to apply.
 */
function applyTilesetTransform(object: LoadedObject, transform: ObjectTransform): void {
  const { tilesetLayerId } = object;
  if (!tilesetLayerId) return;
  const store = useAppStore.getState();
  const layer = store.layers.find((entry) => entry.id === tilesetLayerId);
  if (!layer) return;
  store.updateLayer(tilesetLayerId, {
    source: {
      ...layer.source,
      // The zoom button reads these, so a moved tileset needs its box moved too.
      bounds: placementBounds(transform.longitude, transform.latitude),
      placement: tilesetPlacementFor(transform),
    },
  });
}

function createTilesetStoreLayer(
  id: string,
  name: string,
  url: string,
  transform: ObjectTransform,
): GeoLibreLayer {
  return {
    id,
    name,
    type: "3d-tiles",
    source: {
      bounds: placementBounds(transform.longitude, transform.latitude),
      // Follows the panel, like the splat: a tileset built from a scan that was
      // never georeferenced sits wherever the tiler's default origin was.
      placement: tilesetPlacementFor(transform),
      sourceId: id,
      type: "3d-tiles",
      url,
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: "3d-tiles",
      externalNativeLayer: true,
      identifiable: false,
      sourceId: id,
      sourceKind: GEOIM3D_TILESET_SOURCE_KIND,
    },
    sourcePath: url,
  };
}

/**
 * Adds a preset's tileset to the layer list once.
 *
 * @param preset - The preset being opened.
 * @returns True when the preset has a tileset, whether or not this call added it.
 */
function ensureTilesetLayer(preset: ObjectPreset): boolean {
  if (!preset.tileset) return false;
  const store = useAppStore.getState();
  const id = `${preset.id}-tileset`;
  if (!store.layers.some((layer) => layer.id === id)) {
    store.addLayer(
      createTilesetStoreLayer(id, preset.name, preset.tileset, initialTilesetTransform(preset)),
    );
  }
  watchTilesetLoading();
  return true;
}

/** Whether a source names a 3D Tiles tileset rather than a splat or a model. */
export function isTilesetSource(source: string): boolean {
  return /(^|\/)[^/?#]*\.json(?:[?#]|$)/i.test(source.split(/[?#]/, 1)[0] ?? source);
}

/**
 * Puts a tileset on the map from its `tileset.json`, and lists it here.
 *
 * The 3D Tiles panel can already add one, but the layer it makes belongs to
 * that plugin: it rewrites the layer's `source` from its own state on every
 * sync, so a placement written there is wiped on the next pass. A tileset added
 * here is ours, and so gets the same five fields every other object has.
 *
 * Placed at the map's centre to begin with — a tileset that carries its own
 * georeferencing ignores where it is told to sit only in the sense that the
 * user will not need to move it far.
 *
 * @param app - The host API.
 * @param url - The tileset's URL.
 * @param name - What to call it.
 */
function loadTileset(app: GeoLibreAppAPI, url: string, name: string): void {
  const center = app.getMap?.()?.getCenter();
  const transform: ObjectTransform = {
    longitude: center?.lng ?? 0,
    latitude: center?.lat ?? 0,
    altitude: 0,
    scale: 1,
    rotation: [0, 0, 0],
  };
  const layerId = `${GEOIM3D_TILESET_SOURCE_KIND}-${nextObjectSequence++}`;
  useAppStore.getState().addLayer(createTilesetStoreLayer(layerId, name, url, transform));
  watchTilesetLoading();
  state.objects.push({
    layerId,
    loaderId: "",
    name,
    kind: "splat",
    source: url,
    readableUrl: url,
    revocable: false,
    transform,
    tilesetLayerId: layerId,
    tilesetTransform: transform,
    tilesetOnly: true,
  });
  state.urlDraft = "";
  setStatus("");
  rerenderPanel();
}

/**
 * The one object the panel edits.
 *
 * Listing every loaded object made the panel a wall of near-identical number
 * blocks, and the fields being edited were rarely the ones on screen. The
 * layer list is already the place things are picked, so this follows its
 * selection — by either of the object's layers, since a preset owns two — and
 * falls back to the most recent load when nothing relevant is selected.
 *
 * @returns The object to render, or null when none is loaded.
 */
function panelObject(): LoadedObject | null {
  const { selectedLayerId } = useAppStore.getState();
  const selected = selectedLayerId
    ? state.objects.find(
        (object) => object.layerId === selectedLayerId || object.tilesetLayerId === selectedLayerId,
      )
    : undefined;
  return selected ?? state.objects.at(-1) ?? null;
}

/** True when the panel's fields are pointed at the tileset rather than the splat. */
function isEditingTileset(object: LoadedObject): boolean {
  if (object.tilesetOnly) return true;
  return Boolean(object.tilesetLayerId) && Boolean(primaryViewBridge?.isGlobeActive());
}

function isObjectLayer(layer: GeoLibreLayer): boolean {
  return layer.metadata.sourceKind === GEOIM3D_OBJECT_SOURCE_KIND;
}

let unsubscribeStore: (() => void) | null = null;
let unsubscribeTilesetLoading: (() => void) | null = null;
let detachPitchSync: (() => void) | null = null;

/** Counter behind the stable layer ids. Uniqueness within a session is enough. */
let nextObjectSequence = 1;

/** Samples from {@link BUNDLED_OBJECTS_MANIFEST}. Empty until read, or for good if unreachable. */
let bundledPresets: ObjectPreset[] = [];

/**
 * Reads the shipped object manifest.
 *
 * @param app - The host API, for rebuilding the menu once the list is known.
 */
async function loadBundledPresets(app: GeoLibreAppAPI): Promise<void> {
  const base = typeof document === "undefined" ? "" : document.baseURI;
  if (!base) return;
  try {
    const manifestUrl = new URL(BUNDLED_OBJECTS_MANIFEST, base).href;
    bundledPresets = parseBundledManifest(await fetchManifestText(manifestUrl), base);
  } catch {
    // No manifest is the normal case, not a fault worth reporting.
    return;
  }
  if (bundledPresets.length === 0) return;
  buildToolbarMenu(app);
  rerenderPanel();
}

/**
 * Every sample offered, shipped ones first.
 *
 * The two render paths — the toolbar submenu and the panel list — must both
 * call this, never `loadUserPresets` directly, or one of them silently omits
 * the objects that ship with the app. That is exactly what happened once: the
 * panel listed them and the menu said there were none.
 *
 * @returns The bundled presets followed by the user's own.
 */
function allPresets(): ObjectPreset[] {
  return [...bundledPresets, ...loadUserPresets()];
}

/**
 * The one MapLibre layer `maplibre-gl-splat` renders every object into.
 *
 * Fixed id, one scene for all of them (`_onMapRender` adds it as
 * `map_scene_layer` when missing).
 */
const SPLAT_SCENE_LAYER_ID = "map_scene_layer";

/**
 * Raises the splat scene above the rest of the map.
 *
 * The scene is a custom layer added when the first object renders, so anything
 * added afterwards — a satellite basemap, most obviously — lands on top of it
 * in the style and paints straight over the objects.
 *
 * ponytail: this keeps objects above *everything*, rather than following the
 * layer panel's order. The panel cannot reorder them anyway — the store record
 * is a listing, not a native layer — so the alternative today is not "ordered"
 * but "buried". Give the record real `nativeLayerIds` and let layer-sync place
 * it if per-layer ordering is ever wanted.
 */
function raiseSplatScene(): void {
  const map = state.app?.getMap?.() as
    | { getLayer: (id: string) => unknown; moveLayer: (id: string) => void }
    | null
    | undefined;
  if (!map?.getLayer(SPLAT_SCENE_LAYER_ID)) return;
  map.moveLayer(SPLAT_SCENE_LAYER_ID);
}

/**
 * Shows or hides the basemap's own 3D buildings.
 *
 * Re-applied on `styledata` as well as on the toggle: switching the basemap
 * loads a fresh style, and a style knows nothing about a visibility set on the
 * one before it — the buildings would come back on the next basemap change
 * with the checkbox still ticked.
 */
function applyBasemapBuildingVisibility(): void {
  const map = state.app?.getMap?.() as
    | {
        getStyle: () => { layers?: Array<{ id: string; type: string }> } | undefined;
        setLayoutProperty: (id: string, name: string, value: string) => void;
      }
    | null
    | undefined;
  if (!map) return;

  // `metadata` is a loose record, so the native ids arrive untyped.
  const owned = new Set<string>();
  for (const layer of useAppStore.getState().layers) {
    const ids = layer.metadata.nativeLayerIds;
    if (Array.isArray(ids)) for (const id of ids) owned.add(String(id));
  }

  const visibility = state.hideBasemapBuildings ? "none" : "visible";
  for (const id of basemapExtrusionLayerIds(map.getStyle()?.layers ?? [], owned)) {
    try {
      map.setLayoutProperty(id, "visibility", visibility);
    } catch {
      // A style can be swapped mid-iteration; the styledata handler re-runs.
    }
  }
}

let detachStyleWatch: (() => void) | null = null;

/**
 * Sets an object's opacity, whichever kind it is.
 *
 * The adapter shipped with the splat library only handles a mesh that has a
 * `material` — which a glTF model does and a splat does not. `SplatMesh` is not
 * a `THREE.Mesh`; it carries its own `opacity` field and no material at all, so
 * the adapter looked it up, found nothing, and returned. The layer panel's
 * slider moved and the map never changed.
 *
 * ponytail: reaches into the control's private `_splatLayers` because nothing
 * public exposes a loaded splat's mesh (`getSplatInfo` returns only its URL and
 * position). Drop this half the moment the library gains a real setter — it is
 * checked defensively so a rename degrades to the old no-op rather than a
 * crash.
 *
 * @param object - The object to fade.
 * @param opacity - 0 to 1.
 */
function applyObjectOpacity(object: LoadedObject, opacity: number): void {
  state.adapter?.setOpacity(object.loaderId, opacity);

  const splatLayers = (
    state.control as unknown as {
      _splatLayers?: Map<string, { mesh?: { opacity?: number } }>;
    } | null
  )?._splatLayers;
  const mesh = splatLayers?.get(object.loaderId)?.mesh;
  if (mesh && typeof mesh.opacity === "number") {
    mesh.opacity = opacity;
    // The scene only redraws when the map does, so a change made while the map
    // is still would not appear until the next pan.
    state.app?.getMap?.()?.triggerRepaint();
  }
}

/**
 * Whether layers were added or removed, as opposed to merely changed.
 *
 * Zustand hands back a new array for any mutation, so identity says nothing
 * about which kind it was.
 *
 * @param before - The previous layers.
 * @param after - The current layers.
 * @returns True when the set of ids differs.
 */
function layerIdsChanged(
  before: ReadonlyArray<{ id: string }>,
  after: ReadonlyArray<{ id: string }>,
): boolean {
  if (before.length !== after.length) return true;
  return before.some((layer, index) => layer.id !== after[index].id);
}

/**
 * Follows the layer list: a layer deleted there removes the object, and the
 * eye/opacity controls drive the renderer.
 *
 * Without this the object would be listed but inert — the panel's own Remove
 * would work and the layer panel's would not, which is worse than not listing
 * it at all.
 */
/** Repaints the panel as tiles arrive, so the bar tracks the stream. */
function watchTilesetLoading(): void {
  if (!tilesetLoadingSource) return;
  unsubscribeTilesetLoading ??= tilesetLoadingSource.subscribe(() => rerenderPanel());
}

function watchLayerList(): void {
  unsubscribeStore ??= useAppStore.subscribe((store, previous) => {
    // Only when a layer was added or removed — not on every property change.
    // `moveLayer` re-orders the style, which for a custom 3D layer holding tens
    // of millions of splats is expensive, and the opacity slider fires on every
    // tick of a drag: the map froze the moment it was touched. Nothing that
    // merely changes a layer's opacity or visibility can bury the scene.
    if (state.objects.length > 0 && layerIdsChanged(previous.layers, store.layers)) {
      raiseSplatScene();
    }

    // Which object the panel edits follows the layer list's selection.
    if (store.selectedLayerId !== previous.selectedLayerId) rerenderPanel();

    const currentById = new Map(store.layers.map((layer) => [layer.id, layer]));
    for (const before of previous.layers) {
      if (!isObjectLayer(before)) continue;
      const object = state.objects.find((entry) => entry.layerId === before.id);
      if (!object) continue;

      const after = currentById.get(before.id);
      if (!after) {
        removeObject(object, { alreadyRemovedFromStore: true });
        continue;
      }
      // Driven by the loader's own id, which the adapter keys on and which
      // changes every time a transform is applied.
      if (after.visible !== before.visible) {
        state.adapter?.setVisibility(object.loaderId, after.visible);
      }
      if (after.opacity !== before.opacity) {
        applyObjectOpacity(object, after.opacity);
      }
    }
  });
}

function setStatus(message: string): void {
  state.status = message;
}

function rerenderPanel(): void {
  if (state.container) renderPanel(state.container);
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Re-syncs the splat camera's projection when the pitch changes.
 *
 * `maplibre-gl-splat` rebuilds its projection matrix — which carries the far
 * plane — only on the map's `resize` event; a `move` updates the view matrix
 * alone. MapLibre's `farZ` grows with pitch, so tilting the map leaves the
 * splat camera on the far plane it had when flat, and everything past it is
 * clipped: the scene looks sliced off at the far edge.
 *
 * Re-emitting `resize` is the only public way to make the library redo that
 * work. Fired on `moveend` and only when the pitch actually moved, so a pan or
 * a zoom does not put every other `resize` listener in the app to work.
 *
 * ponytail: the projection stays stale *during* a pitch drag and corrects on
 * release. Move this to the continuous `pitch` event if that lag is visible
 * enough to matter — at the cost of firing `resize` on every frame of a drag.
 *
 * @param map - The MapLibre map the control draws into.
 * @returns A function that detaches the listener.
 */
function syncSplatCameraOnPitch(map: {
  getPitch: () => number;
  on: (event: string, handler: () => void) => void;
  off: (event: string, handler: () => void) => void;
  fire: (event: string) => void;
}): () => void {
  let lastPitch = map.getPitch();
  const onMoveEnd = () => {
    const pitch = map.getPitch();
    if (Math.abs(pitch - lastPitch) < 0.5) return;
    lastPitch = pitch;
    map.fire("resize");
  };
  map.on("moveend", onMoveEnd);
  return () => map.off("moveend", onMoveEnd);
}

/**
 * Where an object goes when nothing says otherwise: the middle of the view.
 *
 * @param app - The host API.
 * @param kind - What the file is, for the loader's default orientation.
 * @returns A placement to start from.
 */
function defaultObjectTransform(app: GeoLibreAppAPI, kind: ObjectKind): ObjectTransform {
  const center = app.getMap?.()?.getCenter();
  return {
    longitude: center?.lng ?? 0,
    latitude: center?.lat ?? 0,
    altitude: 0,
    scale: 1,
    rotation: defaultRotation(kind),
  };
}

/**
 * Waits until the map style has finished loading.
 *
 * `@dvt3d/maplibre-three-plugin` adds its scene layer straight from the map's
 * render handler with no check of its own — `getLayer(id) || addLayer(...)` —
 * and MapLibre throws `Style is not done loading` when that lands while a style
 * is still coming up. The throw leaves the scene layer unadded, so an object
 * loaded during a basemap change draws nothing at all.
 *
 * @param map - The MapLibre map, if there is one.
 * @returns A promise that settles once the style is up.
 */
function whenStyleReady(map: unknown): Promise<void> {
  const target = map as
    | { isStyleLoaded?: () => boolean; once?: (event: string, handler: () => void) => void }
    | null
    | undefined;
  if (!target?.once || target.isStyleLoaded?.() !== false) return Promise.resolve();
  return new Promise((resolve) => target.once?.("idle", () => resolve()));
}

/**
 * Resolves the renderer, loading it on first use.
 *
 * Imported dynamically and added collapsed: this panel is the interface, and
 * the control is here only to draw. A failure is reported rather than thrown,
 * so a missing chunk does not take the plugin down with it.
 *
 * @param app - The host API.
 * @returns The control, or null when it could not be loaded.
 */
async function ensureControl(app: GeoLibreAppAPI): Promise<SplatControlLike | null> {
  if (state.control) return state.control;
  try {
    const module = (await import("maplibre-gl-splat")) as unknown as {
      GaussianSplatControl: new (options?: Record<string, unknown>) => SplatControlLike;
      GaussianSplatLayerAdapter: new (control: SplatControlLike) => SplatAdapterLike;
    };
    const control = new module.GaussianSplatControl();
    app.addMapControl(control as never, "top-left");
    control.collapse();
    state.control = control;
    // The control itself has no visibility/opacity; the adapter the library
    // ships for the layer control does, and that is what the layer list needs.
    state.adapter = new module.GaussianSplatLayerAdapter(control);
    const map = app.getMap?.();
    if (map) detachPitchSync = syncSplatCameraOnPitch(map as never);
    watchLayerList();
    return control;
  } catch (error) {
    console.warn("geoim3d-objects: the splat renderer failed to load", error);
    return null;
  }
}

/**
 * Turns a source into something the webview is allowed to read.
 *
 * @param source - The URL the user gave.
 * @returns The readable URL and whether it has to be revoked afterwards.
 * @throws When plain HTTP is used without a native fetcher to read it.
 */
async function resolveReadableUrl(source: string): Promise<{ url: string; revocable: boolean }> {
  if (!needsNativeFetch(source)) return { url: source, revocable: false };
  // The desktop app reads it natively, which also keeps the webview's CSP out
  // of it.
  if (objectFetcher) return { url: await objectFetcher(source), revocable: true };
  // No fetcher: a browser. It can still request plain http itself as long as
  // the page is not https — mixed content is what blocks this, and a page
  // served over http has no such rule. That covers an internal deployment and
  // the dev server, where refusing outright meant a file server full of
  // objects could not be used at all.
  if (typeof location !== "undefined" && location.protocol !== "https:") {
    return { url: source, revocable: false };
  }
  throw new Error("http-unavailable");
}

/** Fetches the manifest as text, via {@link resolveReadableUrl} for cross-origin hosts. */
async function fetchManifestText(url: string): Promise<string> {
  const readable = await resolveReadableUrl(url);
  try {
    const response = await fetch(readable.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    if (readable.revocable) URL.revokeObjectURL(readable.url);
  }
}

/**
 * Loads an object and adds it to the panel's list.
 *
 * @param app - The host API.
 * @param source - The URL or path the user gave.
 * @param name - What to call it in the list.
 * @param prepared - An already-readable URL (a picked local file), if any.
 */
/**
 * Waits for a just-loaded splat to finish streaming.
 *
 * `maplibre-gl-splat`'s `loadSplat` returns the moment the `SplatMesh` is
 * constructed; the mesh then downloads and unpacks for several seconds with
 * nothing on screen — the same "reads as nothing happening" the globe's tileset
 * bar solves. (`loadModel` already awaits its GLTF fetch, so models are fine.)
 * The control has no public handle to the mesh, so reach it through the same
 * private registry the 3D Tiles restore reaches into. Best-effort: a build that
 * renames `_splatLayers`, or a mesh with no `initialized` promise, just
 * resolves, and a stream that fails resolves too — the empty scene reads as the
 * failure, as it did before.
 */
async function whenObjectRendered(control: SplatControlLike, loaderId: string): Promise<void> {
  const registry = (
    control as unknown as {
      _splatLayers?: Map<string, { mesh?: { initialized?: Promise<unknown> } }>;
    }
  )._splatLayers;
  const ready = registry?.get(loaderId)?.mesh?.initialized;
  if (ready) await ready.catch(() => {});
}

async function loadObject(
  app: GeoLibreAppAPI,
  source: string,
  name: string,
  prepared?: { url: string; revocable: boolean },
  placement?: ObjectTransform,
  tilesetLayerId?: string,
  tilesetTransform?: ObjectTransform,
): Promise<void> {
  const kind = objectKind(source);
  if (!kind) {
    setStatus(labels.errorUnsupported);
    rerenderPanel();
    return;
  }

  state.busy = true;
  state.busyName = name;
  setStatus("");
  rerenderPanel();

  let readable: { url: string; revocable: boolean } | null = null;
  try {
    const control = await ensureControl(app);
    if (!control) throw new Error("renderer-unavailable");

    readable = prepared ?? (await resolveReadableUrl(source));

    // The renderer draws into the 2D map, which a globe view hides, and the
    // centre read below would be that hidden map's rather than the view on
    // screen. The menu is withdrawn while the globe is up, but the panel can
    // still be open from before the switch, so refuse here too.
    // A splat loaded while the globe is up is loaded correctly and completely
    // invisible, which reads as "the file did not load" — unless a tileset of
    // the same site is going up beside it, in which case something is on screen
    // and the splat is simply waiting for a switch back to the 2D map.
    if (!tilesetLayerId && primaryViewBridge?.isGlobeActive()) throw new Error("globe-active");

    await whenStyleReady(app.getMap?.());

    // Start where the user is looking. Without this an object with no
    // coordinates of its own lands at (0, 0), in the Atlantic.
    const center = app.getMap?.()?.getCenter();
    const transform: ObjectTransform = placement ?? {
      longitude: center?.lng ?? 0,
      latitude: center?.lat ?? 0,
      altitude: 0,
      scale: 1,
      rotation: defaultRotation(kind),
    };
    const loaderId = await control.load(readable.url, {
      longitude: transform.longitude,
      latitude: transform.latitude,
      altitude: transform.altitude,
      rotation: transform.rotation,
      scale: transform.scale,
    });
    const object: LoadedObject = {
      layerId: `${GEOIM3D_OBJECT_SOURCE_KIND}-${nextObjectSequence++}`,
      loaderId,
      name,
      kind,
      source,
      readableUrl: readable.url,
      revocable: readable.revocable,
      transform,
      tilesetLayerId,
      tilesetTransform,
    };
    state.objects.push(object);
    acquireMercatorProjectionLock(PROJECTION_LOCK_KEY, app, app.getMap?.());
    // Go to what was just loaded, rather than leaving the camera on the other
    // side of the world — indistinguishable from a load that failed. (The
    // library's own `flyTo` option does fire here, contrary to an earlier note;
    // it was the projection switch below that cancelled it.)
    //
    // A jump, not a flight: the line above switches the projection, which ends
    // an animation in progress, so the camera never arrived. Flying three
    // seconds across the globe while a 68 MB splat renders is not worth
    // rescuing anyway.
    //
    // Not done when a transform is applied: that reloads too, and yanking the
    // camera on every edit would fight the user positioning it.
    app.getMap?.()?.jumpTo({
      center: [transform.longitude, transform.latitude],
      // The zoom the splat library uses for the same purpose; a site-scale
      // scan fills the view at roughly this level.
      zoom: 18,
    });
    // The scene layer is created on the first render after a load, so raise it
    // once that has happened rather than in this tick.
    app.getMap?.()?.once("idle", raiseSplatScene);
    useAppStore.getState().addLayer(createObjectStoreLayer(object));
    state.urlDraft = "";
    // The layer is listed above at once; hold `busy` (and its progress bar)
    // until the splat has actually streamed in, not just been queued.
    await whenObjectRendered(control, loaderId);
  } catch (error) {
    // A blob made for a load that then failed would otherwise be held until
    // the tab closes, and these are hundreds of megabytes.
    if (readable?.revocable) URL.revokeObjectURL(readable.url);
    // A preset whose splat could not be read still has its tileset on the map —
    // a browser refuses a plain-http splat, and the globe shows the tileset
    // anyway. Listing it keeps the placement fields reachable instead of
    // leaving a layer nothing can edit.
    if (tilesetLayerId && !state.objects.some((entry) => entry.layerId === tilesetLayerId)) {
      state.objects.push({
        layerId: tilesetLayerId,
        loaderId: "",
        name,
        kind,
        source,
        readableUrl: source,
        revocable: false,
        transform: placement ?? defaultObjectTransform(app, kind),
        tilesetLayerId,
        tilesetTransform: tilesetTransform ?? placement ?? defaultObjectTransform(app, kind),
        tilesetOnly: true,
      });
    }
    setStatus(loadErrorMessage(error));
  } finally {
    state.busy = false;
    state.busyName = "";
    rerenderPanel();
  }
}

/**
 * Maps a load failure to a message that says what to do about it.
 *
 * @param error - The thrown value.
 * @returns The message to show.
 */
function loadErrorMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : "";
  if (reason === "http-unavailable") return labels.errorHttpUnavailable;
  if (reason === "renderer-unavailable") return labels.errorRendererUnavailable;
  if (reason === "globe-active") return labels.errorGlobeActive;
  return labels.errorLoadFailed;
}

/**
 * Removes an object from the map, the panel and the layer list.
 *
 * Removal can start on either side — the panel's button or the layer list's —
 * so this is the one place that clears both, and the caller says which side it
 * came from to avoid removing a store layer that is already gone.
 *
 * @param object - The object to remove.
 * @param options - Set `alreadyRemovedFromStore` when the layer list started it.
 */
function removeObject(object: LoadedObject, options?: { alreadyRemovedFromStore?: boolean }): void {
  removeFromRenderer(object);
  if (object.revocable) URL.revokeObjectURL(object.readableUrl);
  state.objects = state.objects.filter((entry) => entry !== object);
  if (state.objects.length === 0 && state.app) {
    releaseMercatorProjectionLock(PROJECTION_LOCK_KEY, state.app);
  }
  if (!options?.alreadyRemovedFromStore) useAppStore.getState().removeLayer(object.layerId);
  // The tileset was added with the object and is listed under the same name, so
  // it goes with it. Left behind it became unreachable: the panel entry that
  // placed it is gone, so the layer sits in the list with nothing to edit it.
  if (object.tilesetLayerId) useAppStore.getState().removeLayer(object.tilesetLayerId);
  rerenderPanel();
}

function removeFromRenderer(object: LoadedObject): void {
  const control = state.control;
  // A tileset added on its own was never handed to the splat renderer, and its
  // empty loader id would remove whatever happens to answer to it.
  if (!control || object.tilesetOnly) return;
  // The library's remove detaches the group and disposes nothing, so the
  // buffers behind a 68 MB splat outlive it. Free them first.
  disposeLoadedObject(control, object.loaderId);
  if (object.kind === "model") control.removeModel(object.loaderId);
  else control.removeSplat(object.loaderId);
}

/**
 * Re-places an object with an edited transform.
 *
 * The control's public surface cannot move what it has loaded, so this used to
 * remove and load again on every Apply. That re-unpacked the whole file each
 * time and — since the library disposes nothing it drops — ended in
 * `RangeError: Array buffer allocation failed` in the SOG unpack worker after a
 * few dozen nudges, with the object silently gone. The object in the scene is
 * an ordinary three.js group, so the placement is written straight onto it.
 *
 * The reload is kept as the fallback for when the scene graph cannot be
 * reached (a rename upstream): the readable URL is reused rather than
 * re-fetched, which matters for an http object that would otherwise cross the
 * network on every nudge.
 *
 * @param object - The object being edited.
 * @param transform - The values from the form.
 */
async function applyTransform(object: LoadedObject, transform: ObjectTransform): Promise<void> {
  // On the globe the panel's fields are the tileset's, so an Apply moves that
  // and leaves the splat's own numbers alone. Nothing else here runs: the splat
  // is not on screen, and reloading it to place it would cost the file again.
  //
  // Checked before the renderer, not after: a tileset added on its own never
  // loaded the splat renderer, so a `state.control` guard above this returned
  // early and Apply did nothing at all.
  if (isEditingTileset(object)) {
    object.tilesetTransform = transform;
    applyTilesetTransform(object, transform);
    rerenderPanel();
    return;
  }

  const control = state.control;
  if (!control) return;

  state.busy = true;
  setStatus("");
  rerenderPanel();
  try {
    if (placeLoadedObject(control, object.loaderId, object.kind, transform)) {
      // The scene redraws with the map, and an edit made while it sits still
      // would not appear until the next pan.
      state.app?.getMap?.()?.triggerRepaint();
    } else {
      removeFromRenderer(object);
      // The loader mints a new id per load; keeping the old one would leave the
      // next remove pointing at something that is no longer there.
      object.loaderId = await control.load(object.readableUrl, {
        longitude: transform.longitude,
        latitude: transform.latitude,
        altitude: transform.altitude,
        rotation: transform.rotation,
        scale: transform.scale,
      });
      await whenObjectRendered(control, object.loaderId);
    }
    object.transform = transform;
    // The zoom button reads the layer's bounds, so a moved object needs its
    // box moved too or the button keeps going where it used to be.
    const store = useAppStore.getState();
    const existing = store.layers.find((entry) => entry.id === object.layerId);
    if (existing) {
      store.updateLayer(object.layerId, {
        source: {
          ...existing.source,
          bounds: placementBounds(transform.longitude, transform.latitude),
        },
      });
    }

    // A reload starts visible and opaque, so a hidden or faded layer would
    // silently come back at full strength on every Apply. Re-applied on the
    // in-place path too: it writes the values the layer already has.
    const layer = useAppStore.getState().layers.find((entry) => entry.id === object.layerId);
    if (layer) {
      state.adapter?.setVisibility(object.loaderId, layer.visible);
      applyObjectOpacity(object, layer.opacity);
    }
  } catch (error) {
    setStatus(loadErrorMessage(error));
  } finally {
    state.busy = false;
    rerenderPanel();
  }
}

async function pickAndLoad(app: GeoLibreAppAPI): Promise<void> {
  if (!localObjectPicker) {
    setStatus(labels.errorPickerUnavailable);
    rerenderPanel();
    return;
  }
  const picked = await localObjectPicker();
  for (const file of picked) {
    // The path, not the display name: it is what a preset needs to find the
    // file again, and it still carries the extension the loader keys on.
    await loadObject(app, file.path ?? file.name, file.name, {
      url: file.url,
      revocable: file.revocable,
    });
  }
}

/**
 * The largest local file this will try to load.
 *
 * A browser cannot allocate an arbitrarily large buffer, and a splat well past
 * this fails partway through parsing — leaving a half-built scene that renders
 * as a broken object rather than an error. Refusing up front says why.
 */
export const MAX_LOCAL_OBJECT_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Rejects a local file the loader cannot be expected to read.
 *
 * @param file - The file's name and size.
 * @throws When the format is unsupported, the file is empty, or it is too big.
 */
export function validateLocalObjectFile(file: Pick<File, "name" | "size">): void {
  if (!objectKind(file.name)) throw new Error(labels.errorUnsupported);
  if (file.size === 0) throw new Error(labels.errorEmptyFile);
  if (file.size > MAX_LOCAL_OBJECT_BYTES) throw new Error(labels.errorTooLarge);
}

/**
 * Loads a file the user dropped on the map.
 *
 * The drop path used to run its own copy of the renderer, so a dropped scan and
 * one added from this panel ended up in two different scenes, each with its own
 * MapLibre layer — and only the panel's had a transform editor, an opacity
 * slider or a way to save it as a sample. One entry point, one scene, and a
 * dropped file gets all of it.
 *
 * The plugin is activated first when it is not already: a drop is a request to
 * see the file, not a request to go and switch a plugin on.
 *
 * @param app - The host API.
 * @param file - The dropped file.
 * @param placement - Where to put it; defaults to the map centre.
 * @returns The layer id.
 * @throws When the file is not a format this plugin loads, or the renderer
 *   could not start.
 */
export async function addDroppedObject(
  app: GeoLibreAppAPI,
  file: File,
  placement?: { longitude: number; latitude: number },
): Promise<string> {
  validateLocalObjectFile(file);
  if (!state.app) await app.activatePlugin?.(GEOIM3D_OBJECTS_PLUGIN_ID);
  const host = state.app ?? app;

  // A blob of the dropped file: it has no path, so there is nothing else to
  // address it by. Revoked with the object, like a browser file pick.
  const url = URL.createObjectURL(file);
  const before = new Set(state.objects.map((entry) => entry.layerId));
  await loadObject(
    host,
    file.name,
    file.name,
    { url, revocable: true },
    placementTransform(placement, objectKind(file.name) ?? "splat"),
  );

  const added = state.objects.find((entry) => !before.has(entry.layerId));
  if (!added) throw new Error(state.status || labels.errorLoadFailed);
  return added.layerId;
}

/**
 * A full transform from a bare coordinate, or undefined to use the map centre.
 *
 * @param placement - The requested longitude/latitude, if any.
 * @param kind - What the file is, which decides the default rotation.
 * @returns The transform to load with.
 */
function placementTransform(
  placement: { longitude: number; latitude: number } | undefined,
  kind: ObjectKind,
): ObjectTransform | undefined {
  if (!placement) return undefined;
  return {
    longitude: placement.longitude,
    latitude: placement.latitude,
    altitude: 0,
    scale: 1,
    // Read from the file, not assumed: splats and glTF models are authored in
    // different axis conventions, so a dropped .glb given a splat's rotation
    // arrives on its side.
    rotation: defaultRotation(kind),
  };
}

/* -------------------------------------------------------------------------- */
/* Presets                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Saves an object's file and placement so it can be re-added later.
 *
 * @param object - The object to remember.
 */
function savePreset(object: LoadedObject): void {
  if (!isDurableSource(object.source)) {
    setStatus(labels.errorPresetNotSavable);
    rerenderPanel();
    return;
  }
  const preset: ObjectPreset = {
    id: `${GEOIM3D_OBJECT_SOURCE_KIND}-preset-${nextObjectSequence++}`,
    name: object.name,
    source: object.source,
    kind: object.kind,
    transform: { ...object.transform, rotation: [...object.transform.rotation] },
    // Saved alongside, so reopening the preset restores the globe's placement
    // too rather than starting from the defaults again.
    tilesetTransform: object.tilesetTransform
      ? { ...object.tilesetTransform, rotation: [...object.tilesetTransform.rotation] }
      : undefined,
  };
  savePresets(upsertPreset(loadUserPresets(), preset));
  if (state.app) buildToolbarMenu(state.app);
  setStatus("");
  rerenderPanel();
}

/**
 * Deletes a saved preset.
 *
 * @param id - The preset's id.
 */
function deletePreset(id: string): void {
  savePresets(loadUserPresets().filter((entry) => entry.id !== id));
  if (state.app) buildToolbarMenu(state.app);
  rerenderPanel();
}

/**
 * Loads a preset back onto the map at the placement it was saved with.
 *
 * @param app - The host API.
 * @param preset - The preset to load.
 */
async function loadPreset(app: GeoLibreAppAPI, preset: ObjectPreset): Promise<void> {
  // The globe cannot draw a splat, but it can draw this site's tileset — so a
  // preset that has one is opened in either view: the tileset draws on the
  // globe, the splat on the 2D map, and both are listed either way so switching
  // views does not need the preset opened again.
  const hasTileset = TILESET_COMPANION_ENABLED && ensureTilesetLayer(preset);

  // A recorded path is a file, not a URL: it has to be reauthorized and turned
  // into something the webview can read before the loader sees it.
  let prepared: { url: string; revocable: boolean } | undefined;
  if (!/^https?:\/\//i.test(preset.source)) {
    if (!localObjectResolver) {
      setStatus(labels.errorPresetUnavailable);
      rerenderPanel();
      return;
    }
    const picked = await localObjectResolver(preset.source);
    if (!picked) {
      setStatus(labels.errorPresetMissing);
      rerenderPanel();
      return;
    }
    prepared = { url: picked.url, revocable: picked.revocable };
  }
  await loadObject(
    app,
    preset.source,
    preset.name,
    prepared,
    preset.transform,
    hasTileset ? `${preset.id}-tileset` : undefined,
    hasTileset ? initialTilesetTransform(preset) : undefined,
  );
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                        */
/* -------------------------------------------------------------------------- */

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sectionTitle(text: string): HTMLElement {
  return element("h3", "geolibre-plugin-panel__section-title", text);
}

/**
 * A labelled number box for one transform field.
 *
 * @param labelText - The field's label.
 * @param value - Its current value.
 * @param step - The input's step, which also sets how fine the spinner is.
 * @returns The row and its input.
 */
function numberField(
  labelText: string,
  value: number,
  step: number,
): { row: HTMLElement; input: HTMLInputElement } {
  const row = element("label", "geoim3d-object__field");
  row.appendChild(element("span", "geoim3d-object__field-label", labelText));
  const input = element("input", "geolibre-plugin-panel__input");
  input.type = "number";
  input.step = String(step);
  input.value = String(value);
  row.appendChild(input);
  return { row, input };
}

/**
 * One loaded object: what it is, where it sits, and the controls to change it.
 *
 * @param object - The object to render.
 * @returns The block.
 */
function objectBlock(object: LoadedObject): HTMLElement {
  const wrapper = element("div", "geoim3d-object");
  wrapper.appendChild(element("p", "geoim3d-object__name", object.name));

  // The same fields drive two assets, so say which one they are pointed at:
  // the numbers change under the user when the view does, and without this the
  // panel looks like it forgot what was typed.
  const editingTileset = isEditingTileset(object);
  if (editingTileset) {
    wrapper.appendChild(element("span", "geoim3d-object__badge", labels.tilesetBadge));
    wrapper.appendChild(element("p", "geoim3d-object__hint", labels.tilesetHint));
  }

  const transform =
    editingTileset && object.tilesetTransform ? object.tilesetTransform : object.transform;
  const lon = numberField(labels.longitude, transform.longitude, 0.0001);
  const lat = numberField(labels.latitude, transform.latitude, 0.0001);
  const alt = numberField(labels.altitude, transform.altitude, 1);
  const scale = numberField(labels.scale, transform.scale, 0.1);
  for (const field of [lon, lat, alt, scale]) wrapper.appendChild(field.row);

  // Opacity is deliberately absent: the layer panel's slider owns it, and the
  // store watcher passes a change straight to the renderer. A second control
  // for one value is two places to disagree.

  wrapper.appendChild(element("span", "geoim3d-object__field-label", labels.rotation));
  const rotationRow = element("div", "geoim3d-object__rotation");
  const rotationInputs = (["x", "y", "z"] as const).map((axis, index) => {
    const input = element("input", "geolibre-plugin-panel__input");
    input.type = "number";
    input.step = "1";
    input.value = String(transform.rotation[index]);
    input.setAttribute("aria-label", `${labels.rotation} ${axis.toUpperCase()}`);
    rotationRow.appendChild(input);
    return input;
  });
  wrapper.appendChild(rotationRow);

  const actions = element("div", "geoim3d-object__actions");
  const apply = element("button", "geolibre-plugin-panel__button", labels.apply);
  apply.type = "button";
  apply.disabled = state.busy;
  // Applied on the button, not on input: a reload re-parses the whole file, so
  // reacting to every keystroke would stall the map on a large object.
  apply.addEventListener("click", () => {
    void applyTransform(object, {
      longitude: Number(lon.input.value),
      latitude: Number(lat.input.value),
      altitude: Number(alt.input.value),
      scale: Number(scale.input.value),
      rotation: rotationInputs.map((input) => Number(input.value)) as [number, number, number],
    });
  });
  actions.appendChild(apply);

  const remove = element("button", "geolibre-plugin-panel__button", labels.remove);
  remove.type = "button";
  remove.addEventListener("click", () => removeObject(object));
  actions.appendChild(remove);
  wrapper.appendChild(actions);

  const save = element(
    "button",
    "geolibre-plugin-panel__button geolibre-plugin-panel__button--wide",
    labels.savePreset,
  );
  save.type = "button";
  // A browser pick has only a blob: URL, which dies with the page, so there is
  // nothing durable to save. Disabled rather than hidden so the reason can be
  // read from the tooltip instead of the option simply not being there.
  save.disabled = !isDurableSource(object.source);
  if (save.disabled) save.title = labels.errorPresetNotSavable;
  save.addEventListener("click", () => savePreset(object));
  wrapper.appendChild(save);

  return wrapper;
}

function renderPanel(container: HTMLElement): void {
  const app = state.app;
  if (!app) return;
  container.textContent = "";
  container.className = "geolibre-plugin-panel";

  // A tileset streams after its layer is listed, so the panel keeps showing
  // progress once the object itself has finished loading.
  const streaming = state.objects
    .map((object) =>
      object.tilesetLayerId
        ? (tilesetLoadingSource?.progressOf(object.tilesetLayerId) ?? null)
        : null,
    )
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (!state.busy && streaming.length > 0) {
    const outstanding = streaming.reduce((sum, one) => sum + one.pending + one.processing, 0);
    const progress = element("div", "geoim3d-progress");
    progress.setAttribute("role", "status");
    progress.appendChild(
      element("p", "geoim3d-progress__label", `${labels.tilesetLoading} (${outstanding})`),
    );
    const track = element("div", "geoim3d-progress__track");
    track.appendChild(element("div", "geoim3d-progress__bar"));
    progress.appendChild(track);
    container.appendChild(progress);
  }

  if (state.busy) {
    // Indeterminate on purpose. The renderer does the fetching and reports no
    // byte count, and reading the file here first to measure it would hold a
    // second copy of a splat that is routinely tens of megabytes. What the
    // user needs is "this is working and here is what on", not a percentage.
    const progress = element("div", "geoim3d-progress");
    progress.setAttribute("role", "status");
    progress.appendChild(
      element("p", "geoim3d-progress__label", `${labels.loading} ${state.busyName}`.trim()),
    );
    const track = element("div", "geoim3d-progress__track");
    track.appendChild(element("div", "geoim3d-progress__bar"));
    progress.appendChild(track);
    container.appendChild(progress);
  }

  // Add from a URL.
  container.appendChild(sectionTitle(labels.addFromUrl));
  const form = element("form", "geolibre-plugin-panel__form");
  const urlInput = element("input", "geolibre-plugin-panel__input");
  urlInput.type = "text";
  urlInput.placeholder = labels.urlPlaceholder;
  urlInput.value = state.urlDraft;
  urlInput.addEventListener("input", () => {
    state.urlDraft = urlInput.value;
  });
  form.appendChild(urlInput);
  const submit = element(
    "button",
    "geolibre-plugin-panel__button",
    state.busy ? labels.loading : labels.load,
  );
  submit.type = "submit";
  submit.disabled = state.busy;
  form.appendChild(submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const source = state.urlDraft.trim();
    if (!source) return;
    if (isTilesetSource(source)) loadTileset(app, source, objectName(source));
    else void loadObject(app, source, objectName(source));
  });
  container.appendChild(form);

  // Add from a file.
  const browse = element(
    "button",
    "geolibre-plugin-panel__button geolibre-plugin-panel__button--wide",
    labels.browse,
  );
  browse.type = "button";
  browse.disabled = state.busy || !localObjectPicker;
  browse.addEventListener("click", () => void pickAndLoad(app));
  container.appendChild(browse);

  if (state.status) {
    container.appendChild(element("p", "geolibre-plugin-panel__notice", state.status));
  }

  // What is on the map.
  container.appendChild(sectionTitle(labels.loaded));
  if (state.objects.length === 0) {
    container.appendChild(element("p", "geolibre-plugin-panel__status", labels.empty));
    return;
  }
  const shown = panelObject();
  if (shown) container.appendChild(objectBlock(shown));

  buildingToggle(container);
  presetSection(app, container);
}

/**
 * The switch for the basemap's own 3D buildings.
 *
 * Lives here rather than in a map menu because this is where it is needed: at
 * street level the style's buildings stand in front of a scan and hide it.
 *
 * @param container - The panel body.
 */
function buildingToggle(container: HTMLElement): void {
  const row = element("label", "geoim3d-object__field geoim3d-object__toggle");
  const input = element("input", "");
  input.type = "checkbox";
  input.checked = state.hideBasemapBuildings;
  input.addEventListener("change", () => {
    state.hideBasemapBuildings = input.checked;
    applyBasemapBuildingVisibility();
  });
  row.appendChild(input);
  row.appendChild(element("span", "geoim3d-object__field-label", labels.hideBasemapBuildings));
  container.appendChild(row);
}

/**
 * Lists the saved samples, with a way to load or forget each one.
 *
 * The toolbar menu lists them too, for loading in one click; deleting lives
 * here because a menu is a poor place to destroy something.
 *
 * @param app - The host API.
 * @param container - The panel body.
 */
function presetSection(app: GeoLibreAppAPI, container: HTMLElement): void {
  container.appendChild(sectionTitle(labels.presets));
  const presets = allPresets();
  if (presets.length === 0) {
    container.appendChild(element("p", "geolibre-plugin-panel__status", labels.presetsEmpty));
    return;
  }
  for (const preset of presets) {
    const row = element("div", "geoim3d-object__actions");
    const load = element("button", "geolibre-plugin-panel__button", preset.name);
    load.type = "button";
    load.disabled = state.busy;
    load.addEventListener("click", () => void loadPreset(app, preset));
    row.appendChild(load);
    // A shipped sample lives in the build, not in this browser's storage, so
    // there is nothing here to delete.
    if (!isBundledPreset(preset)) {
      const drop = element("button", "geolibre-plugin-panel__button", labels.deletePreset);
      drop.type = "button";
      drop.addEventListener("click", () => deletePreset(preset.id));
      row.appendChild(drop);
    }
    container.appendChild(row);
  }
}

/**
 * Mounts the panel body into whichever shell asked for it — docked or floating.
 *
 * @param container - The host-provided element.
 * @returns The cleanup the host runs when that shell closes.
 */
function mountPanel(container: HTMLElement): () => void {
  state.container = container;
  renderPanel(container);
  return () => {
    if (state.container === container) state.container = null;
  };
}

/**
 * Shows the panel docked in the right sidebar, closing the detached card.
 *
 * @param app - The host API.
 */
function showDockedPanel(app: GeoLibreAppAPI): void {
  app.closeFloatingPanel?.(FLOATING_PANEL_ID);
  app.openRightPanel?.(PANEL_ID);
}

/**
 * Shows the panel as a floating card, closing the docked one.
 *
 * @param app - The host API.
 */
function showFloatingPanel(app: GeoLibreAppAPI): void {
  app.closeRightPanel?.(PANEL_ID);
  app.openFloatingPanel?.(FLOATING_PANEL_ID);
}

/* -------------------------------------------------------------------------- */
/* Menu                                                                         */
/* -------------------------------------------------------------------------- */

let unregisterMenu: (() => void) | null = null;

function buildToolbarMenu(app: GeoLibreAppAPI): void {
  unregisterMenu?.();
  unregisterMenu = null;
  const onGlobe = Boolean(primaryViewBridge?.isGlobeActive());
  // A splat is drawn by a MapLibre control, so nothing loaded as one can be seen
  // while the globe is up. A preset that also ships a tileset can: that is the
  // one form the globe renders. So the menu stays, carrying only what works
  // there, rather than being withdrawn and taking the tilesets with it.
  const presets = allPresets().filter((preset) => !onGlobe || preset.tileset);
  if (onGlobe && presets.length === 0) return;
  const uploadItems: GeoLibreToolbarMenuItem[] = onGlobe
    ? []
    : [
        {
          id: `${MENU_ID}-url`,
          label: labels.addFromUrl,
          onSelect: () => showDockedPanel(app),
        },
        {
          id: `${MENU_ID}-file`,
          label: labels.addFromFile,
          disabled: !localObjectPicker,
          onSelect: () => {
            showDockedPanel(app);
            void pickAndLoad(app);
          },
        },
      ];
  unregisterMenu =
    app.registerToolbarMenu?.({
      id: MENU_ID,
      label: labels.menuLabel,
      items: [
        ...uploadItems,
        {
          type: "submenu",
          id: `${MENU_ID}-presets`,
          label: labels.presets,
          // An empty submenu opens onto nothing, so say so instead.
          items:
            presets.length > 0
              ? presets.map((preset) => ({
                  id: `${MENU_ID}-preset-${preset.id}`,
                  label: preset.name,
                  onSelect: () => {
                    // Opened first so a failure has somewhere to be read, and
                    // so the progress line is visible while a large file
                    // loads. A menu click that shows nothing at all is the
                    // same shape as a broken one.
                    showDockedPanel(app);
                    void loadPreset(app, preset);
                  },
                }))
              : [
                  {
                    id: `${MENU_ID}-preset-empty`,
                    label: labels.presetsEmpty,
                    disabled: true,
                    onSelect: () => {},
                  },
                ],
        },
        { type: "separator" },
        {
          // A tileset is georeferenced, so the transform editor above does not
          // apply to it; the existing 3D Tiles panel owns that flow.
          id: `${MENU_ID}-3d-tiles`,
          label: labels.threeDTiles,
          onSelect: () => openThreeDTilesLayerPanel(app),
        },
        { type: "separator" },
        {
          id: `${MENU_ID}-panel`,
          label: labels.openPanel,
          onSelect: () => showDockedPanel(app),
        },
        {
          id: `${MENU_ID}-panel-floating`,
          label: labels.openPanelFloating,
          onSelect: () => showFloatingPanel(app),
        },
      ],
    }) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                       */
/* -------------------------------------------------------------------------- */

export const geoim3dObjectsPlugin: GeoLibrePlugin = {
  id: GEOIM3D_OBJECTS_PLUGIN_ID,
  name: "3D objects",
  version: "0.1.0",
  // Tilesets render on both engines; only splats are MapLibre-only,
  // which PrimaryViewBridge above already accounts for.
  engines: ["maplibre", "cesium"],

  activate(app: GeoLibreAppAPI) {
    state.app = app;
    buildToolbarMenu(app);
    void loadBundledPresets(app);
    const map = app.getMap?.() as
      | { on: (e: string, h: () => void) => void; off: (e: string, h: () => void) => void }
      | null
      | undefined;
    if (map) {
      const onStyle = () => applyBasemapBuildingVisibility();
      map.on("styledata", onStyle);
      detachStyleWatch = () => map.off("styledata", onStyle);
    }
    app.registerRightPanel?.({
      id: PANEL_ID,
      title: () => labels.getTitle?.() ?? labels.title,
      defaultWidth: 340,
      render: mountPanel,
    });
    app.registerFloatingPanel?.({
      id: FLOATING_PANEL_ID,
      title: () => labels.getTitle?.() ?? labels.title,
      defaultWidth: 340,
      render: mountPanel,
    });
  },

  deactivate(app: GeoLibreAppAPI) {
    unsubscribePrimaryView?.();
    unsubscribePrimaryView = null;
    unregisterMenu?.();
    unregisterMenu = null;
    app.closeRightPanel?.(PANEL_ID);
    app.unregisterRightPanel?.(PANEL_ID);
    app.closeFloatingPanel?.(FLOATING_PANEL_ID);
    app.unregisterFloatingPanel?.(FLOATING_PANEL_ID);

    // Every object goes with the plugin, and every blob made for one is
    // released — they are the largest thing this plugin holds.
    detachStyleWatch?.();
    detachStyleWatch = null;
    // Leave the map as it was found; a hidden basemap layer must not outlive
    // the panel that hid it.
    state.hideBasemapBuildings = false;
    applyBasemapBuildingVisibility();
    unsubscribeTilesetLoading?.();
    unsubscribeTilesetLoading = null;
    unsubscribeStore?.();
    unsubscribeStore = null;
    const store = useAppStore.getState();
    for (const object of state.objects) {
      removeFromRenderer(object);
      if (object.revocable) URL.revokeObjectURL(object.readableUrl);
      store.removeLayer(object.layerId);
    }
    state.objects = [];
    releaseMercatorProjectionLock(PROJECTION_LOCK_KEY, app);
    detachPitchSync?.();
    detachPitchSync = null;
    state.adapter?.destroy();
    state.adapter = null;
    if (state.control) {
      app.removeMapControl(state.control as never);
      state.control = null;
    }
    state.container = null;
    state.app = null;
    state.urlDraft = "";
    state.status = "";
  },
};
